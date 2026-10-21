function reply(res, status, payload) {
  return res.status(status).setHeader('Cache-Control', 'no-store').json(payload);
}

function clean(value, max = 250) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { ok: false, message: 'Метод не поддерживается.' });
  }

  const webhook = String(process.env.BITRIX_WEBHOOK || process.env.BITRIX_WEBHOOK_URL || '').replace(/\\/+$/, '');
  if (!webhook) {
    return reply(res, 503, { ok: false, message: 'Интеграция с Bitrix24 не настроена.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const name = clean(body.name, 100);
    const surname = clean(body.surname, 100);
    const position = clean(body.position, 150);
    const company = clean(body.company, 150);
    const phone = clean(body.phone, 50);
    const service = clean(body.service, 180);
    const consent = clean(body.consent, 10);

    if (!name || !surname || !phone || !['on', 'yes'].includes(consent)) {
      return reply(res, 400, { ok: false, message: 'Заполните имя, фамилию, телефон и подтвердите согласие.' });
    }

    const fields = {
      TITLE: `Заявка с сайта ИМЕНА: ${service || 'Консультация'}`,
      NAME: name,
      LAST_NAME: surname,
      POST: position,
      COMPANY_TITLE: company,
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
      SOURCE_ID: 'WEB',
      SOURCE_DESCRIPTION: `Заявка через imena.kz. Услуга: ${service || 'Консультация'}`,
      OPENED: 'N'
    };
    const response = await fetch(`${webhook}/crm.lead.add.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const result = await response.json();

    if (!response.ok || result.error || !result.result) {
      console.error('Bitrix lead creation failed', result.error || response.status);
      return reply(res, 502, { ok: false, message: 'Bitrix24 не принял заявку. Проверьте настройки интеграции.' });
    }

    console.log('website lead created', { leadId: result.result });
    return reply(res, 200, { ok: true, id: result.result, message: `Заявка отправлена в Bitrix24. Номер: ${result.result}.` });
  } catch (error) {
    console.error('Website lead submission failed', error.message);
    return reply(res, 500, { ok: false, message: 'Не удалось отправить заявку. Попробуйте ещё раз.' });
  }
};
