// Email + password accounts, limited to one school email domain, with optional emailed verification codes.
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const mail = require('./mail');

const scrypt = promisify(crypto.scrypt);
const CODE_TTL_MIN = 15;
const MAX_CODE_ATTEMPTS = 5;
const MAX_LOGIN_FAILS = 10;
const LOCK_MIN = 15;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function checkPassword(pw, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const key = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(hash, 'hex'));
}

const hashCode = (code) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-secret').update(code).digest('hex');

module.exports = function mountAuth(app, { checkCsrf, flash, safeNext, clean, BASE_URL, ALLOWED_DOMAIN }) {
  const emailRe = new RegExp(`^[a-z0-9._-]+@${ALLOWED_DOMAIN.replace(/\./g, '\\.')}$`);
  const normEmail = (v) => clean(v, 120).toLowerCase();
  const render = (res, view, title, extra = {}) => res.render(view, { title, domain: ALLOWED_DOMAIN, emailEnabled: mail.enabled, verifyRequired: mail.verifyRequired, ...extra });

  function startSession(req, user) {
    req.session.userId = user.id;
    req.session.sv = user.session_version;
  }

  async function sendCode(user, purpose) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.all(`UPDATE users SET verify_code = $1, verify_expires = now() + interval '${CODE_TTL_MIN} minutes',
                  verify_attempts = 0, verify_sent_at = now() WHERE id = $2`, [hashCode(code), user.id]);
    const what = purpose === 'reset' ? 'reset your password' : 'verify your email';
    await mail.send({
      to: user.email,
      subject: `Your Tiger Closet code: ${code}`,
      text: `Your code to ${what} on Tiger Closet is ${code}\n\nIt expires in ${CODE_TTL_MIN} minutes. If you didn't request this, you can ignore this email.\n\n${BASE_URL}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:420px">
        <h2 style="margin:0 0 12px">Tiger Closet</h2>
        <p>Your code to ${what} is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p>
        <p style="color:#666">It expires in ${CODE_TTL_MIN} minutes. If you didn't request this, you can ignore this email.</p></div>`,
    });
  }

  // Returns true if the code matches; tracks attempts so codes can't be brute-forced.
  async function useCode(user, code) {
    const u = await db.one('SELECT verify_code, verify_attempts, verify_expires > now() AS fresh FROM users WHERE id = $1', [user.id]);
    if (!u || !u.verify_code || !u.fresh || u.verify_attempts >= MAX_CODE_ATTEMPTS) return false;
    const given = hashCode(String(code || '').replace(/\D/g, ''));
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(u.verify_code))) {
      await db.all('UPDATE users SET verify_attempts = verify_attempts + 1 WHERE id = $1', [user.id]);
      return false;
    }
    await db.all('UPDATE users SET verify_code = NULL, verify_expires = NULL, email_verified = true WHERE id = $1', [user.id]);
    return true;
  }

  // ----- sign up -----
  app.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/browse');
    render(res, 'signup', 'Create an account', { next: safeNext(req.query.next), email: '', notify: true });
  });

  app.post('/signup', checkCsrf, async (req, res) => {
    const email = normEmail(req.body.email);
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    const next = safeNext(req.body.next);
    const notify = !!req.body.notify_email;
    const again = (msg) => { res.locals.flash = { msg, type: 'err' }; render(res.status(400), 'signup', 'Create an account', { next, email, notify }); };
    if (!emailRe.test(email)) return again(`Please use your @${ALLOWED_DOMAIN} school email.`);
    if (pw.length < 8 || pw.length > 200) return again('Your password needs at least 8 characters.');
    if (pw !== req.body.confirm) return again("Those passwords don't match.");

    const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return again('There is already an account with that email. Try logging in instead.');
    const netid = email.split('@')[0];
    const user = await db.one(
      `INSERT INTO users (netid, email, password_hash, notify_email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (netid) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, notify_email = EXCLUDED.notify_email
         WHERE users.password_hash IS NULL
       RETURNING *`, [netid, email, await hashPassword(pw), notify]);
    if (!user) return again('There is already an account with that email. Try logging in instead.');
    startSession(req, user);
    if (mail.verifyRequired) {
      await sendCode(user, 'verify');
      req.session.next = next;
      return res.redirect('/verify');
    }
    res.redirect('/profile?welcome=1');
  });

  // ----- log in -----
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    render(res, 'login', 'Log in', { next: safeNext(req.query.next), email: '' });
  });

  app.post('/login', checkCsrf, async (req, res) => {
    const email = normEmail(req.body.email);
    const pw = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
    const next = safeNext(req.body.next);
    const again = (msg) => { res.locals.flash = { msg, type: 'err' }; render(res.status(401), 'login', 'Log in', { next, email }); };
    if (!emailRe.test(email)) return again(`Please use your @${ALLOWED_DOMAIN} school email.`);

    const user = await db.one('SELECT *, locked_until > now() AS locked FROM users WHERE email = $1', [email]);
    if (user && user.locked) return again(`Too many attempts. Please wait ${LOCK_MIN} minutes and try again.`);
    if (!user || !(await checkPassword(pw, user.password_hash))) {
      if (user) {
        await db.all(`UPDATE users SET
                        locked_until = CASE WHEN failed_logins + 1 >= ${MAX_LOGIN_FAILS} THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END,
                        failed_logins = CASE WHEN failed_logins + 1 >= ${MAX_LOGIN_FAILS} THEN 0 ELSE failed_logins + 1 END
                      WHERE id = $1`, [user.id]);
      }
      return again('That email and password don’t match.');
    }
    await db.all('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
    startSession(req, user);
    if (mail.verifyRequired && !user.email_verified) {
      await sendCode(user, 'verify');
      req.session.next = next;
      return res.redirect('/verify');
    }
    res.redirect(next);
  });

  // ----- verify email -----
  app.get('/verify', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.email_verified || !mail.verifyRequired) return res.redirect('/browse');
    render(res, 'verify', 'Check your email');
  });

  app.post('/verify', checkCsrf, async (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (!(await useCode(req.user, req.body.code))) {
      flash(req, 'That code is wrong or has expired. Check your email or send a new code.', 'err');
      return res.redirect('/verify');
    }
    const next = req.session.next; req.session.next = null;
    res.redirect(req.user.name ? safeNext(next) : '/profile?welcome=1');
  });

  app.post('/verify/resend', checkCsrf, async (req, res) => {
    if (!req.user || !mail.verifyRequired) return res.redirect('/login');
    const u = await db.one(`SELECT verify_sent_at > now() - interval '60 seconds' AS recent FROM users WHERE id = $1`, [req.user.id]);
    if (u && u.recent) flash(req, 'Please wait a minute before requesting another code.', 'err');
    else { await sendCode(req.user, 'verify'); flash(req, `New code sent to ${req.user.email}.`); }
    res.redirect('/verify');
  });

  // ----- forgot password -----
  app.get('/forgot', (req, res) => render(res, 'forgot', 'Reset your password', { step: req.session.resetEmail ? 'code' : 'email', email: req.session.resetEmail || '' }));

  app.post('/forgot', checkCsrf, async (req, res) => {
    if (!mail.enabled) return res.redirect('/forgot');
    const email = normEmail(req.body.email);
    if (!emailRe.test(email)) { flash(req, `Please use your @${ALLOWED_DOMAIN} school email.`, 'err'); return res.redirect('/forgot'); }
    const user = await db.one(`SELECT *, verify_sent_at > now() - interval '60 seconds' AS recent FROM users WHERE email = $1`, [email]);
    if (user && !user.recent) await sendCode(user, 'reset');
    req.session.resetEmail = email; // same response whether or not the account exists
    flash(req, `If ${email} has an account, we just emailed it a code.`);
    res.redirect('/forgot');
  });

  app.post('/forgot/reset', checkCsrf, async (req, res) => {
    const email = req.session.resetEmail;
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email) return res.redirect('/forgot');
    if (pw.length < 8 || pw.length > 200) { flash(req, 'Your new password needs at least 8 characters.', 'err'); return res.redirect('/forgot'); }
    const user = await db.one('SELECT * FROM users WHERE email = $1', [email]);
    if (!user || !(await useCode(user, req.body.code))) {
      flash(req, 'That code is wrong or has expired.', 'err');
      return res.redirect('/forgot');
    }
    const u = await db.one(`UPDATE users SET password_hash = $1, session_version = session_version + 1,
                            failed_logins = 0, locked_until = NULL WHERE id = $2 RETURNING *`, [await hashPassword(pw), user.id]);
    req.session.resetEmail = null;
    startSession(req, u);
    flash(req, 'Password updated. You’re logged in.');
    res.redirect(u.name ? '/browse' : '/profile?welcome=1');
  });

  app.post('/forgot/cancel', checkCsrf, (req, res) => { req.session.resetEmail = null; res.redirect('/forgot'); });
};
