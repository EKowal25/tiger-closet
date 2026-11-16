require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const db = require('./db');
const storage = require('./storage');
const mail = require('./mail');
const mountAuth = require('./auth');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'princeton.edu').toLowerCase();

if (IS_PROD && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}

const SIZES = ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', '18+', 'XS', 'S', 'M', 'L', 'XL'];
const LENGTHS = ['Mini', 'Knee', 'Midi', 'Tea', 'Floor-length'];
const COLLEGES = ['Butler', 'Forbes', 'Mathey', 'New College West', 'Rockefeller', 'Whitman', 'Yeh', 'Upperclass / Independent', 'Grad'];
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'tc_session',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  maxAge: 14 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
}));

// ---------- helpers ----------
app.use(async (req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  req.user = req.session.userId ? await db.one('SELECT * FROM users WHERE id = $1', [req.session.userId]) : null;
  if (req.user && req.user.session_version !== (req.session.sv || 0)) { req.user = null; req.session.userId = null; }
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.path = req.path;
  res.locals.photoUrl = (p) => `/photos/${p.key}`;
  next();
});

function flash(req, msg, type = 'ok') { req.session.flash = { msg, type }; }

// Background (fetch) form submissions get the destination as JSON instead of a redirect.
function go(req, res, url) {
  if (req.get('X-Requested-With') === 'fetch') return res.json({ redirect: url });
  res.redirect(url);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (mail.enabled && !req.user.email_verified) return res.redirect('/verify');
  if (!req.user.name && !req.path.startsWith('/profile')) return res.redirect('/profile?welcome=1');
  next();
}

function checkCsrf(req, res, next) {
  const token = req.body && req.body._csrf;
  if (typeof token !== 'string' || token.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Please go back, refresh the page, and try again.' });
  }
  next();
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/browse';
}

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

async function attachPhotos(dresses) {
  if (!dresses.length) return dresses;
  const photos = await db.all('SELECT * FROM photos WHERE dress_id = ANY($1) ORDER BY position', [dresses.map((d) => d.id)]);
  for (const d of dresses) d.photos = photos.filter((p) => p.dress_id === d.id);
  return dresses;
}

// ---------- uploads ----------
// Photos are resized in the browser before upload, so they fit within Vercel's 4.5 MB request limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => cb(null, !!IMAGE_TYPES[file.mimetype]),
});

// Photos are only visible to logged-in Princeton users.
app.get('/photos/:key', async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  if (!/^[a-f0-9]{32}\.(jpg|png|webp|heic)$/.test(req.params.key)) return res.sendStatus(404);
  if (!(await storage.send(req.params.key, res))) res.sendStatus(404);
});

// ---------- auth ----------
mountAuth(app, { checkCsrf, flash, safeNext, clean, BASE_URL, ALLOWED_DOMAIN });

app.post('/logout', checkCsrf, (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- health check ----------
app.get('/healthz', async (req, res) => {
  try {
    await db.one('SELECT 1 FROM users LIMIT 1');
    res.json({ ok: true, db: 'ok', photos: storage.useBlob ? 'blob' : 'local' });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false, db: 'error' });
  }
});

// ---------- pages ----------
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/browse');
  res.render('home', { title: 'Tiger Closet' });
});

app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'Your profile', welcome: !!req.query.welcome, colleges: COLLEGES });
});

app.post('/profile', requireAuth, checkCsrf, async (req, res) => {
  const name = clean(req.body.name, 80);
  if (!name) { flash(req, 'Please add your name.', 'err'); return res.redirect('/profile'); }
  await db.all('UPDATE users SET name = $1, class_year = $2, college = $3, phone = $4 WHERE id = $5',
    [name, clean(req.body.class_year, 4), clean(req.body.college, 40), clean(req.body.phone, 30), req.user.id]);
  flash(req, 'Profile saved.');
  res.redirect('/browse');
});

app.get('/browse', requireAuth, async (req, res) => {
  const filters = { q: clean(req.query.q, 100), size: clean(req.query.size, 10), length: clean(req.query.length, 20), terms: clean(req.query.terms, 10) };
  const where = ['d.active'];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (filters.q) { const p = add(`%${filters.q}%`); where.push(`(d.title ILIKE ${p} OR d.designer ILIKE ${p} OR d.color ILIKE ${p} OR d.description ILIKE ${p})`); }
  if (filters.size) where.push(`d.size = ${add(filters.size)}`);
  if (filters.length) where.push(`d.length = ${add(filters.length)}`);
  if (filters.terms === 'deposit') where.push('d.allow_deposit');
  if (filters.terms === 'dryclean') where.push('d.allow_dryclean');
  if (filters.terms === 'free') where.push('d.allow_free');
  if (filters.terms === 'fee') where.push('d.allow_fee');
  if (filters.terms === 'swap') where.push('d.allow_swap');
  if (filters.terms === 'trade') where.push('d.open_to_trade');
  const dresses = await attachPhotos(await db.all(`
    SELECT d.*, u.name AS owner_name FROM dresses d JOIN users u ON u.id = d.owner_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`, params));
  res.render('browse', { title: 'Browse dresses', dresses, filters, SIZES, LENGTHS });
});

// Reads the listing fields shared by "post" and "edit".
function readListing(b) {
  const f = {
    title: clean(b.title, 100),
    designer: clean(b.designer, 60),
    size: SIZES.includes(b.size) ? b.size : null,
    color: clean(b.color, 40),
    length: LENGTHS.includes(b.length) ? b.length : null,
    description: clean(b.description, 2000),
    allow_deposit: !!b.allow_deposit,
    allow_dryclean: !!b.allow_dryclean,
    allow_free: !!b.allow_free,
    allow_fee: !!b.allow_fee,
    allow_swap: !!b.allow_swap,
    open_to_trade: !!b.open_to_trade,
  };
  f.min_deposit = f.allow_deposit ? Math.max(0, Math.min(2000, toInt(b.min_deposit) || 0)) : 0;
  f.rental_fee = f.allow_fee ? Math.max(0, Math.min(2000, toInt(b.rental_fee) || 0)) : 0;
  const errors = [];
  if (!f.title) errors.push('Give your dress a title.');
  if (!f.size) errors.push('Pick a size.');
  if (!f.allow_deposit && !f.allow_dryclean && !f.allow_swap && !f.allow_free && !f.allow_fee && !f.open_to_trade) {
    errors.push('Choose at least one way people can borrow or trade for it.');
  }
  return { f, errors };
}

app.get('/dresses/new', requireAuth, (req, res) => {
  res.render('dress-form', { title: 'Post a dress', SIZES, LENGTHS, dress: null });
});

app.get('/dresses/:id/edit', requireAuth, async (req, res) => {
  const dress = await db.one('SELECT * FROM dresses WHERE id = $1 AND owner_id = $2', [toInt(req.params.id), req.user.id]);
  if (!dress) return res.status(404).render('error', { title: 'Not found', message: 'That listing does not exist.' });
  res.render('dress-form', { title: 'Edit listing', SIZES, LENGTHS, dress });
});

app.post('/dresses/:id/edit', requireAuth, checkCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  const { f, errors } = readListing(req.body);
  if (errors.length) { flash(req, errors.join(' '), 'err'); return res.redirect(`/dresses/${id}/edit`); }
  const d = await db.one(`
    UPDATE dresses SET title = $1, designer = $2, size = $3, color = $4, length = $5, description = $6,
      allow_deposit = $7, min_deposit = $8, allow_dryclean = $9, allow_swap = $10, open_to_trade = $11,
      allow_free = $12, allow_fee = $13, rental_fee = $14
    WHERE id = $15 AND owner_id = $16 RETURNING id`,
    [f.title, f.designer, f.size, f.color, f.length, f.description, f.allow_deposit, f.min_deposit,
     f.allow_dryclean, f.allow_swap, f.open_to_trade, f.allow_free, f.allow_fee, f.rental_fee, id, req.user.id]);
  if (!d) return res.sendStatus(404);
  if (!f.open_to_trade) {
    await db.all(`UPDATE trades SET status = 'declined', updated_at = now() WHERE dress_id = $1 AND status = 'pending'`, [id]);
  }
  flash(req, 'Listing updated.');
  res.redirect(`/dresses/${id}`);
});

app.post('/dresses', requireAuth, upload.array('photos', 6), checkCsrf, async (req, res) => {
  const { f, errors } = readListing(req.body);
  if (!req.files || req.files.length === 0) errors.push('Add at least one photo (JPG, PNG, WEBP or HEIC).');
  if (errors.length) {
    flash(req, errors.join(' '), 'err');
    return go(req, res, '/dresses/new');
  }

  const keys = req.files.map((f) => crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[f.mimetype]);
  await Promise.all(req.files.map((f, i) => storage.save(keys[i], f.buffer, f.mimetype)));
  try {
    const d = await db.one(`
      INSERT INTO dresses (owner_id, title, designer, size, color, length, description,
                           allow_deposit, min_deposit, allow_dryclean, allow_swap, open_to_trade,
                           allow_free, allow_fee, rental_fee)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`, [
      req.user.id, f.title, f.designer, f.size, f.color, f.length, f.description,
      f.allow_deposit, f.min_deposit, f.allow_dryclean, f.allow_swap, f.open_to_trade,
      f.allow_free, f.allow_fee, f.rental_fee]);
    await db.all(`INSERT INTO photos (dress_id, key, position) SELECT $1, k, i - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(k, i)`, [d.id, keys]);
    flash(req, 'Your dress is posted!');
    go(req, res, `/dresses/${d.id}`);
  } catch (e) {
    await storage.remove(keys);
    throw e;
  }
});

app.get('/dresses/:id', requireAuth, async (req, res) => {
  const id = toInt(req.params.id);
  const dress = id && await db.one(`
    SELECT d.*, u.name AS owner_name, u.class_year AS owner_year, u.college AS owner_college
    FROM dresses d JOIN users u ON u.id = d.owner_id WHERE d.id = $1`, [id]);
  if (!dress || (!dress.active && dress.owner_id !== req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'That dress is no longer listed.' });
  }
  await attachPhotos([dress]);
  const isOwner = dress.owner_id === req.user.id;
  const myDresses = await db.all('SELECT id, title FROM dresses WHERE owner_id = $1 AND active AND id != $2', [req.user.id, dress.id]);
  const myRequest = await db.one(`SELECT * FROM requests WHERE dress_id = $1 AND borrower_id = $2 AND status IN ('pending','accepted') ORDER BY id DESC LIMIT 1`, [dress.id, req.user.id]);
  const myTrade = await db.one(`SELECT * FROM trades WHERE dress_id = $1 AND offerer_id = $2 AND status IN ('pending','accepted') ORDER BY id DESC LIMIT 1`, [dress.id, req.user.id]);
  const tradeOffers = isOwner ? (await db.one(`SELECT count(*)::int AS n FROM trades WHERE dress_id = $1 AND status = 'pending'`, [dress.id])).n : 0;
  res.render('dress', { title: dress.title, dress, isOwner, myDresses, myRequest, myTrade, tradeOffers, offer: req.query.offer || '' });
});

app.post('/dresses/:id/delete', requireAuth, checkCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  const dress = id && await db.one('SELECT id FROM dresses WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
  if (!dress) return res.sendStatus(404);
  const photos = await db.all('SELECT key FROM photos WHERE dress_id = $1', [dress.id]);
  await db.all(`UPDATE trades SET status = 'cancelled', updated_at = now()
                WHERE status IN ('pending','accepted') AND id IN (SELECT trade_id FROM trade_items WHERE dress_id = $1)`, [dress.id]);
  await db.all('DELETE FROM dresses WHERE id = $1', [dress.id]);
  await storage.remove(photos.map((p) => p.key));
  flash(req, 'Listing removed.');
  res.redirect('/closet');
});

app.post('/dresses/:id/toggle', requireAuth, checkCsrf, async (req, res) => {
  await db.all('UPDATE dresses SET active = NOT active WHERE id = $1 AND owner_id = $2', [toInt(req.params.id), req.user.id]);
  res.redirect('/closet');
});

// ---------- borrow requests ----------
app.post('/dresses/:id/request', requireAuth, checkCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  const dress = id && await db.one('SELECT * FROM dresses WHERE id = $1 AND active', [id]);
  if (!dress) return res.sendStatus(404);
  const fail = (msg) => { flash(req, msg, 'err'); res.redirect(`/dresses/${dress.id}`); };
  if (dress.owner_id === req.user.id) return fail("That's your own dress!");

  const b = req.body;
  const pickup = clean(b.pickup_date, 10), ret = clean(b.return_date, 10);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(pickup) || !dateRe.test(ret) || ret < pickup) return fail('Please enter valid pickup and return dates.');

  // Borrowers can combine terms. Swap is always allowed as an offer; the owner decides when accepting.
  const offer = {
    deposit: !!b.offer_deposit, dryclean: !!b.offer_dryclean, swap: !!b.offer_swap,
    free: !!b.offer_free, fee: !!b.offer_fee,
  };
  if (!Object.values(offer).some(Boolean)) return fail('Choose at least one of your terms.');
  if (offer.free && offer.fee) return fail('Pick either "free" or a rental fee, not both.');
  let deposit = null, swapId = null, fee = null;
  if (offer.fee) {
    fee = toInt(b.fee_amount);
    const minFee = dress.allow_fee ? dress.rental_fee : 1;
    if (fee === null || fee < minFee || fee > 5000) return fail(`Please enter a rental fee of at least $${minFee}.`);
  }
  if (offer.deposit) {
    deposit = toInt(b.deposit_amount);
    if (deposit === null || deposit < dress.min_deposit || deposit > 5000) {
      return fail(`Please enter a deposit of at least $${dress.min_deposit}.`);
    }
  }
  if (offer.dryclean && !b.dryclean_agree) return fail('Please check the box agreeing to dry clean the dress before returning it.');
  if (offer.swap) {
    const mine = await db.one('SELECT id FROM dresses WHERE id = $1 AND owner_id = $2 AND active', [toInt(b.swap_dress_id), req.user.id]);
    if (!mine) return fail('Pick one of your posted dresses to offer in the swap.');
    swapId = mine.id;
  }

  await db.all(`INSERT INTO requests (dress_id, borrower_id, event_name, pickup_date, return_date,
                  offer_deposit, offer_dryclean, offer_swap, offer_free, offer_fee,
                  deposit_amount, fee_amount, swap_dress_id, message)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [dress.id, req.user.id, clean(b.event_name, 80), pickup, ret, offer.deposit, offer.dryclean, offer.swap,
     offer.free, offer.fee, deposit, fee, swapId, clean(b.message, 1000)]);
  flash(req, 'Request sent! You will see the owner’s contact info here once your request is accepted.');
  res.redirect('/closet#sent');
});

app.post('/requests/:id/:action', requireAuth, checkCsrf, async (req, res) => {
  const r = await db.one(`SELECT r.*, d.owner_id FROM requests r JOIN dresses d ON d.id = r.dress_id WHERE r.id = $1`, [toInt(req.params.id)]);
  if (!r) return res.sendStatus(404);
  const isOwner = r.owner_id === req.user.id, isBorrower = r.borrower_id === req.user.id;
  const back = '/closet' + (isOwner ? '#received' : '#sent');
  const action = req.params.action;

  // Temporary swaps: each person confirms they got their own dress back; it's done when both have.
  if (action === 'gotback') {
    if (!r.offer_swap || r.status !== 'accepted' || !(isOwner || isBorrower)) return res.sendStatus(400);
    const col = isOwner ? 'owner_got_back' : 'borrower_got_back';
    await db.all(`UPDATE requests SET ${col} = true, updated_at = now(),
                  status = CASE WHEN (owner_got_back OR $2) AND (borrower_got_back OR $3) THEN 'returned' ELSE status END
                  WHERE id = $1`, [r.id, isOwner, isBorrower]);
    return res.redirect(back);
  }

  const transitions = {
    accept:   { who: isOwner,                         from: ['pending'],             to: 'accepted' },
    decline:  { who: isOwner,                         from: ['pending'],             to: 'declined' },
    returned: { who: isOwner && !r.offer_swap,        from: ['accepted'],            to: 'returned' },
    cancel:   { who: isBorrower,                      from: ['pending', 'accepted'], to: 'cancelled' },
  };
  const t = transitions[action];
  if (!t || !t.who || !t.from.includes(r.status)) return res.sendStatus(400);
  await db.all(`UPDATE requests SET status = $1, updated_at = now() WHERE id = $2`, [t.to, r.id]);
  res.redirect(back);
});

// ---------- permanent trades ----------
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

app.post('/dresses/:id/trade', requireAuth, checkCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  const dress = id && await db.one('SELECT * FROM dresses WHERE id = $1 AND active', [id]);
  if (!dress) return res.sendStatus(404);
  const fail = (msg) => { flash(req, msg, 'err'); res.redirect(`/dresses/${dress.id}#trade`); };
  if (dress.owner_id === req.user.id) return fail("That's your own dress!");
  if (!dress.open_to_trade) return fail('This dress is not up for trade.');

  const ids = [...new Set(asList(req.body.offer_ids).map(toInt).filter(Boolean))].slice(0, 5);
  if (!ids.length) return fail('Pick at least one of your dresses to offer.');
  const mine = await db.all('SELECT id FROM dresses WHERE id = ANY($1) AND owner_id = $2 AND active', [ids, req.user.id]);
  if (mine.length !== ids.length) return fail('You can only offer dresses you have posted.');
  const open = await db.one(`SELECT id FROM trades WHERE dress_id = $1 AND offerer_id = $2 AND status IN ('pending','accepted')`, [dress.id, req.user.id]);
  if (open) return fail('You already have an open trade offer for this dress.');

  await db.tx(async (q) => {
    const [t] = await q(`INSERT INTO trades (dress_id, owner_id, offerer_id, message) VALUES ($1, $2, $3, $4) RETURNING id`,
      [dress.id, dress.owner_id, req.user.id, clean(req.body.message, 1000)]);
    await q('INSERT INTO trade_items (trade_id, dress_id) SELECT $1, unnest($2::int[])', [t.id, ids]);
  });
  flash(req, 'Trade offer sent! If it\u2019s accepted, you\u2019ll both see each other\u2019s contact info to meet up.');
  res.redirect('/closet#trades-sent');
});

app.post('/trades/:id/:action', requireAuth, checkCsrf, async (req, res) => {
  const t = await db.one('SELECT * FROM trades WHERE id = $1', [toInt(req.params.id)]);
  if (!t) return res.sendStatus(404);
  const isOwner = t.owner_id === req.user.id, isOfferer = t.offerer_id === req.user.id;
  if (!isOwner && !isOfferer) return res.sendStatus(403);
  const back = '/closet' + (isOwner ? '#trades-received' : '#trades-sent');
  const fail = (msg) => { flash(req, msg, 'err'); res.redirect(back); };
  const action = req.params.action;

  // Every dress in the trade must still belong to the person giving it.
  const stillValid = async (q) => {
    const [target] = await q('SELECT owner_id FROM dresses WHERE id = $1', [t.dress_id]);
    const items = await q('SELECT d.id, d.owner_id FROM trade_items i JOIN dresses d ON d.id = i.dress_id WHERE i.trade_id = $1', [t.id]);
    return target && target.owner_id === t.owner_id && items.length > 0 && items.every((d) => d.owner_id === t.offerer_id);
  };

  if (action === 'accept' && isOwner && t.status === 'pending') {
    if (!(await stillValid(db.all))) return fail('One of the dresses in this offer is no longer available.');
    await db.all(`UPDATE trades SET status = 'accepted', updated_at = now() WHERE id = $1`, [t.id]);
    await db.all(`UPDATE trades SET status = 'declined', updated_at = now() WHERE dress_id = $1 AND status = 'pending' AND id != $2`, [t.dress_id, t.id]);
    flash(req, 'Trade accepted! Meet up to exchange dresses, then both of you tap \u201cWe\u2019ve swapped\u201d.');
  } else if (action === 'decline' && isOwner && t.status === 'pending') {
    await db.all(`UPDATE trades SET status = 'declined', updated_at = now() WHERE id = $1`, [t.id]);
  } else if (action === 'cancel' && (isOfferer ? ['pending', 'accepted'] : ['accepted']).includes(t.status)) {
    await db.all(`UPDATE trades SET status = 'cancelled', updated_at = now() WHERE id = $1`, [t.id]);
  } else if (action === 'confirm' && t.status === 'accepted') {
    const done = await db.tx(async (q) => {
      const [row] = await q(`UPDATE trades SET ${isOwner ? 'owner_confirmed' : 'offerer_confirmed'} = true, updated_at = now()
                             WHERE id = $1 AND status = 'accepted' RETURNING *`, [t.id]);
      if (!row || !(row.owner_confirmed && row.offerer_confirmed)) return false;
      if (!(await stillValid(q))) throw new Error('trade no longer valid');
      // Hand over ownership both ways.
      const items = (await q('SELECT dress_id FROM trade_items WHERE trade_id = $1', [t.id])).map((r) => r.dress_id);
      const moved = [t.dress_id, ...items];
      await q('UPDATE dresses SET owner_id = $1, open_to_trade = false WHERE id = $2', [t.offerer_id, t.dress_id]);
      await q('UPDATE dresses SET owner_id = $1, open_to_trade = false WHERE id = ANY($2)', [t.owner_id, items]);
      await q(`UPDATE trades SET status = 'completed', updated_at = now() WHERE id = $1`, [t.id]);
      // Other open offers and borrow requests involving these dresses no longer make sense.
      await q(`UPDATE trades SET status = 'cancelled', updated_at = now()
               WHERE status IN ('pending','accepted') AND id != $1
                 AND (dress_id = ANY($2) OR id IN (SELECT trade_id FROM trade_items WHERE dress_id = ANY($2)))`, [t.id, moved]);
      await q(`UPDATE requests SET status = 'cancelled', updated_at = now() WHERE status = 'pending' AND dress_id = ANY($1)`, [moved]);
      return true;
    }).catch((e) => { if (e.message === 'trade no longer valid') return 'invalid'; throw e; });
    if (done === 'invalid') return fail('One of the dresses in this trade is no longer available.');
    flash(req, done ? 'Trade complete! The dresses now show up in each other\u2019s closets.' : 'Got it. The trade completes once the other person confirms too.');
  } else {
    return res.sendStatus(400);
  }
  res.redirect(back);
});

// ---------- swap tab ----------
app.get('/swaps', requireAuth, async (req, res) => {
  const list = async (cond) => attachPhotos(await db.all(`
    SELECT d.*, u.name AS owner_name FROM dresses d JOIN users u ON u.id = d.owner_id
    WHERE d.active AND ${cond} AND d.owner_id != $1 ORDER BY d.created_at DESC LIMIT 100`, [req.user.id]));
  const forTrade = await list('d.open_to_trade');
  const forSwap = await list('d.allow_swap');
  const myCount = (await db.one('SELECT count(*)::int AS n FROM dresses WHERE owner_id = $1 AND active', [req.user.id])).n;
  res.render('swaps', { title: 'Swap', forTrade, forSwap, myCount });
});

app.get('/closet', requireAuth, async (req, res) => {
  const listings = await attachPhotos(await db.all('SELECT * FROM dresses WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]));
  const base = `
    SELECT r.*, d.title AS dress_title, sd.title AS swap_title,
           o.name AS owner_name, o.email AS owner_email, o.phone AS owner_phone,
           b.name AS borrower_name, b.email AS borrower_email, b.phone AS borrower_phone,
           b.class_year AS borrower_year, b.college AS borrower_college
    FROM requests r
    JOIN dresses d ON d.id = r.dress_id
    JOIN users o ON o.id = d.owner_id
    JOIN users b ON b.id = r.borrower_id
    LEFT JOIN dresses sd ON sd.id = r.swap_dress_id`;
  const received = await db.all(`${base} WHERE d.owner_id = $1 ORDER BY (r.status = 'pending') DESC, r.created_at DESC`, [req.user.id]);
  const sent = await db.all(`${base} WHERE r.borrower_id = $1 ORDER BY r.created_at DESC`, [req.user.id]);

  const trades = await db.all(`
    SELECT t.*, d.title AS dress_title,
           o.name AS owner_name, o.email AS owner_email, o.phone AS owner_phone,
           f.name AS offerer_name, f.email AS offerer_email, f.phone AS offerer_phone, f.class_year AS offerer_year
    FROM trades t
    JOIN dresses d ON d.id = t.dress_id
    JOIN users o ON o.id = t.owner_id
    JOIN users f ON f.id = t.offerer_id
    WHERE t.owner_id = $1 OR t.offerer_id = $1
    ORDER BY (t.status IN ('pending','accepted')) DESC, t.created_at DESC`, [req.user.id]);
  const items = trades.length ? await db.all(`
    SELECT i.trade_id, d.id, d.title FROM trade_items i JOIN dresses d ON d.id = i.dress_id WHERE i.trade_id = ANY($1)`,
    [trades.map((t) => t.id)]) : [];
  for (const t of trades) t.items = items.filter((i) => i.trade_id === t.id);
  res.render('closet', {
    title: 'My closet', listings, received, sent,
    tradesReceived: trades.filter((t) => t.owner_id === req.user.id),
    tradesSent: trades.filter((t) => t.offerer_id === req.user.id),
  });
});

// ---------- errors ----------
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const isUpload = err instanceof multer.MulterError;
  if (req.get('X-Requested-With') === 'fetch') {
    return res.status(isUpload ? 400 : 500).json({ error: isUpload ? 'One of your photos is too large, or you added more than 6.' : 'Something went wrong. Please try again.' });
  }
  const message = isUpload
    ? (err.code === 'LIMIT_FILE_SIZE' ? 'One of your photos is too large. Try a smaller photo.' : 'You can upload up to 6 photos.')
    : 'Something went wrong.';
  res.status(isUpload ? 400 : 500).render('error', { title: 'Oops', message });
});

module.exports = app;
module.exports.BASE_URL = BASE_URL;
module.exports.PORT = PORT;
