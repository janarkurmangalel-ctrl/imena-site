const path = require('node:path');

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);
const TELEGRAM_API = 'https://api.telegram.org';

function reply(res, status, payload = { ok: true }) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseCaption(caption) {
  const labels = [
    /^(?:имя|name)\s*[:—–-]\s*/i,
    /^(?:фамилия|surname|last name)\s*[:—–-]\s*/i,
    /^(?:должность|позиция|position)\s*[:—–-]\s*/i,
    /^(?:город|city)\s*[:—–-]\s*/i
  ];
  const parts = String(caption || '')
    .split(/\s*(?:;|\|)\s*|\r?\n+/)
    .map((item) => clean(item))
    .filter(Boolean);

  if (parts.length !== 4) return null;
  const values = parts.map((part, index) => clean(part.replace(labels[index], '')));
  if (values.some((value) => !value)) return null;

  return {
    first_name: values[0],
    last_name: values[1],
    position: values[2],
    city: values[3]
  };
}

async function telegram(method, params = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`TELEGRAM_ERROR ${method}: ${payload.description || response.status}`);
  }
  return payload.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra
  });
}

async function editMessage(chatId, messageId, text) {
  return telegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true
  });
}

async function downloadTelegramFile(document) {
  const file = await telegram('getFile', { file_id: document.file_id });
  const response = await fetch(`${TELEGRAM_API}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error(`TELEGRAM_FILE_ERROR: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function instructions() {
  return [
    'Резюме в базу «Имена»',
    '',
    'Отправьте резюме одним сообщением в формате PDF или DOCX.',
    'В подписи к файлу укажите через точку с запятой:',
    '',
    'Имя; Фамилия; Должность; Город',
    '',
    'Пример:',
    'Сауле; Жургунова; HR-менеджер; Астана',
    '',
    'Перед передачей данных в CRM бот покажет информацию и запросит ваше согласие.'
  ].join('\n');
}

async function handleDocument(message) {
  const chatId = message.chat.id;
  const document = message.document;
  const filename = clean(document.file_name, 180) || 'resume.pdf';
  const extension = path.extname(filename).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return sendMessage(chatId, 'Отправьте резюме в формате PDF или DOCX.');
  }
  if (Number(document.file_size || 0) > MAX_FILE_SIZE) {
    return sendMessage(chatId, 'Файл слишком большой. Максимальный размер — 4 МБ.');
  }

  const data = parseCaption(message.caption);
  if (!data) {
    return sendMessage(chatId, [
      'Не удалось прочитать подпись к файлу.',
      '',
      'Отправьте файл ещё раз и укажите:',
      'Имя; Фамилия; Должность; Город',
      '',
      'Пример:',
      'Сауле; Жургунова; HR-менеджер; Астана'
    ].join('\n'));
  }

  const summary = [
    'Проверьте данные:',
    '',
    `Имя: ${data.first_name}`,
    `Фамилия: ${data.last_name}`,
    `Должность: ${data.position}`,
    `Город: ${data.city}`,
    `Файл: ${filename}`,
    '',
    'Нажимая «Согласен(на), отправить», вы соглашаетесь на обработку персональных данных и добавление резюме в базу кандидатов HR-агентства «Имена».'
  ].join('\n');

  return sendMessage(chatId, summary, {
    reply_parameters: { message_id: message.message_id },
    reply_markup: {
      inline_keyboard: [[
        { text: 'Согласен(на), отправить', callback_data: 'resume_confirm' },
        { text: 'Отмена', callback_data: 'resume_cancel' }
      ]]
    }
  });
}

async function submitResume(callback) {
  const botMessage = callback.message;
  const original = botMessage?.reply_to_message;
  const chatId = botMessage?.chat?.id;
  const messageId = botMessage?.message_id;

  if (!original?.document || Number(original.from?.id) !== Number(callback.from?.id)) {
    return editMessage(chatId, messageId, 'Сессия устарела. Отправьте резюме повторно командой /start.');
  }

  const data = parseCaption(original.caption);
  if (!data) {
    return editMessage(chatId, messageId, 'Не удалось прочитать данные. Отправьте резюме повторно командой /start.');
  }

  await telegram('answerCallbackQuery', {
    callback_query_id: callback.id,
    text: 'Загружаем резюме…'
  });

  const document = original.document;
  const filename = clean(document.file_name, 180) || 'resume.pdf';
  const buffer = await downloadTelegramFile(document);
  if (buffer.length > MAX_FILE_SIZE) throw new Error('FILE_TOO_LARGE');

  const form = new FormData();
  form.set('first_name', data.first_name);
  form.set('last_name', data.last_name);
  form.set('position', data.position);
  form.set('city', data.city);
  form.set('consent', 'yes');
  form.set('source', callback.from?.username ? `Telegram @${callback.from.username}` : 'Telegram');
  form.set('resume', new Blob([buffer]), filename);

  const siteRoot = String(process.env.PUBLIC_SITE_URL || 'https://imena.kz').replace(/\/+$/, '');
  const response = await fetch(`${siteRoot}/api/resume`, {
    method: 'POST',
    body: form
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(result.message || `RESUME_API_ERROR ${response.status}`);
  }

  return editMessage(chatId, messageId, [
    'Готово!',
    '',
    'Ваше резюме добавлено в базу кандидатов HR-агентства «Имена».',
    `Номер карточки: ${result.contactId}`,
    '',
    'Мы свяжемся с вами, когда появится подходящая вакансия.'
  ].join('\n'));
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  if (callback.data === 'resume_cancel') {
    await telegram('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Отправка отменена'
    });
    return editMessage(chatId, messageId, 'Отправка отменена. Чтобы начать заново, отправьте /start.');
  }

  if (callback.data === 'resume_confirm') {
    try {
      return await submitResume(callback);
    } catch (error) {
      console.error('telegram resume submission failed', String(error.message || error));
      await telegram('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Не удалось загрузить резюме'
      }).catch(() => {});
      return editMessage(chatId, messageId, [
        'Не удалось загрузить резюме.',
        'Пожалуйста, отправьте файл повторно командой /start или загрузите его на сайте https://imena.kz.'
      ].join('\n'));
    }
  }

  return telegram('answerCallbackQuery', { callback_query_id: callback.id });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { ok: false });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET) {
    return reply(res, 503, { ok: false, message: 'Telegram integration is not configured.' });
  }

  const receivedSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (receivedSecret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return reply(res, 401, { ok: false });
  }

  const update = req.body || {};
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message?.document) {
      await handleDocument(update.message);
    } else if (update.message?.text) {
      const text = clean(update.message.text);
      if (/^\/(?:start|help)(?:@\w+)?/i.test(text)) {
        await sendMessage(update.message.chat.id, instructions());
      } else {
        await sendMessage(update.message.chat.id, 'Чтобы добавить резюме, отправьте /start.');
      }
    }
  } catch (error) {
    console.error('telegram webhook failed', String(error.message || error));
    if (update.message?.chat?.id) {
      await sendMessage(update.message.chat.id, 'Произошла ошибка. Попробуйте ещё раз командой /start.').catch(() => {});
    }
  }

  return reply(res, 200, { ok: true });
};
