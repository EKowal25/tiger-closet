// Email notifications about requests, swaps and trades. Never throws: a failed email must not break the action.
const db = require('./db');
const mail = require('./mail');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function makeNotify(BASE_URL) {
  // to: user id. lines: plain-text paragraphs. link: site path for the button.
  return async function notify(to, { subject, lines = [], link = '/closet', button = 'Open Tiger Closet' }) {
    if (!mail.enabled || !to) return;
    try {
      const user = await db.one('SELECT email, name, notify_email FROM users WHERE id = $1', [to]);
      if (!user || !user.email || !user.notify_email) return;
      const url = BASE_URL + link;
      const hi = user.name ? `Hi ${user.name.split(' ')[0]},` : 'Hi,';
      const text = [hi, '', ...lines, '', `${button}: ${url}`, '', `Don't want these emails? Turn them off on your profile: ${BASE_URL}/profile`].join('\n');
      const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;color:#111">
        <div style="font-weight:800;font-size:22px;letter-spacing:-.02em;margin-bottom:16px">TIGER <span style="background:#d4ff3f;padding:0 6px;border-radius:5px">CLOSET</span></div>
        <p>${esc(hi)}</p>
        ${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        <p style="margin:24px 0"><a href="${esc(url)}" style="background:#ff5a1f;color:#111;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px;border:2px solid #111;display:inline-block">${esc(button)}</a></p>
        <p style="color:#777;font-size:12px">You're getting this because you have a Tiger Closet account. <a href="${esc(BASE_URL)}/profile" style="color:#777">Turn off these emails</a>.</p>
      </div>`;
      // Wait (briefly) so serverless functions don't freeze before the email is sent.
      await Promise.race([
        mail.send({ to: user.email, subject, text, html }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('email timeout')), 5000)),
      ]);
    } catch (e) {
      console.error('notification failed:', e.message);
    }
  };
};
