require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const db = require('./db');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || `http://localhost:${PORT}`).replace(/\/$/, '');
const CAS_URL = (process.env.CAS_URL || 'https://fed.princeton.edu/cas').replace(/\/$/, '');
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
// Set MS_TENANT to Princeton's Entra tenant ID once known; 'organizations' accepts any work/school account
// and we then require a @princeton.edu address below.
const MS_TENANT = process.env.MS_TENANT || 'organizations';
const MS_ENABLED = !!(MS_CLIENT_ID && MS_CLIENT_SECRET);
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'princeton.edu').toLowerCase();
const DEV_LOGIN = !IS_PROD && process.env.DEV_LOGIN === 'true';

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
  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.devLogin = DEV_LOGIN;
  res.locals.msEnabled = MS_ENABLED;
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

// ---------- auth: Princeton CAS ----------
async function logIn(req, netid) {
  const u = await db.one(
    `INSERT INTO users (netid) VALUES ($1) ON CONFLICT (netid) DO UPDATE SET netid = EXCLUDED.netid RETURNING id`, [netid]);
  req.session.userId = u.id;
  return u.id;
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Log in', next: safeNext(req.query.next) });
});

app.get('/login/cas', (req, res) => {
  req.session.next = safeNext(req.query.next);
  res.redirect(`${CAS_URL}/login?service=${encodeURIComponent(`${BASE_URL}/auth/cas`)}`);
});

app.get('/auth/cas', async (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) return res.redirect('/login');
  const service = `${BASE_URL}/auth/cas`;
  try {
    const url = `${CAS_URL}/serviceValidate?service=${encodeURIComponent(service)}&ticket=${encodeURIComponent(ticket)}`;
    const xml = await (await fetch(url)).text();
    const m = xml.match(/<cas:user>\s*([^<\s]+)\s*<\/cas:user>/);
    if (!m) throw new Error('CAS validation failed: ' + xml.slice(0, 300));
    await logIn(req, m[1].toLowerCase());
    const next = req.session.next; req.session.next = null;
    res.redirect(safeNext(next));
  } catch (e) {
    console.error(e);
    res.status(401).render('error', { title: 'Login failed', message: 'We could not verify your Princeton login. Please try again.' });
  }
});

// ---------- auth: Microsoft (Princeton Outlook account) ----------
if (MS_ENABLED) {
  const msBase = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0`;
  const redirectUri = `${BASE_URL}/auth/microsoft`;
  const scope = 'openid profile email User.Read';

  app.get('/login/microsoft', (req, res) => {
    req.session.next = safeNext(req.query.next);
    req.session.msState = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope, state: req.session.msState, domain_hint: ALLOWED_DOMAIN, prompt: 'select_account',
    });
    res.redirect(`${msBase}/authorize?${params}`);
  });

  app.get('/auth/microsoft', async (req, res) => {
    const fail = (message) => res.status(401).render('error', { title: 'Login failed', message });
    const { code, state } = req.query;
    const expected = req.session.msState; req.session.msState = null;
    if (!code || !state || state !== expected) return fail('Your login session expired. Please try again.');
    try {
      const token = await (await fetch(`${msBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, grant_type: 'authorization_code',
          code, redirect_uri: redirectUri, scope,
        }),
      })).json();
      if (!token.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(token));
      const me = await (await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,displayName', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })).json();
      const [netid, domain] = String(me.userPrincipalName || '').toLowerCase().split('@');
      if (!netid || domain !== ALLOWED_DOMAIN) return fail(`Please sign in with your @${ALLOWED_DOMAIN} account.`);
      const id = await logIn(req, netid.replace(/[^a-z0-9._-]/g, ''));
      if (me.displayName) await db.all('UPDATE users SET name = COALESCE(name, $1) WHERE id = $2', [me.displayName.slice(0, 80), id]);
      const next = req.session.next; req.session.next = null;
      res.redirect(safeNext(next));
    } catch (e) {
      console.error(e);
      fail('We could not verify your Microsoft login. Please try again.');
    }
  });
}

if (DEV_LOGIN) {
  app.post('/login/dev', checkCsrf, async (req, res) => {
    const netid = clean(req.body.netid, 20).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!netid) return res.redirect('/login');
    await logIn(req, netid);
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
  if (filters.terms === 'swap') where.push('d.allow_swap');
  const dresses = await attachPhotos(await db.all(`
    SELECT d.*, u.name AS owner_name FROM dresses d JOIN users u ON u.id = d.owner_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`, params));
  res.render('browse', { title: 'Browse dresses', dresses, filters, SIZES, LENGTHS });
});

app.get('/dresses/new', requireAuth, (req, res) => {
  res.render('dress-form', { title: 'Post a dress', SIZES, LENGTHS });
});

app.post('/dresses', requireAuth, upload.array('photos', 6), checkCsrf, async (req, res) => {
  const b = req.body;
  const title = clean(b.title, 100);
  const size = SIZES.includes(b.size) ? b.size : null;
  const allowDeposit = !!b.allow_deposit, allowDryclean = !!b.allow_dryclean, allowSwap = !!b.allow_swap;
  const errors = [];
  if (!title) errors.push('Give your dress a title.');
  if (!size) errors.push('Pick a size.');
  if (!req.files || req.files.length === 0) errors.push('Add at least one photo (JPG, PNG, WEBP or HEIC).');
  if (!allowDeposit && !allowDryclean && !allowSwap) errors.push('Choose at least one way people can borrow it.');
  if (errors.length) {
    flash(req, errors.join(' '), 'err');
    return go(req, res, '/dresses/new');
  }

  const keys = req.files.map((f) => crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[f.mimetype]);
  await Promise.all(req.files.map((f, i) => storage.save(keys[i], f.buffer, f.mimetype)));
  try {
    const d = await db.one(`
      INSERT INTO dresses (owner_id, title, designer, size, color, length, description,
                           allow_deposit, min_deposit, allow_dryclean, allow_swap)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [
      req.user.id, title, clean(b.designer, 60), size, clean(b.color, 40),
      LENGTHS.includes(b.length) ? b.length : null, clean(b.description, 2000),
      allowDeposit, allowDeposit ? Math.max(0, Math.min(2000, toInt(b.min_deposit) || 0)) : 0,
      allowDryclean, allowSwap]);
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
  res.render('dress', { title: dress.title, dress, isOwner, myDresses, myRequest });
});

app.post('/dresses/:id/delete', requireAuth, checkCsrf, async (req, res) => {
  const id = toInt(req.params.id);
  const dress = id && await db.one('SELECT id FROM dresses WHERE id = $1 AND owner_id = $2', [id, req.user.id]);
  if (!dress) return res.sendStatus(404);
  const photos = await db.all('SELECT key FROM photos WHERE dress_id = $1', [dress.id]);
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

  const terms = b.terms;
  let deposit = null, swapId = null;
  if (terms === 'deposit') {
    if (!dress.allow_deposit) return fail('This owner is not accepting deposits.');
    deposit = toInt(b.deposit_amount);
    if (deposit === null || deposit < dress.min_deposit || deposit > 5000) {
      return fail(`Please enter a deposit of at least $${dress.min_deposit}.`);
    }
  } else if (terms === 'dryclean') {
    if (!dress.allow_dryclean) return fail('This owner is not accepting dry-clean agreements.');
    if (!b.dryclean_agree) return fail('Please check the box agreeing to dry clean the dress before returning it.');
  } else if (terms === 'swap') {
    if (!dress.allow_swap) return fail('This owner is not open to swaps.');
    const mine = await db.one('SELECT id FROM dresses WHERE id = $1 AND owner_id = $2 AND active', [toInt(b.swap_dress_id), req.user.id]);
    if (!mine) return fail('Pick one of your posted dresses to offer in the swap.');
    swapId = mine.id;
  } else {
    return fail('Choose how you would like to borrow this dress.');
  }

  await db.all(`INSERT INTO requests (dress_id, borrower_id, event_name, pickup_date, return_date, terms, deposit_amount, swap_dress_id, message)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [dress.id, req.user.id, clean(b.event_name, 80), pickup, ret, terms, deposit, swapId, clean(b.message, 1000)]);
  flash(req, 'Request sent! You will see the owner’s contact info here once your request is accepted.');
  res.redirect('/closet#sent');
});

app.post('/requests/:id/:action', requireAuth, checkCsrf, async (req, res) => {
  const r = await db.one(`SELECT r.*, d.owner_id FROM requests r JOIN dresses d ON d.id = r.dress_id WHERE r.id = $1`, [toInt(req.params.id)]);
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
  await db.all(`UPDATE requests SET status = $1, updated_at = now() WHERE id = $2`, [t.to, r.id]);
  res.redirect('/closet' + (isOwner ? '#received' : '#sent'));
});

app.get('/closet', requireAuth, async (req, res) => {
  const listings = await attachPhotos(await db.all('SELECT * FROM dresses WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]));
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
  const received = await db.all(`${base} WHERE d.owner_id = $1 ORDER BY (r.status = 'pending') DESC, r.created_at DESC`, [req.user.id]);
  const sent = await db.all(`${base} WHERE r.borrower_id = $1 ORDER BY r.created_at DESC`, [req.user.id]);
  res.render('closet', { title: 'My closet', listings, received, sent });
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
module.exports.DEV_LOGIN = DEV_LOGIN;
