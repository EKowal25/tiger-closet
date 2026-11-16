// Reviews (people rate each other after a borrow, swap or trade), public profiles, and problem reports to the admins.
const db = require('./db');
const mail = require('./mail');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const REPORT_NOTIFY_EMAIL = process.env.REPORT_NOTIFY_EMAIL || '';
const isAdmin = (user) => !!(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));

const REASONS = {
  not_returned: 'Dress was not returned',
  returned_late: 'Dress was returned late',
  returned_damaged: 'Dress was returned damaged or dirty',
  poor_condition: 'Dress was in worse condition than described',
  not_as_described: 'Dress was not as described (wrong size, different dress, etc.)',
  no_show: 'They never showed up or stopped responding',
  payment: 'Deposit or payment problem',
  other: 'Something else',
};

async function ratingFor(userId) {
  const r = await db.one('SELECT round(avg(rating)::numeric, 1) AS avg, count(*)::int AS n FROM reviews WHERE reviewee_id = $1', [userId]);
  return { avg: r && r.n ? Number(r.avg) : null, n: r ? r.n : 0 };
}

// Loads the borrow request or trade and works out who the two people are.
async function loadDeal(kind, id, userId) {
  if (kind === 'request') {
    const r = await db.one(`SELECT r.id, r.status, r.borrower_id, d.owner_id, d.title FROM requests r JOIN dresses d ON d.id = r.dress_id WHERE r.id = $1`, [id]);
    if (!r || (r.owner_id !== userId && r.borrower_id !== userId)) return null;
    const iAmOwner = r.owner_id === userId;
    return { kind, id: r.id, title: r.title, status: r.status, iAmOwner, otherId: iAmOwner ? r.borrower_id : r.owner_id,
      canReview: ['accepted', 'returned'].includes(r.status), canReport: ['accepted', 'returned'].includes(r.status), deal: 'borrow' };
  }
  if (kind === 'trade') {
    const t = await db.one(`SELECT t.id, t.status, t.owner_id, t.offerer_id, d.title FROM trades t JOIN dresses d ON d.id = t.dress_id WHERE t.id = $1`, [id]);
    if (!t || (t.owner_id !== userId && t.offerer_id !== userId)) return null;
    const iAmOwner = t.owner_id === userId;
    return { kind, id: t.id, title: t.title, status: t.status, iAmOwner, otherId: iAmOwner ? t.offerer_id : t.owner_id,
      canReview: t.status === 'completed', canReport: ['accepted', 'completed'].includes(t.status), deal: 'trade' };
  }
  return null;
}

function mount(app, { requireAuth, checkCsrf, flash, clean, toInt, notify, attachPhotos, BASE_URL }) {
  const col = (kind) => (kind === 'request' ? 'request_id' : 'trade_id');
  const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });

  // ----- public profile -----
  app.get('/users/:id', requireAuth, async (req, res) => {
    const person = await db.one('SELECT id, name, class_year, college, created_at FROM users WHERE id = $1', [toInt(req.params.id)]);
    if (!person) return notFound(res);
    const reviews = await db.all(`SELECT v.rating, v.comment, v.created_at, v.role, u.name AS reviewer_name
                                  FROM reviews v JOIN users u ON u.id = v.reviewer_id WHERE v.reviewee_id = $1 ORDER BY v.created_at DESC LIMIT 100`, [person.id]);
    const listings = await attachPhotos(await db.all('SELECT * FROM dresses WHERE owner_id = $1 AND active ORDER BY created_at DESC', [person.id]));
    res.render('user', { title: person.name || 'Profile', person, reviews, listings, rating: await ratingFor(person.id), isMe: person.id === req.user.id });
  });

  // ----- reviews -----
  app.get('/review/:kind/:id', requireAuth, async (req, res) => {
    const deal = await loadDeal(req.params.kind, toInt(req.params.id), req.user.id);
    if (!deal || !deal.canReview) return notFound(res);
    const other = await db.one('SELECT id, name FROM users WHERE id = $1', [deal.otherId]);
    const existing = await db.one(`SELECT rating, comment FROM reviews WHERE ${col(deal.kind)} = $1 AND reviewer_id = $2`, [deal.id, req.user.id]);
    res.render('review-form', { title: 'Leave a review', deal, other, existing });
  });

  app.post('/review/:kind/:id', requireAuth, checkCsrf, async (req, res) => {
    const deal = await loadDeal(req.params.kind, toInt(req.params.id), req.user.id);
    if (!deal || !deal.canReview) return res.sendStatus(404);
    const rating = toInt(req.body.rating);
    if (!(rating >= 1 && rating <= 5)) { flash(req, 'Pick a rating from 1 to 5 stars.', 'err'); return res.redirect(`/review/${deal.kind}/${deal.id}`); }
    // role = what the person being reviewed was in this deal
    const role = deal.deal === 'trade' ? 'trader' : deal.iAmOwner ? 'borrower' : 'lender';
    await db.all(`INSERT INTO reviews (${col(deal.kind)}, reviewer_id, reviewee_id, rating, comment, role) VALUES ($1, $2, $3, $4, $5, $6)
                  ON CONFLICT (${col(deal.kind)}, reviewer_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()`,
      [deal.id, req.user.id, deal.otherId, rating, clean(req.body.comment, 1000), role]);
    await notify(deal.otherId, { subject: `${req.user.name || 'Someone'} left you a review`, lines: [`${req.user.name || 'Someone'} rated you ${rating} out of 5 for ${deal.title}.`], link: `/users/${deal.otherId}`, button: 'See your reviews' });
    flash(req, 'Thanks! Your review is posted.');
    res.redirect(`/users/${deal.otherId}`);
  });

  // ----- reports (private, go to the admins) -----
  app.get('/report/:kind/:id', requireAuth, async (req, res) => {
    const deal = await loadDeal(req.params.kind, toInt(req.params.id), req.user.id);
    if (!deal || !deal.canReport) return notFound(res);
    const other = await db.one('SELECT id, name FROM users WHERE id = $1', [deal.otherId]);
    res.render('report-form', { title: 'Report a problem', deal, other, REASONS });
  });

  app.post('/report/:kind/:id', requireAuth, checkCsrf, async (req, res) => {
    const deal = await loadDeal(req.params.kind, toInt(req.params.id), req.user.id);
    if (!deal || !deal.canReport) return res.sendStatus(404);
    const reason = REASONS[req.body.reason] ? req.body.reason : null;
    const details = clean(req.body.details, 2000);
    if (!reason || !details) { flash(req, 'Pick a reason and tell us what happened.', 'err'); return res.redirect(`/report/${deal.kind}/${deal.id}`); }
    await db.all(`INSERT INTO reports (${col(deal.kind)}, reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4, $5)`,
      [deal.id, req.user.id, deal.otherId, reason, details]);
    if (mail.enabled && REPORT_NOTIFY_EMAIL) {
      const other = await db.one('SELECT name, email FROM users WHERE id = $1', [deal.otherId]);
      await Promise.race([
        mail.send({
          to: REPORT_NOTIFY_EMAIL, subject: `Tiger Closet report: ${REASONS[reason]}`,
          text: `${req.user.name} (${req.user.email}) reported ${other.name} (${other.email}).\n\nDress: ${deal.title}\nReason: ${REASONS[reason]}\n\n${details}\n\nReview it: ${BASE_URL}/admin/reports`,
          html: `<p><b>${esc(req.user.name)}</b> (${esc(req.user.email)}) reported <b>${esc(other.name)}</b> (${esc(other.email)}).</p><p>Dress: ${esc(deal.title)}<br>Reason: ${esc(REASONS[reason])}</p><p>${esc(details)}</p><p><a href="${BASE_URL}/admin/reports">Open reports</a></p>`,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('email timeout')), 5000)),
      ]).catch((e) => console.error('report email failed:', e.message));
    }
    flash(req, 'Thanks. Your report was sent to the Tiger Closet team. It is private: the other person is not notified.');
    res.redirect('/closet');
  });

  // ----- admin -----
  app.get('/admin/reports', requireAuth, async (req, res) => {
    if (!isAdmin(req.user)) return notFound(res);
    const reports = await db.all(`
      SELECT p.*, a.name AS reporter_name, a.email AS reporter_email, b.name AS reported_name, b.email AS reported_email,
             COALESCE(rd.title, td.title) AS dress_title,
             (SELECT count(*)::int FROM reports x WHERE x.reported_id = p.reported_id) AS total_against
      FROM reports p JOIN users a ON a.id = p.reporter_id JOIN users b ON b.id = p.reported_id
      LEFT JOIN requests rq ON rq.id = p.request_id LEFT JOIN dresses rd ON rd.id = rq.dress_id
      LEFT JOIN trades tr ON tr.id = p.trade_id LEFT JOIN dresses td ON td.id = tr.dress_id
      ORDER BY (p.status = 'open') DESC, p.created_at DESC LIMIT 300`);
    res.render('admin-reports', { title: 'Reports', reports, REASONS });
  });

  app.post('/admin/reports/:id/:action', requireAuth, checkCsrf, async (req, res) => {
    if (!isAdmin(req.user)) return res.sendStatus(404);
    const status = { resolve: 'resolved', reopen: 'open' }[req.params.action];
    if (!status) return res.sendStatus(400);
    await db.all('UPDATE reports SET status = $1 WHERE id = $2', [status, toInt(req.params.id)]);
    res.redirect('/admin/reports');
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { mount, ratingFor, isAdmin, REASONS };
