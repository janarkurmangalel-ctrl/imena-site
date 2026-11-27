const crypto = require('node:crypto');

function respond(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return respond(res, 405, { ok: false });
  const supplied = String(req.query?.key || '');
  const expected = String(process.env.TELEGRAM_SETUP_KEY || '');
  if (!expected || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return respond(res, 404, { ok: false });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return respond(res, 503, { ok: false });

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://imena.kz/api/telegram-webhook',
        secret_token: secret,
        allowed_updates: ['message', 'callback_query']
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) return respond(res, 502, { ok: false });
    return respond(res, 200, { ok: true, webhook: true });
  } catch {
    return respond(res, 502, { ok: false });
  }
};
