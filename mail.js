// Sends email through Resend (https://resend.com) when RESEND_API_KEY and EMAIL_FROM are set.
const enabled = !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

async function send({ to, subject, text, html }) {
  if (!enabled) throw new Error('Email is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status}): ${await res.text()}`);
}

module.exports = { enabled, send };
