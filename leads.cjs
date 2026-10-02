/**
 * Личные ключи с полными правами (Корнел, Дилноза).
 *
 * Настройка на сервере — одна переменная окружения:
 *   LEAD_KEYS="kornel:КЛЮЧ1,dilnoza:КЛЮЧ2"
 *
 * Коннектор в Claude:
 *   https://<сервер>/mcp-lead?key=КЛЮЧ1   — Корнел
 *   https://<сервер>/mcp-lead?key=КЛЮЧ2   — Дилноза
 *
 * Права — как у админского /mcp (тот же вебхук, без guard).
 * Каждый вызов, который что-то меняет, пишется в журнал LEAD_LOG
 * (по умолчанию ./lead.log, если папка только для чтения — в /tmp).
 * Сотрудники журнал не видят: он есть только на сервере.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function parseKeys(raw) {
  const map = new Map();
  for (const part of String(raw || "").split(",")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    const who = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    if (who && key.length >= 16) map.set(key, who);
  }
  return map;
}

const KEYS = parseKeys(process.env.LEAD_KEYS);

function pickLogFile() {
  const candidates = [
    process.env.LEAD_LOG,
    path.join(process.cwd(), "lead.log"),
    path.join(os.tmpdir(), "lead.log"),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      fs.appendFileSync(f, "");
      return f;
    } catch (_) {}
  }
  return null;
}
const LOG_FILE = pickLogFile();

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log("[LEAD]", line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch (_) {}
  }
}

/** Сравнение без утечки по времени. */
function whoByKey(given) {
  if (!given) return null;
  const g = Buffer.from(String(given));
  for (const [key, who] of KEYS) {
    const k = Buffer.from(key);
    if (k.length === g.length && crypto.timingSafeEqual(k, g)) return who;
  }
  return null;
}

const READ_RE = /\.(get|list|fields|getlist|getchildren|search)$|^(profile|user\.get|user\.search)$/i;

/** Оборачивает вызов Битрикса: всё, что не чтение, пишется в журнал. */
function wrapCall(call, who) {
  return async function (method, params = {}) {
    const isRead = READ_RE.test(String(method));
    if (!isRead) {
      log({ who, event: "CALL", method, params: JSON.stringify(params).slice(0, 2000) });
    }
    try {
      const res = await call(method, params);
      if (!isRead) log({ who, event: "DONE", method });
      return res;
    } catch (e) {
      if (!isRead) log({ who, event: "ERROR", method, error: String(e && e.message) });
      throw e;
    }
  };
}

/**
 * Подключение маршрута. В index.js после app.post("/mcp", ...) добавить:
 *
 *   require("./leads.cjs").mount(app, { getSecret, handleMcpRequest, adminBitrixCall });
 */
function mount(app, { getSecret, handleMcpRequest, adminBitrixCall }) {
  app.post("/mcp-lead", async (req, res) => {
    if (KEYS.size === 0) {
      res.status(503).json({ error: "LEAD_KEYS not configured" });
      return;
    }
    const who = whoByKey(getSecret(req));
    if (!who) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      await handleMcpRequest(req, res, {
        call: wrapCall(adminBitrixCall, who),
        serverName: "bitrix24-lead-" + who,
        isStaff: false,
      });
    } catch (e) {
      log({ who, event: "SERVER_ERROR", error: String(e && e.message) });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
  console.log(`[LEAD] /mcp-lead: ключей ${KEYS.size}, журнал ${LOG_FILE || "только консоль"}`);
}

module.exports = { mount, parseKeys, wrapCall, whoByKey };
