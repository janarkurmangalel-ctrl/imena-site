const fs = require('node:fs/promises');
const path = require('node:path');
const { formidable } = require('formidable');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);

function reply(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalized(value) {
  return clean(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

async function extractText(file) {
  const buffer = await fs.readFile(file.filepath);
  const extension = path.extname(file.originalFilename || '').toLowerCase();

  if (extension === '.pdf') {
    const result = await pdf(buffer);
    return { buffer, text: result.text || '' };
  }

  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { buffer, text: result.value || '' };
  }

  throw new Error('UNSUPPORTED_FILE');
}

function responseText(payload) {
  for (const item of payload.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) return part.text;
    }
  }
  return '';
}

function localResumeParse(text) {
  const rawText = String(text || '');
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => clean(line, 1000))
    .filter(Boolean);

  const labeled = (pattern) => {
    const expression = new RegExp('^(?:' + pattern + ')\\s*[:—–-]\\s*(.+)$', 'i');
    for (const line of lines) {
      const match = line.match(expression);
      if (match && match[1]) return clean(match[1], 1000);
    }
    return '';
  };

  const emailMatch = rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatches = rawText.match(/(?:\+?7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/g) || [];
  const email = clean(emailMatch ? emailMatch[0] : '');
  const phone = clean(phoneMatches[0] || '');

  let fullName = labeled('фио|фамилия имя отчество|имя кандидата');
  if (!fullName) {
    fullName = lines.slice(0, 15).find((line) => {
      if (/резюме|curriculum|vitae|телефон|email|e-mail|город|должност/i.test(line)) return false;
      if (/\d|@|:/.test(line)) return false;
      const words = line.split(/\s+/);
      return words.length >= 2 && words.length <= 4 &&
        words.every((word) => /^[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z'’-]+$/.test(word));
    }) || '';
  }

  const nameParts = fullName.split(/\s+/).filter(Boolean);
  let education = labeled('образование|education');
  if (!education) {
    const index = lines.findIndex((line) => /^образование\s*$/i.test(line));
    if (index >= 0) {
      education = lines.slice(index + 1, index + 4)
        .filter((line) => !/^(опыт работы|навыки|компетенции|языки|контакты)\b/i.test(line))
        .join(', ');
    }
  }

  return {
    last_name: nameParts[0] || '',
    first_name: nameParts[1] || nameParts[0] || '',
    middle_name: nameParts.slice(2).join(' '),
    position: labeled('должность|позиция|желаемая должность|профессия'),
    company: labeled('компания|место работы|работодатель|организация'),
    city: labeled('город|г\\.|место проживания|проживание|city'),
    education: clean(education, 1000),
    phone,
    email
  };
}

async function bitrix(method, params = {}) {
  const root = String(process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
  const response = await fetch(`${root}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`BITRIX_ERROR ${method}: ${payload.error_description || payload.error || response.status}`);
  }
  return payload.result;
}

function findField(fields, matcher, requiredType) {
  for (const [code, meta] of Object.entries(fields || {})) {
    const labels = [meta.title, meta.formLabel, meta.listLabel, meta.filterLabel]
      .filter(Boolean)
      .map(normalized);
    if ((!requiredType || meta.type === requiredType) && labels.some(matcher)) return code;
  }
  return '';
}

async function getContactConfiguration() {
  const [statusRows, fieldResult] = await Promise.all([
    bitrix('crm.status.list', { filter: { ENTITY_ID: 'CONTACT_TYPE' } }),
    bitrix('crm.item.fields', { entityTypeId: 3, useOriginalUfNames: 'Y' })
  ]);

  const candidate = (statusRows || []).find((row) => normalized(row.NAME) === 'кандидат');
  if (!candidate) throw new Error('CANDIDATE_TYPE_NOT_FOUND');

  const fields = fieldResult.fields || fieldResult;
  return {
    typeId: candidate.STATUS_ID,
    resumeField: findField(fields, (labels) => labels.includes('резюме'), 'file') || 'UF_CRM_1782883151542',
    cityField: findField(fields, (labels) => labels.includes('город')),
    educationField: findField(fields, (label) => label.includes('образован'))
  };
}

async function findDuplicate(phone, email) {
  const checks = [];
  if (phone) checks.push(['PHONE', phone]);
  if (email) checks.push(['EMAIL', email]);

  for (const [type, value] of checks) {
    try {
      const result = await bitrix('crm.duplicate.findbycomm', {
        entity_type: 'CONTACT',
        type,
        values: [value]
      });
      const ids = result.CONTACT || result.contact || [];
      if (ids.length) return Number(ids[0]);
    } catch (error) {
      if (!String(error.message).includes('METHOD_NOT_FOUND')) throw error;
    }
  }

  return 0;
}

async function findOrCreateCompany(title) {
  if (!title) return 0;
  const list = await bitrix('crm.item.list', {
    entityTypeId: 4,
    select: ['id', 'title'],
    filter: { title }
  });
  const exact = (list.items || []).find((item) => normalized(item.title) === normalized(title));
  if (exact) return Number(exact.id);

  const created = await bitrix('crm.item.add', {
    entityTypeId: 4,
    fields: { title, opened: 'N' }
  });
  return Number(created.item?.id || 0);
}

function multifields(data) {
  const fm = {};
  let index = 0;
  if (data.phone) fm[`n${index++}`] = { typeId: 'PHONE', valueType: 'MOBILE', value: data.phone };
  if (data.email) fm[`n${index++}`] = { typeId: 'EMAIL', valueType: 'WORK', value: data.email };
  return fm;
}

async function saveCandidate(data, filename, buffer) {
  const config = await getContactConfiguration();
  const duplicateId = await findDuplicate(data.phone, data.email);
  const companyId = await findOrCreateCompany(data.company);

  const fields = {
    name: data.first_name || 'Кандидат',
    lastName: data.last_name,
    secondName: data.middle_name,
    post: data.position,
    typeId: config.typeId,
    opened: 'N',
    sourceDescription: 'Резюме загружено через сайт Imena.kz',
    [config.resumeField]: [filename, buffer.toString('base64')]
  };

  if (companyId) fields.companyId = companyId;
  if (config.cityField && data.city) fields[config.cityField] = data.city;
  if (config.educationField && data.education) fields[config.educationField] = data.education;

  if (!duplicateId) {
    fields.fm = multifields(data);
    const created = await bitrix('crm.item.add', {
      entityTypeId: 3,
      useOriginalUfNames: 'Y',
      fields
    });
    return { id: Number(created.item?.id), action: 'created' };
  }

  const current = await bitrix('crm.item.get', {
    entityTypeId: 3,
    id: duplicateId,
    useOriginalUfNames: 'Y'
  });
  const existing = Object.values(current.item?.fm || {});
  const additions = multifields({
    phone: data.phone && !existing.some((row) => row.typeId === 'PHONE' && normalized(row.value) === normalized(data.phone)) ? data.phone : '',
    email: data.email && !existing.some((row) => row.typeId === 'EMAIL' && normalized(row.value) === normalized(data.email)) ? data.email : ''
  });
  if (Object.keys(additions).length) fields.fm = additions;

  await bitrix('crm.item.update', {
    entityTypeId: 3,
    id: duplicateId,
    useOriginalUfNames: 'Y',
    fields
  });
  return { id: duplicateId, action: 'updated' };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { ok: false, message: 'Метод не поддерживается.' });
  }

  if (!process.env.BITRIX_WEBHOOK_URL) {
    return reply(res, 503, { ok: false, message: 'Интеграция ещё настраивается.' });
  }

  let uploadedFile;
  try {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      maxFiles: 1,
      allowEmptyFiles: false,
      filter: ({ originalFilename }) => ALLOWED_EXTENSIONS.has(path.extname(originalFilename || '').toLowerCase())
    });
    const [fields, files] = await form.parse(req);
    if (clean(fields.website?.[0] || fields.website)) return reply(res, 200, { ok: true });
    if (clean(fields.consent?.[0] || fields.consent) !== 'yes') {
      return reply(res, 400, { ok: false, message: 'Необходимо согласие на обработку персональных данных.' });
    }

    uploadedFile = Array.isArray(files.resume) ? files.resume[0] : files.resume;
    if (!uploadedFile) return reply(res, 400, { ok: false, message: 'Прикрепите резюме в формате PDF или DOCX.' });

    const { buffer, text } = await extractText(uploadedFile);
    if (clean(text).length < 80) {
      return reply(res, 422, { ok: false, message: 'Не удалось прочитать текст резюме. Загрузите PDF с текстом или файл DOCX.' });
    }

    const parsed = localResumeParse(text);
    const data = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, clean(value)]));
    if (!data.phone && !data.email) {
      return reply(res, 422, { ok: false, message: 'В резюме не найден телефон или e-mail.' });
    }

    const result = await saveCandidate(data, uploadedFile.originalFilename || 'resume.pdf', buffer);
    console.log('resume upload succeeded', { contactId: result.id, action: result.action });
    return reply(res, 200, {
      ok: true,
      message: 'Резюме загружено. Спасибо!',
      contactId: result.id,
      action: result.action
    });
  } catch (error) {
    console.error('resume upload failed', String(error.message || error));
    const userMessage = String(error.message).includes('maxFileSize')
      ? 'Файл слишком большой. Максимальный размер — 10 МБ.'
      : 'Не удалось обработать резюме. Попробуйте ещё раз или свяжитесь с нами.';
    return reply(res, 500, { ok: false, message: userMessage });
  } finally {
    if (uploadedFile?.filepath) fs.unlink(uploadedFile.filepath).catch(() => {});
  }
};
