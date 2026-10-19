const fs = require('node:fs/promises');
const path = require('node:path');
const { formidable } = require('formidable');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');

const MAX_FILE_SIZE = 4 * 1024 * 1024;
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
  const experienceIndex = lines.findIndex((line) => /^(?:опыт работы|опыт|work experience|employment history)\s*$/i.test(line));
  const experienceLines = experienceIndex >= 0 ? lines.slice(experienceIndex + 1, experienceIndex + 12) : lines;
  const positionPattern = /(?:^|\s)(?:директор|руководител|начальник|заведующ|менеджер|специалист|инженер|бухгалтер|экономист|юрист|маркетолог|рекрутер|hr|программист|разработчик|аналитик|администратор|оператор|водитель|повар|технолог|мастер|супервайзер|координатор|ассистент|секретарь|кладовщик|логист|снабжен|продавец|кассир|механик|электрик|сварщик)\w*/i;
  const datePattern = /(?:19|20)\d{2}|настоящее время|по настоящее|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр/i;

  let position = labeled('должность|позиция|желаемая должность|профессия');
  if (!position) {
    position = experienceLines.find((line) =>
      positionPattern.test(line) &&
      !/обязанност|навык|резюме|ваканси|желаем/i.test(line) &&
      !datePattern.test(line) &&
      line.length <= 140
    ) || '';
  }

  let company = labeled('компания|место работы|работодатель|организация');
  if (!company) {
    company = experienceLines.find((line) =>
      /^(?:тоо|ао|ип|ооо|оао|зао|ргп|гкп|кгу|тд|тк|llp|ltd|inc\.?|company)(?:\s|$)/i.test(line) &&
      !positionPattern.test(line) &&
      !datePattern.test(line) &&
      line.length <= 180
    ) || '';
  }
  if (!company && position) {
    const positionIndex = experienceLines.indexOf(position);
    const previousLine = positionIndex > 0 ? experienceLines[positionIndex - 1] : '';
    if (previousLine && !datePattern.test(previousLine) && previousLine !== fullName && previousLine.length <= 180) {
      company = previousLine;
    }
  }
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
    position: clean(position, 250),
    company: clean(company, 250),
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

function findCustomField(fields, matcher, allowedTypes = []) {
  for (const [code, meta] of Object.entries(fields || {})) {
    if (!/^UF_CRM_/i.test(code)) continue;
    const labels = [meta.title, meta.formLabel, meta.listLabel, meta.filterLabel]
      .filter(Boolean)
      .map(normalized);
    const typeAllowed = !allowedTypes.length || allowedTypes.includes(meta.type);
    if (typeAllowed && labels.some(matcher)) return code;
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
  const cityField = findField(fields, (label) => label.includes('город')) || 'UF_CRM_1782804573';
  const cityFieldType = fields[cityField]?.type || '';
  let cityItems = fields[cityField]?.items || [];

  if (!cityItems.length) {
    const legacyFields = await bitrix('crm.contact.userfield.list', {
      filter: { FIELD_NAME: cityField }
    });
    const legacyCity = (legacyFields || []).find((field) => field.FIELD_NAME === cityField);
    cityItems = legacyCity?.LIST || [];
  }

  const cityOptions = Object.fromEntries(
    cityItems
      .map((item) => [
        normalized(item.VALUE || item.value || item.NAME || item.name),
        item.ID || item.id || item.VALUE_ID || item.valueId
      ])
      .filter(([label, id]) => label && id)
  );

  return {
    typeId: candidate.STATUS_ID,
    resumeField: findField(fields, (label) => label.includes('резюме'), 'file') || 'UF_CRM_1782883151542',
    cityField,
    cityFieldType,
    cityOptions,
    educationField: findCustomField(fields, (label) => label.includes('образован')),
    companyField: findCustomField(
      fields,
      (label) => label === 'компания' || label.includes('место работы') || label.includes('работодатель'),
      ['string', 'text']
    )
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

function multifields(data) {
  const fm = {};
  let index = 0;
  if (data.phone) fm[`n${index++}`] = { typeId: 'PHONE', valueType: 'MOBILE', value: data.phone };
  if (data.email) fm[`n${index++}`] = { typeId: 'EMAIL', valueType: 'WORK', value: data.email };
  return fm;
}

async function saveCandidate(data, filename, buffer) {
  const config = await getContactConfiguration();
  let duplicateId = await findDuplicate(data.phone, data.email);
  let current = null;

  if (duplicateId) {
    current = await bitrix('crm.item.get', {
      entityTypeId: 3,
      id: duplicateId,
      useOriginalUfNames: 'Y'
    });

    // Не превращаем контакт клиента в кандидата при совпадении телефона или e-mail.
    if (String(current.item?.typeId || '') !== String(config.typeId)) {
      duplicateId = 0;
      current = null;
    }
  }

  const fields = {
    name: data.first_name || 'Кандидат',
    lastName: data.last_name,
    secondName: data.middle_name,
    post: data.position,
    typeId: config.typeId,
    opened: 'N',
    sourceDescription: data.company
      ? `Резюме загружено через сайт Imena.kz. Компания по резюме: ${data.company}`
      : 'Резюме загружено через сайт Imena.kz',
    [config.resumeField]: [filename, buffer.toString('base64')]
  };

  if (config.companyField && data.company) fields[config.companyField] = data.company;
  if (config.cityField && data.city) {
    const cityKey = normalized(data.city).replace(/^г\.?\s*/, '');
    const cityEntry = Object.entries(config.cityOptions || {}).find(
      ([label]) => label === cityKey || cityKey.includes(label) || label.includes(cityKey)
    );
    if (cityEntry) fields[config.cityField] = cityEntry[1];
    else if (!['enumeration', 'list'].includes(config.cityFieldType)) fields[config.cityField] = data.city;
  }
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

  if (normalized(current.item?.sourceDescription).includes('резюме загружено через сайт imena.kz')) {
    fields.companyId = 0;
  }
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
    const fieldValue = (name) => clean(fields[name]?.[0] || fields[name]);
    const submitted = {
      first_name: fieldValue('first_name'),
      last_name: fieldValue('last_name'),
      position: fieldValue('position'),
      city: fieldValue('city')
    };

    if (Object.values(submitted).some((value) => !value)) {
      return reply(res, 400, { ok: false, message: 'Заполните имя, фамилию, должность и город.' });
    }

    const data = Object.fromEntries(
      Object.entries({ ...parsed, ...submitted }).map(([key, value]) => [key, clean(value)])
    );
    if (!data.phone && !data.email) {
      return reply(res, 422, { ok: false, message: 'В резюме не найден телефон или e-mail.' });
    }

    const result = await saveCandidate(data, uploadedFile.originalFilename || 'resume.pdf', buffer);
    console.log('resume upload succeeded', { contactId: result.id, action: result.action });
    return reply(res, 200, {
      ok: true,
      message: 'Резюме загружено. Спасибо!',
      contactId: result.id,
      action: result.action,
      detectedFields: Object.keys(data).filter((key) => Boolean(data[key]))
    });
  } catch (error) {
    console.error('resume upload failed', String(error.message || error));
    const errorText = String(error.message || error);
    const userMessage = errorText.includes('maxFileSize')
      ? 'Файл слишком большой. Максимальный размер — 4 МБ.'
      : errorText.includes('CANDIDATE_TYPE_NOT_FOUND')
        ? 'В Bitrix24 не найден тип контакта «Кандидат».'
        : errorText.includes('BITRIX_ERROR')
          ? 'Bitrix24 временно не принял резюме. Попробуйте ещё раз.'
          : 'Не удалось обработать резюме. Попробуйте ещё раз или свяжитесь с нами.';
    return reply(res, 500, { ok: false, message: userMessage });
  } finally {
    if (uploadedFile?.filepath) fs.unlink(uploadedFile.filepath).catch(() => {});
  }
};
