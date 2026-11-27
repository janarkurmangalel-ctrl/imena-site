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
  if (!token || !secret) return respond(res, 503, { ok: false, reason: 'missing_configuration' });

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
    if (!response.ok || !result.ok) {
      const code = Number(result.error_code || response.status);
      const reason = code === 401 ? 'telegram_rejected_bot_token'
        : code === 400 ? 'telegram_rejected_webhook_configuration'
        : 'telegram_rejected_request';
      const detail = String(result.description || '').replaceAll(token, '[redacted]').replaceAll(secret, '[redacted]').slice(0, 160);\n      return respond(res, 502, { ok: false, reason, error_code: code, detail });
    }
    return respond(res, 200, { ok: true, webhook: true });
  } catch {
    return respond(res, 502, { ok: false, reason: 'telegram_request_failed' });
  }
};
