require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CAS_URL = (process.env.CAS_URL || 'https://fed.princeton.edu/cas').replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
// Set MS_TENANT to Princeton's Entra tenant ID once known; 'organizations' accepts any work/school account
// and we then require a @princeton.edu address below.
const MS_TENANT = process.env.MS_TENANT || 'organizations';
const MS_ENABLED = !!(MS_CLIENT_ID && MS_CLIENT_SECRET);
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'princeton.edu').toLowerCase();
const DEV_LOGIN = !IS_PROD && process.env.DEV_LOGIN === 'true';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (IS_PROD && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SIZES = ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', '18+', 'XS', 'S', 'M', 'L', 'XL'];
const LENGTHS = ['Mini', 'Knee', 'Midi', 'Tea', 'Floor-length'];
const COLLEGES = ['Butler', 'Forbes', 'Mathey', 'New College West', 'Rockefeller', 'Whitman', 'Yeh', 'Upperclass / Independent', 'Grad'];

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (IS_PROD) app.set('trust proxy', 1);

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
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || null;
}

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  req.user = currentUser(req);
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.devLogin = DEV_LOGIN;
  res.locals.msEnabled = MS_ENABLED;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.path = req.path;
  next();
});

function flash(req, msg, type = 'ok') { req.session.flash = { msg, type }; }

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!req.user.name && !req.path.startsWith('/profile')) return res.redirect('/profile?welcome=1');
  next();
}

function checkCsrf(req, res, next) {
  const token = req.body && req.body._csrf;
  if (!token || token.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Please go back, refresh the page, and try again.' });
  }
  next();
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/browse';
}

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function dressWithPhotos(d) {
  if (!d) return d;
  d.photos = db.prepare('SELECT * FROM photos WHERE dress_id = ? ORDER BY position').all(d.id);
  return d;
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' }[file.mimetype] || '';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.mimetype)),
});

function removeFiles(files) {
  for (const f of files || []) fs.unlink(f.path || path.join(UPLOAD_DIR, f.filename), () => {});
}

// Photos are only visible to logged-in Princeton users.
app.use('/uploads', (req, res, next) => (req.user ? next() : res.sendStatus(401)),
  express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: false }));

// ---------- auth (Princeton CAS) ----------
app.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Log in', next: safeNext(req.query.next) });
});

app.get('/login/cas', (req, res) => {
  req.session.next = safeNext(req.query.next);
  const service = `${BASE_URL}/auth/cas`;
  res.redirect(`${CAS_URL}/login?service=${encodeURIComponent(service)}`);
});

app.get('/auth/cas', async (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) return res.redirect('/login');
  const service = `${BASE_URL}/auth/cas`;
  try {
    const url = `${CAS_URL}/serviceValidate?service=${encodeURIComponent(service)}&ticket=${encodeURIComponent(ticket)}`;
    const xml = await (await fetch(url)).text();
    const m = xml.match(/<cas:user>\s*([^<\s]+)\s*<\/cas:user>/);
    if (!m) throw new Error('CAS validation failed');
    logIn(req, m[1].toLowerCase());
    const next = req.session.next; req.session.next = null;
    res.redirect(safeNext(next));
  } catch (e) {
    console.error(e);
    res.status(401).render('error', { title: 'Login failed', message: 'We could not verify your Princeton login. Please try again.' });
  }
});

// ---------- auth (Microsoft / Princeton Outlook account) ----------
if (MS_ENABLED) {
  const msBase = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0`;
  const redirectUri = `${BASE_URL}/auth/microsoft`;

  app.get('/login/microsoft', (req, res) => {
    req.session.next = safeNext(req.query.next);
    req.session.msState = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: 'openid profile email User.Read', state: req.session.msState,
      domain_hint: ALLOWED_DOMAIN, prompt: 'select_account',
    });
    res.redirect(`${msBase}/authorize?${params}`);
  });

  app.get('/auth/microsoft', async (req, res) => {
    const fail = (message) => res.status(401).render('error', { title: 'Login failed', message });
    const { code, state } = req.query;
    const expected = req.session.msState; req.session.msState = null;
    if (!code || !state || state !== expected) return fail('Your login session expired. Please try again.');
    try {
      const tokenRes = await fetch(`${msBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, grant_type: 'authorization_code',
          code, redirect_uri: redirectUri, scope: 'openid profile email User.Read',
        }),
      });
      const token = await tokenRes.json();
      if (!token.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(token));
      const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail,displayName', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })).json();
      const upn = String(me.userPrincipalName || '').toLowerCase();
      const [netid, domain] = upn.split('@');
      if (!netid || domain !== ALLOWED_DOMAIN) return fail(`Please sign in with your @${ALLOWED_DOMAIN} account.`);
      logIn(req, netid.replace(/[^a-z0-9._-]/g, ''));
      if (me.displayName) db.prepare('UPDATE users SET name = COALESCE(name, ?) WHERE id = ?').run(me.displayName.slice(0, 80), req.session.userId);
      const next = req.session.next; req.session.next = null;
      res.redirect(safeNext(next));
    } catch (e) {
      console.error(e);
      fail('We could not verify your Microsoft login. Please try again.');
    }
  });
}

function logIn(req, netid) {
  db.prepare('INSERT INTO users (netid) VALUES (?) ON CONFLICT(netid) DO NOTHING').run(netid);
  req.session.userId = db.prepare('SELECT id FROM users WHERE netid = ?').get(netid).id;
}

if (DEV_LOGIN) {
  app.post('/login/dev', checkCsrf, (req, res) => {
    const netid = clean(req.body.netid, 20).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!netid) return res.redirect('/login');
    logIn(req, netid);
    res.redirect(safeNext(req.body.next));
  });
}

app.post('/logout', checkCsrf, (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- pages ----------
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/browse');
  res.render('home', { title: 'Tiger Closet' });
});

app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'Your profile', welcome: !!req.query.welcome, colleges: COLLEGES });
});

app.post('/profile', requireAuth, checkCsrf, (req, res) => {
  const name = clean(req.body.name, 80);
  if (!name) { flash(req, 'Please add your name.', 'err'); return res.redirect('/profile'); }
  db.prepare('UPDATE users SET name = ?, class_year = ?, college = ?, phone = ? WHERE id = ?')
    .run(name, clean(req.body.class_year, 4), clean(req.body.college, 40), clean(req.body.phone, 30), req.user.id);
  flash(req, 'Profile saved.');
  res.redirect('/browse');
});

app.get('/browse', requireAuth, (req, res) => {
  const { q = '', size = '', length = '', terms = '' } = req.query;
  const where = ['d.active = 1'];
  const params = {};
  if (q) { where.push('(d.title LIKE @q OR d.designer LIKE @q OR d.color LIKE @q OR d.description LIKE @q)'); params.q = `%${q}%`; }
  if (size) { where.push('d.size = @size'); params.size = size; }
  if (length) { where.push('d.length = @length'); params.length = length; }
  if (terms === 'deposit') where.push('d.allow_deposit = 1');
  if (terms === 'dryclean') where.push('d.allow_dryclean = 1');
  if (terms === 'swap') where.push('d.allow_swap = 1');
  const dresses = db.prepare(`
    SELECT d.*, u.name AS owner_name, u.netid AS owner_netid
    FROM dresses d JOIN users u ON u.id = d.owner_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`).all(params).map(dressWithPhotos);
  res.render('browse', { title: 'Browse dresses', dresses, filters: { q, size, length, terms }, SIZES, LENGTHS });
});

app.get('/dresses/new', requireAuth, (req, res) => {
  res.render('dress-form', { title: 'Post a dress', SIZES, LENGTHS });
});

app.post('/dresses', requireAuth, upload.array('photos', 6), checkCsrf, (req, res) => {
  const b = req.body;
  const title = clean(b.title, 100);
  const size = SIZES.includes(b.size) ? b.size : null;
  const allowDeposit = b.allow_deposit ? 1 : 0;
  const allowDryclean = b.allow_dryclean ? 1 : 0;
  const allowSwap = b.allow_swap ? 1 : 0;
  const errors = [];
  if (!title) errors.push('Give your dress a title.');
  if (!size) errors.push('Pick a size.');
  if (!req.files || req.files.length === 0) errors.push('Add at least one photo (JPG, PNG, WEBP or HEIC, up to 8 MB each).');
  if (!allowDeposit && !allowDryclean && !allowSwap) errors.push('Choose at least one way people can borrow it.');
  if (errors.length) {
    removeFiles(req.files);
    flash(req, errors.join(' '), 'err');
    return res.redirect('/dresses/new');
  }
  const info = db.prepare(`
    INSERT INTO dresses (owner_id, title, designer, size, color, length, description,
                         allow_deposit, min_deposit, allow_dryclean, allow_swap)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, title, clean(b.designer, 60), size, clean(b.color, 40),
    LENGTHS.includes(b.length) ? b.length : null, clean(b.description, 2000),
    allowDeposit, allowDeposit ? Math.max(0, Math.min(2000, parseInt(b.min_deposit, 10) || 0)) : 0,
    allowDryclean, allowSwap);
  const addPhoto = db.prepare('INSERT INTO photos (dress_id, filename, position) VALUES (?, ?, ?)');
  req.files.forEach((f, i) => addPhoto.run(info.lastInsertRowid, f.filename, i));
  flash(req, 'Your dress is posted!');
  res.redirect(`/dresses/${info.lastInsertRowid}`);
});

app.get('/dresses/:id', requireAuth, (req, res) => {
  const dress = dressWithPhotos(db.prepare(`
    SELECT d.*, u.name AS owner_name, u.netid AS owner_netid, u.class_year AS owner_year, u.college AS owner_college
    FROM dresses d JOIN users u ON u.id = d.owner_id WHERE d.id = ?`).get(req.params.id));
  if (!dress || (!dress.active && dress.owner_id !== req.user.id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'That dress is no longer listed.' });
  }
  const isOwner = dress.owner_id === req.user.id;
  const myDresses = db.prepare('SELECT id, title FROM dresses WHERE owner_id = ? AND active = 1 AND id != ?').all(req.user.id, dress.id);
  const myRequest = db.prepare(`SELECT * FROM requests WHERE dress_id = ? AND borrower_id = ? AND status IN ('pending','accepted') ORDER BY id DESC`).get(dress.id, req.user.id);
  res.render('dress', { title: dress.title, dress, isOwner, myDresses, myRequest });
});

app.post('/dresses/:id/delete', requireAuth, checkCsrf, (req, res) => {
  const dress = dressWithPhotos(db.prepare('SELECT * FROM dresses WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id));
  if (!dress) return res.sendStatus(404);
  db.prepare('DELETE FROM dresses WHERE id = ?').run(dress.id);
  removeFiles(dress.photos);
  flash(req, 'Listing removed.');
  res.redirect('/closet');
});

app.post('/dresses/:id/toggle', requireAuth, checkCsrf, (req, res) => {
  db.prepare('UPDATE dresses SET active = 1 - active WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.redirect('/closet');
});

// ---------- borrow requests ----------
app.post('/dresses/:id/request', requireAuth, checkCsrf, (req, res) => {
  const dress = db.prepare('SELECT * FROM dresses WHERE id = ? AND active = 1').get(req.params.id);
  if (!dress) return res.sendStatus(404);
  const back = `/dresses/${dress.id}`;
  const fail = (msg) => { flash(req, msg, 'err'); res.redirect(back); };
  if (dress.owner_id === req.user.id) return fail("That's your own dress!");

  const b = req.body;
  const pickup = clean(b.pickup_date, 10), ret = clean(b.return_date, 10);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(pickup) || !dateRe.test(ret) || ret < pickup) return fail('Please enter valid pickup and return dates.');

  const terms = b.terms;
  let deposit = null, swapId = null;
  if (terms === 'deposit') {
    if (!dress.allow_deposit) return fail('This owner is not accepting deposits.');
    deposit = parseInt(b.deposit_amount, 10);
    if (!Number.isFinite(deposit) || deposit < dress.min_deposit || deposit > 5000) {
      return fail(`Please enter a deposit of at least $${dress.min_deposit}.`);
    }
  } else if (terms === 'dryclean') {
    if (!dress.allow_dryclean) return fail('This owner is not accepting dry-clean agreements.');
    if (!b.dryclean_agree) return fail('Please check the box agreeing to dry clean the dress before returning it.');
  } else if (terms === 'swap') {
    if (!dress.allow_swap) return fail('This owner is not open to swaps.');
    const mine = db.prepare('SELECT id FROM dresses WHERE id = ? AND owner_id = ? AND active = 1').get(b.swap_dress_id, req.user.id);
    if (!mine) return fail('Pick one of your posted dresses to offer in the swap.');
    swapId = mine.id;
  } else {
    return fail('Choose how you would like to borrow this dress.');
  }

  db.prepare(`INSERT INTO requests (dress_id, borrower_id, event_name, pickup_date, return_date, terms, deposit_amount, swap_dress_id, message)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(dress.id, req.user.id, clean(b.event_name, 80), pickup, ret, terms, deposit, swapId, clean(b.message, 1000));
  flash(req, 'Request sent! You will see the owner’s contact info here once your request is accepted.');
  res.redirect('/closet#sent');
});

app.post('/requests/:id/:action', requireAuth, checkCsrf, (req, res) => {
  const r = db.prepare(`SELECT r.*, d.owner_id FROM requests r JOIN dresses d ON d.id = r.dress_id WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.sendStatus(404);
  const isOwner = r.owner_id === req.user.id, isBorrower = r.borrower_id === req.user.id;
  const transitions = {
    accept:   { who: isOwner,    from: ['pending'],             to: 'accepted' },
    decline:  { who: isOwner,    from: ['pending'],             to: 'declined' },
    returned: { who: isOwner,    from: ['accepted'],            to: 'returned' },
    cancel:   { who: isBorrower, from: ['pending', 'accepted'], to: 'cancelled' },
  };
  const t = transitions[req.params.action];
  if (!t || !t.who || !t.from.includes(r.status)) return res.sendStatus(400);
  db.prepare(`UPDATE requests SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(t.to, r.id);
  res.redirect('/closet' + (isOwner ? '#received' : '#sent'));
});

app.get('/closet', requireAuth, (req, res) => {
  const listings = db.prepare('SELECT * FROM dresses WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id).map(dressWithPhotos);
  const base = `
    SELECT r.*, d.title AS dress_title, sd.title AS swap_title,
           o.name AS owner_name, o.netid AS owner_netid, o.phone AS owner_phone,
           b.name AS borrower_name, b.netid AS borrower_netid, b.phone AS borrower_phone,
           b.class_year AS borrower_year, b.college AS borrower_college
    FROM requests r
    JOIN dresses d ON d.id = r.dress_id
    JOIN users o ON o.id = d.owner_id
    JOIN users b ON b.id = r.borrower_id
    LEFT JOIN dresses sd ON sd.id = r.swap_dress_id`;
  const received = db.prepare(`${base} WHERE d.owner_id = ? ORDER BY (r.status = 'pending') DESC, r.created_at DESC`).all(req.user.id);
  const sent = db.prepare(`${base} WHERE r.borrower_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
  res.render('closet', { title: 'My closet', listings, received, sent });
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  console.error(err);
  removeFiles(req.files);
  const message = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 8 MB.' : 'You can upload up to 6 photos.')
    : 'Something went wrong.';
  res.status(err instanceof multer.MulterError ? 400 : 500).render('error', { title: 'Oops', message });
});
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

app.listen(PORT, () => {
  console.log(`Tiger Closet running at ${BASE_URL}`);
  if (DEV_LOGIN) console.log('DEV_LOGIN is on: you can log in with any NetID (disabled in production).');
});
