import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { checkAndCall } = require("./guard.cjs");

/*
 * ДВА КАНАЛА ДОСТУПА:
 *
 * /mcp
 *   → личный Claude
 *   → полный админский вебхук
 *
 * /mcp-staff
 *   → Claude сотрудников
 *   → ЛП Ассистент
 *   → guard.cjs
 */

// Вебхук ЛП Ассистента.
// Его же использует guard.cjs через process.env.BITRIX_WEBHOOK_URL.
const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// Твой личный админский вебхук с полными правами.
const BITRIX_ADMIN_WEBHOOK_URL = process.env.BITRIX_ADMIN_WEBHOOK_URL;

// Существующий секрет твоего личного MCP.
// Оставляем прежнее имя, чтобы не ломать текущее подключение.
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET;

// Отдельный секрет для MCP сотрудников.
const MCP_STAFF_SHARED_SECRET = process.env.MCP_STAFF_SHARED_SECRET;

if (!BITRIX_WEBHOOK_URL) {
  console.error("Не задан BITRIX_WEBHOOK_URL (вебхук ЛП Ассистента)");
  process.exit(1);
}

if (!BITRIX_ADMIN_WEBHOOK_URL) {
  console.error("Не задан BITRIX_ADMIN_WEBHOOK_URL (админский вебхук)");
  process.exit(1);
}

/**
 * ПОЛНЫЙ ДОСТУП.
 * Используется только твоим личным Claude через /mcp.
 */
async function adminBitrixCall(method, params = {}) {
  const url =
    `${BITRIX_ADMIN_WEBHOOK_URL.replace(/\/+$/, "")}/${method}.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(
      `Bitrix24 error [${data.error}]: ${
        data.error_description || "нет описания"
      }`
    );
  }

  return data.result;
}

/**
 * ОГРАНИЧЕННЫЙ ДОСТУП.
 * Все обращения сотрудников проходят через guard.cjs.
 */
async function staffBitrixCall(method, params = {}) {
  return await checkAndCall(method, params, "staff");
}

function textResult(value) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

/**
 * Создаёт MCP-сервер.
 *
 * bitrixCall — функция доступа:
 * adminBitrixCall или staffBitrixCall.
 *
 * isStaff — меняет описание универсального инструмента,
 * чтобы сотрудникам не обещать безграничный API.
 */
function createServer(
  bitrixCall,
  {
    name = "bitrix24-connector",
    isStaff = false,
  } = {}
) {
  const server = new McpServer({
    name,
    version: "2.0.0",
  });

  // --------------------------------------------------
  // УНИВЕРСАЛЬНЫЙ ВЫЗОВ
  // --------------------------------------------------

  server.tool(
    "bitrix_call",
    isStaff
      ? "Вызвать разрешённый метод REST API Битрикс24 через защищённый серверный слой. Запрещённые методы и изменения будут отклонены."
      : "Вызвать любой метод REST API Битрикс24 напрямую. Используй, когда нужного метода нет среди других инструментов.",
    {
      method: z
        .string()
        .describe(
          "Название метода, например crm.deal.list, crm.contact.update"
        ),

      params: z
        .record(z.any())
        .optional()
        .describe("Параметры метода в виде объекта"),
    },
    async ({ method, params }) =>
      textResult(
        await bitrixCall(method, params || {})
      )
  );

  // --------------------------------------------------
  // СДЕЛКИ
  // --------------------------------------------------

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
          select:
            select || [
              "ID",
              "TITLE",
              "STAGE_ID",
              "OPPORTUNITY",
              "CURRENCY_ID",
              "DATE_CREATE",
              "CONTACT_ID",
            ],
        })
      )
  );

  server.tool(
    "get_deal",
    "Получить одну сделку по ID",
    {
      id: z.number(),
    },
    async ({ id }) =>
      textResult(
        await bitrixCall("crm.deal.get", {
          id,
        })
      )
  );

  server.tool(
    "create_deal",
    isStaff
      ? "Создать сделку, если операция разрешена политикой безопасности сервера"
      : "Создать новую сделку в CRM",
    {
      fields: z
        .record(z.any())
        .describe(
          "Например: {TITLE, STAGE_ID, OPPORTUNITY, CONTACT_ID}"
        ),
    },
    async ({ fields }) => {
      const id = await bitrixCall(
        "crm.deal.add",
        { fields }
      );

      return textResult(
        `Создана сделка, ID: ${id}`
      );
    }
  );

  server.tool(
    "update_deal",
    isStaff
      ? "Изменить разрешённые поля сделки. Опасные изменения блокируются сервером."
      : "Изменить существующую сделку",
    {
      id: z.number(),
      fields: z.record(z.any()),
    },
    async ({ id, fields }) => {
      const ok = await bitrixCall(
        "crm.deal.update",
        {
          id,
          fields,
        }
      );

      return textResult(
        `Сделка ${id} обновлена: ${ok}`
      );
    }
  );

  // --------------------------------------------------
  // КОНТАКТЫ
  // --------------------------------------------------

  server.tool(
    "list_contacts",
    "Получить список контактов CRM с фильтром",
    {
      filter: z.record(z.any()).optional(),
      select: z.array(z.string()).optional(),
    },
    async ({ filter, select }) =>
      textResult(
        await bitrixCall("crm.contact.list", {
          filter: filter || {},
          select:
            select || [
              "ID",
              "NAME",
              "LAST_NAME",
              "PHONE",
              "EMAIL",
              "COMPANY_ID",
            ],
        })
      )
  );

  server.tool(
    "create_contact",
    "Создать новый контакт",
    {
      fields: z.record(z.any()),
    },
    async ({ fields }) => {
      const id = await bitrixCall(
        "crm.contact.add",
        { fields }
      );

      return textResult(
        `Создан контакт, ID: ${id}`
      );
    }
  );

  server.tool(
    "update_contact",
    isStaff
      ? "Изменить разрешённые поля контакта"
      : "Изменить существующий контакт",
    {
      id: z.number(),
      fields: z.record(z.any()),
    },
    async ({ id, fields }) => {
      const ok = await bitrixCall(
        "crm.contact.update",
        {
          id,
          fields,
        }
      );

      return textResult(
        `Контакт ${id} обновлён: ${ok}`
      );
    }
  );

  // --------------------------------------------------
  // ЛИДЫ
  // --------------------------------------------------

  server.tool(
    "list_leads",
    "Получить список лидов CRM с фильтром",
    {
      filter: z.record(z.any()).optional(),
      select: z.array(z.string()).optional(),
    },
    async ({ filter, select }) =>
      textResult(
        await bitrixCall("crm.lead.list", {
          filter: filter || {},
          select:
            select || [
              "ID",
              "TITLE",
              "STATUS_ID",
              "NAME",
              "LAST_NAME",
              "PHONE",
              "EMAIL",
            ],
        })
      )
  );

  server.tool(
    "create_lead",
    "Создать новый лид",
    {
      fields: z.record(z.any()),
    },
    async ({ fields }) => {
      const id = await bitrixCall(
        "crm.lead.add",
        { fields }
      );

      return textResult(
        `Создан лид, ID: ${id}`
      );
    }
  );

  server.tool(
    "update_lead",
    "Изменить существующий лид",
    {
      id: z.number(),
      fields: z.record(z.any()),
    },
    async ({ id, fields }) => {
      const ok = await bitrixCall(
        "crm.lead.update",
        {
          id,
          fields,
        }
      );

      return textResult(
        `Лид ${id} обновлён: ${ok}`
      );
    }
  );

  // --------------------------------------------------
  // ЗАДАЧИ
  // --------------------------------------------------

  server.tool(
    "list_tasks",
    "Получить список задач с фильтром",
    {
      filter: z.record(z.any()).optional(),
    },
    async ({ filter }) =>
      textResult(
        await bitrixCall("tasks.task.list", {
          filter: filter || {},
        })
      )
  );

  server.tool(
    "create_task",
    "Создать новую задачу",
    {
      fields: z
        .record(z.any())
        .describe(
          "Например: {TITLE, RESPONSIBLE_ID, DEADLINE, DESCRIPTION}"
        ),
    },
    async ({ fields }) => {
      const result = await bitrixCall(
        "tasks.task.add",
        { fields }
      );

      return textResult(
        `Создана задача: ${JSON.stringify(result)}`
      );
    }
  );

  server.tool(
    "update_task",
    "Изменить существующую задачу",
    {
      taskId: z.number(),
      fields: z.record(z.any()),
    },
    async ({ taskId, fields }) => {
      const result = await bitrixCall(
        "tasks.task.update",
        {
          taskId,
          fields,
        }
      );

      return textResult(
        `Задача ${taskId} обновлена: ${JSON.stringify(result)}`
      );
    }
  );

  return server;
}

const app = express();

app.use(express.json());

/**
 * Общий обработчик MCP-запроса.
 */
async function handleMcpRequest(
  req,
  res,
  {
    call,
    serverName,
    isStaff,
  }
) {
  const server = createServer(call, {
    name: serverName,
    isStaff,
  });

  const transport =
    new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);

  await transport.handleRequest(
    req,
    res,
    req.body
  );
}

/**
 * ==================================================
 * ТВОЙ ЛИЧНЫЙ CLAUDE
 * ==================================================
 *
 * Старый адрес сохраняется:
 * POST /mcp
 *
 * Использует твой полный админский вебхук.
 */
app.post("/mcp", async (req, res) => {
  if (
    MCP_SHARED_SECRET &&
    req.header("X-MCP-Secret") !==
      MCP_SHARED_SECRET
  ) {
    res.status(401).json({
      error: "unauthorized",
    });
    return;
  }

  try {
    await handleMcpRequest(req, res, {
      call: adminBitrixCall,
      serverName: "bitrix24-admin",
      isStaff: false,
    });
  } catch (e) {
    console.error(
      "[ADMIN MCP ERROR]",
      e
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: e.message,
      });
    }
  }
});

/**
 * ==================================================
 * CLAUDE СОТРУДНИКОВ
 * ==================================================
 *
 * Новый адрес:
 * POST /mcp-staff
 *
 * Использует:
 * ЛП Ассистент → guard.cjs → Битрикс
 */
app.post("/mcp-staff", async (req, res) => {
  /*
   * Для staff секрет ОБЯЗАТЕЛЕН.
   *
   * Если переменную забыли создать,
   * мы НЕ открываем endpoint без защиты.
   */
  if (!MCP_STAFF_SHARED_SECRET) {
    res.status(503).json({
      error:
        "MCP_STAFF_SHARED_SECRET не настроен",
    });
    return;
  }

  if (
    req.header("X-MCP-Secret") !==
    MCP_STAFF_SHARED_SECRET
  ) {
    res.status(401).json({
      error: "unauthorized",
    });
    return;
  }

  try {
    await handleMcpRequest(req, res, {
      call: staffBitrixCall,
      serverName: "bitrix24-staff",
      isStaff: true,
    });
  } catch (e) {
    console.error(
      "[STAFF MCP ERROR]",
      e
    );

    if (!res.headersSent) {
      res.status(403).json({
        error: e.message,
      });
    }
  }
});

/**
 * Проверка сервера.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    adminMcp: "/mcp",
    staffMcp: "/mcp-staff",
    guard: "loaded",
  });
});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Bitrix24 MCP сервер запущен на порту ${PORT}`
  );

  console.log(
    "ADMIN MCP: /mcp"
  );

  console.log(
    "STAFF MCP: /mcp-staff"
  );
});
