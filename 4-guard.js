/**
 * guard.js — защитный слой между Claude и Битрикс24
 * Лаборатория правосудия, август 2026
 *
 * Правило: суммы можно только увеличивать, удалять нельзя,
 * факт оплаты откатить нельзя, ответственного менять нельзя.
 *
 * Подключение:
 *   const { checkAndCall } = require('./guard');
 *   const result = await checkAndCall(method, params, userId);
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
const LOG_FILE = process.env.GUARD_LOG || path.join(__dirname, 'guard.log');

/* ─────────────── Настройки ─────────────── */

const LIMITS = {
  writesPerRequest: 10,        // не более N записей за один запрос
  writesPerHour: 100,          // на пользователя
  maxIncrease: 500000,         // максимальный разовый прирост суммы, ₽
  invoicesPerDay: 50,          // создание счетов
};

const INVOICE_ENTITY = 31;
const PAID_STAGE = 'DT31_3:P';

/* Методы только для чтения */
const READ_METHODS = new Set([
  'crm.deal.get', 'crm.deal.list', 'crm.deal.fields',
  'crm.item.get', 'crm.item.list', 'crm.item.fields',
  'crm.contact.get', 'crm.contact.list',
  'crm.company.get', 'crm.company.list',
  'crm.activity.list', 'crm.timeline.comment.list',
  'crm.dealcategory.list', 'crm.category.list', 'crm.status.list',
  'user.get', 'profile',
]);

/* Методы записи — всё, чего здесь нет, запрещено */
const WRITE_METHODS = new Set([
  'crm.timeline.comment.add',
  'crm.activity.add',
  'crm.deal.update',
  'crm.item.add',
  'crm.item.update',
  'crm.contact.add',
  'crm.contact.update',
]);

/* Разрешённые к изменению поля */
const ALLOWED_FIELDS = {
  'crm.deal.update':    ['STAGE_ID', 'COMMENTS', 'CLOSEDATE', 'OPPORTUNITY'],
  'crm.item.update':    ['opportunity', 'stageId'],
  'crm.contact.update': ['NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL', 'COMMENTS'],
};

/* Поля, которые нельзя менять никогда — даже если попали в разрешённые */
const FORBIDDEN_FIELDS = new Set([
  'ASSIGNED_BY_ID', 'assignedById',   // ответственный влияет на зарплату
  'CREATED_BY_ID', 'createdBy',
  'CATEGORY_ID', 'categoryId',        // перенос между воронками
]);

/* ─────────────── Счётчики лимитов ─────────────── */

const counters = new Map();   // userId -> { hour: [ts], day: [ts] }

function touchCounter(userId, kind) {
  const now = Date.now();
  const c = counters.get(userId) || { hour: [], day: [] };
  const windowMs = kind === 'day' ? 86400000 : 3600000;
  c[kind] = c[kind].filter(t => now - t < windowMs);
  c[kind].push(now);
  counters.set(userId, c);
  return c[kind].length;
}

function peekCounter(userId, kind) {
  const now = Date.now();
  const c = counters.get(userId);
  if (!c) return 0;
  const windowMs = kind === 'day' ? 86400000 : 3600000;
  return c[kind].filter(t => now - t < windowMs).length;
}

/* ─────────────── Журнал ─────────────── */

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { console.error('log fail', e.message); }
  console.log('[guard]', line.trim());
}

/* ─────────────── Вызов Битрикса ─────────────── */

async function bitrix(method, params = {}) {
  if (!WEBHOOK) throw new Error('BITRIX_WEBHOOK_URL не задан в переменных окружения');
  const res = await fetch(`${WEBHOOK}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description || json.error);
  return json.result;
}

/* ─────────────── Проверки ─────────────── */

function denyIfForbiddenFields(fields) {
  for (const key of Object.keys(fields || {})) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new Error(
        `Поле «${key}» нельзя менять через Claude. ` +
        `Ответственного за продажу меняет руководитель вручную.`
      );
    }
  }
}

function denyIfUnknownFields(method, fields) {
  const allowed = ALLOWED_FIELDS[method];
  if (!allowed) return;
  for (const key of Object.keys(fields || {})) {
    if (!allowed.includes(key)) {
      throw new Error(`Поле «${key}» недоступно для изменения через Claude`);
    }
  }
}

/** Правило монотонности для сумм: только вверх */
function checkMoneyIncrease(oldSum, newSum) {
  const o = parseFloat(oldSum) || 0;
  const n = parseFloat(newSum);
  if (isNaN(n)) throw new Error('Сумма должна быть числом');
  if (n < o) {
    throw new Error(
      `Уменьшать сумму нельзя: ${o.toLocaleString('ru-RU')} ₽ → ${n.toLocaleString('ru-RU')} ₽. ` +
      `Если нужен возврат — руководитель создаёт отдельный счёт «Возврат».`
    );
  }
  if (n === o) throw new Error('Сумма не изменилась — операция бессмысленна');
  if (n - o > LIMITS.maxIncrease) {
    throw new Error(
      `Прирост ${(n - o).toLocaleString('ru-RU')} ₽ превышает лимит ` +
      `${LIMITS.maxIncrease.toLocaleString('ru-RU')} ₽ за операцию. Похоже на опечатку в нулях.`
    );
  }
}

/** Правило стадий счёта: из «Оплачен» выхода нет */
function checkInvoiceStage(oldStage, newStage) {
  if (oldStage === PAID_STAGE && newStage !== PAID_STAGE) {
    throw new Error('Нельзя откатить оплаченный счёт. Факт оплаты не отменяется задним числом.');
  }
}

/** Правило стадий сделки */
async function checkDealStage(dealId, newStage) {
  const deal = await bitrix('crm.deal.get', { id: dealId });
  const sem = deal.STAGE_SEMANTIC_ID;
  if (sem === 'S' && !String(newStage).includes('WON')) {
    throw new Error('Нельзя вывести сделку из статуса «Успешна»');
  }
  if (sem === 'F' && String(newStage).includes('WON')) {
    throw new Error('Нельзя перевести проваленную сделку в успешную — это накрутка результата');
  }
  return deal;
}

/* ─────────────── Главная функция ─────────────── */

async function checkAndCall(method, params = {}, userId = 'unknown') {
  const isRead = READ_METHODS.has(method);
  const isWrite = WRITE_METHODS.has(method);

  /* 1. Белый список методов */
  if (!isRead && !isWrite) {
    log({ userId, method, verdict: 'DENY', reason: 'method not allowed' });
    if (/\.delete$/.test(method)) {
      throw new Error('Удаление запрещено. Данные в Битриксе не удаляются через Claude.');
    }
    throw new Error(`Метод «${method}» недоступен через Claude`);
  }

  /* 2. Чтение проходит без дальнейших проверок */
  if (isRead) {
    const result = await bitrix(method, params);
    return result;
  }

  /* 3. Лимиты на запись */
  if (peekCounter(userId, 'hour') >= LIMITS.writesPerHour) {
    log({ userId, method, verdict: 'DENY', reason: 'hourly limit' });
    throw new Error(`Достигнут лимит ${LIMITS.writesPerHour} изменений в час`);
  }

  /* 4. Проверки полей */
  const fields = params.fields || params;
  denyIfForbiddenFields(fields);
  denyIfUnknownFields(method, fields);

  let before = null;

  /* 5. Правила по методам */
  if (method === 'crm.item.update') {
    if (params.entityTypeId !== INVOICE_ENTITY) {
      throw new Error('Через Claude доступны только счета (entityTypeId 31)');
    }
    before = await bitrix('crm.item.get', { entityTypeId: INVOICE_ENTITY, id: params.id });
    const item = before.item || before;
    if (fields.opportunity !== undefined) {
      checkMoneyIncrease(item.opportunity, fields.opportunity);
    }
    if (fields.stageId !== undefined) {
      checkInvoiceStage(item.stageId, fields.stageId);
    }
  }

  if (method === 'crm.deal.update') {
    if (fields.OPPORTUNITY !== undefined) {
      const deal = await bitrix('crm.deal.get', { id: params.id });
      before = deal;
      checkMoneyIncrease(deal.OPPORTUNITY, fields.OPPORTUNITY);
    }
    if (fields.STAGE_ID !== undefined) {
      before = before || await checkDealStage(params.id, fields.STAGE_ID);
    }
  }

  if (method === 'crm.item.add') {
    if (params.entityTypeId !== INVOICE_ENTITY) {
      throw new Error('Создавать через Claude можно только счета');
    }
    if (peekCounter(userId, 'day') >= LIMITS.invoicesPerDay) {
      throw new Error(`Достигнут лимит ${LIMITS.invoicesPerDay} новых счетов в сутки`);
    }
    const sum = parseFloat(fields.opportunity) || 0;
    if (sum <= 0) throw new Error('Сумма нового счёта должна быть больше нуля');
    if (sum > LIMITS.maxIncrease) {
      throw new Error(`Сумма счёта превышает лимит ${LIMITS.maxIncrease.toLocaleString('ru-RU')} ₽`);
    }
    if (/возврат|refund/i.test(fields.title || '')) {
      throw new Error('Счета «Возврат» создаёт только руководитель вручную');
    }
    touchCounter(userId, 'day');
  }

  /* 6. Пишем в журнал ДО выполнения */
  log({
    userId, method, verdict: 'ALLOW',
    id: params.id,
    before: before ? JSON.stringify(before).slice(0, 500) : null,
    fields: JSON.stringify(fields).slice(0, 500),
  });

  /* 7. Выполняем */
  touchCounter(userId, 'hour');
  try {
    const result = await bitrix(method, params);
    log({ userId, method, verdict: 'DONE', id: params.id, result: JSON.stringify(result).slice(0, 300) });
    return result;
  } catch (e) {
    log({ userId, method, verdict: 'ERROR', id: params.id, error: e.message });
    throw e;
  }
}

/* Пакетный вызов с лимитом на количество */
async function checkAndCallBatch(calls = [], userId = 'unknown') {
  if (calls.length > LIMITS.writesPerRequest) {
    log({ userId, verdict: 'DENY', reason: `batch ${calls.length} > ${LIMITS.writesPerRequest}` });
    throw new Error(
      `За один раз можно изменить не более ${LIMITS.writesPerRequest} записей. ` +
      `Запрошено ${calls.length}.`
    );
  }
  const out = [];
  for (const c of calls) {
    try {
      out.push({ ok: true, result: await checkAndCall(c.method, c.params, userId) });
    } catch (e) {
      out.push({ ok: false, error: e.message });
    }
  }
  return out;
}

/* Ловим необработанные отказы промисов — иначе процесс падает,
   как это происходило на сервере 18 августа */
process.on('unhandledRejection', (reason) => {
  log({ verdict: 'CRASH_PREVENTED', error: String(reason && reason.message || reason) });
});
process.on('uncaughtException', (err) => {
  log({ verdict: 'CRASH_PREVENTED', error: String(err && err.message || err) });
});

module.exports = { checkAndCall, checkAndCallBatch, LIMITS, READ_METHODS, WRITE_METHODS };
