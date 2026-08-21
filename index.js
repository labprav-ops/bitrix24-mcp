import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { checkAndCall } = require("./guard.cjs");
// URL входящего вебхука из Битрикс24, например:
// https://your-portal.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// Необязательный секрет для защиты самого MCP-сервера от чужих запросов.
// Если задан, клиент должен передать его в заголовке X-MCP-Secret.
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET;

if (!BITRIX_WEBHOOK_URL) {
  console.error("Не задана переменная окружения BITRIX_WEBHOOK_URL");
  process.exit(1);
}

/** Универсальный вызов метода REST API Битрикс24 через вебхук. */
async function bitrixCall(method, params = {}) {
  const url = `${BITRIX_WEBHOOK_URL.replace(/\/$/, "")}/${method}.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Bitrix24 error [${data.error}]: ${data.error_description || "нет описания"}`);
  }
  return data.result;
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function createServer() {
  const server = new McpServer({ name: "bitrix24-connector", version: "1.0.0" });

  // --- Универсальный инструмент: любой метод REST API ---
  server.tool(
    "bitrix_call",
    "Вызвать любой метод REST API Битрикс24 напрямую. Используй, когда нужного метода нет среди других инструментов. Список методов: https://apidocs.bitrix24.ru/",
    {
      method: z.string().describe("Название метода, например crm.deal.list, crm.contact.update, tasks.task.add"),
      params: z.record(z.any()).optional().describe("Параметры метода в виде объекта"),
    },
    async ({ method, params }) => textResult(await bitrixCall(method, params || {}))
  );

  // --- Сделки ---
  server.tool(
    "list_deals",
    "Получить список сделок CRM с фильтром",
    {
      filter: z.record(z.any()).optional(),
      select: z.array(z.string()).optional(),
    },
    async ({ filter, select }) =>
      textResult(
        await bitrixCall("crm.deal.list", {
          filter: filter || {},
          select: select || ["ID", "TITLE", "STAGE_ID", "OPPORTUNITY", "CURRENCY_ID", "DATE_CREATE", "CONTACT_ID"],
        })
      )
  );

  server.tool("get_deal", "Получить одну сделку по ID", { id: z.number() }, async ({ id }) =>
    textResult(await bitrixCall("crm.deal.get", { id }))
  );

  server.tool(
    "create_deal",
    "Создать новую сделку в CRM",
    { fields: z.record(z.any()).describe("Например: {TITLE, STAGE_ID, OPPORTUNITY, CONTACT_ID}") },
    async ({ fields }) => {
      const id = await bitrixCall("crm.deal.add", { fields });
      return textResult(`Создана сделка, ID: ${id}`);
    }
  );

  server.tool(
    "update_deal",
    "Изменить существующую сделку",
    { id: z.number(), fields: z.record(z.any()) },
    async ({ id, fields }) => {
      const ok = await bitrixCall("crm.deal.update", { id, fields });
      return textResult(`Сделка ${id} обновлена: ${ok}`);
    }
  );

  // --- Контакты ---
  server.tool(
    "list_contacts",
    "Получить список контактов CRM с фильтром",
    { filter: z.record(z.any()).optional(), select: z.array(z.string()).optional() },
    async ({ filter, select }) =>
      textResult(
        await bitrixCall("crm.contact.list", {
          filter: filter || {},
          select: select || ["ID", "NAME", "LAST_NAME", "PHONE", "EMAIL", "COMPANY_ID"],
        })
      )
  );

  server.tool(
    "create_contact",
    "Создать новый контакт в CRM",
    { fields: z.record(z.any()) },
    async ({ fields }) => {
      const id = await bitrixCall("crm.contact.add", { fields });
      return textResult(`Создан контакт, ID: ${id}`);
    }
  );

  server.tool(
    "update_contact",
    "Изменить существующий контакт",
    { id: z.number(), fields: z.record(z.any()) },
    async ({ id, fields }) => {
      const ok = await bitrixCall("crm.contact.update", { id, fields });
      return textResult(`Контакт ${id} обновлён: ${ok}`);
    }
  );

  // --- Лиды ---
  server.tool(
    "list_leads",
    "Получить список лидов CRM с фильтром",
    { filter: z.record(z.any()).optional(), select: z.array(z.string()).optional() },
    async ({ filter, select }) =>
      textResult(
        await bitrixCall("crm.lead.list", {
          filter: filter || {},
          select: select || ["ID", "TITLE", "STATUS_ID", "NAME", "LAST_NAME", "PHONE", "EMAIL"],
        })
      )
  );

  server.tool("create_lead", "Создать новый лид в CRM", { fields: z.record(z.any()) }, async ({ fields }) => {
    const id = await bitrixCall("crm.lead.add", { fields });
    return textResult(`Создан лид, ID: ${id}`);
  });

  server.tool(
    "update_lead",
    "Изменить существующий лид",
    { id: z.number(), fields: z.record(z.any()) },
    async ({ id, fields }) => {
      const ok = await bitrixCall("crm.lead.update", { id, fields });
      return textResult(`Лид ${id} обновлён: ${ok}`);
    }
  );

  // --- Задачи ---
  server.tool(
    "list_tasks",
    "Получить список задач с фильтром",
    { filter: z.record(z.any()).optional() },
    async ({ filter }) => textResult(await bitrixCall("tasks.task.list", { filter: filter || {} }))
  );

  server.tool(
    "create_task",
    "Создать новую задачу",
    { fields: z.record(z.any()).describe("Например: {TITLE, RESPONSIBLE_ID, DEADLINE, DESCRIPTION}") },
    async ({ fields }) => {
      const result = await bitrixCall("tasks.task.add", { fields });
      return textResult(`Создана задача: ${JSON.stringify(result)}`);
    }
  );

  server.tool(
    "update_task",
    "Изменить существующую задачу",
    { taskId: z.number(), fields: z.record(z.any()) },
    async ({ taskId, fields }) => {
      const result = await bitrixCall("tasks.task.update", { taskId, fields });
      return textResult(`Задача ${taskId} обновлена: ${JSON.stringify(result)}`);
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  if (MCP_SHARED_SECRET && req.header("X-MCP-Secret") !== MCP_SHARED_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bitrix24 MCP сервер запущен на порту ${PORT}`);
});
