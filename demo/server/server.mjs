import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

/**
 * Why this exists (demo): we inline the widget HTML so the entire UI can ship as a single MCP resource.
 * In production you might still inline, but you’ll likely have versioning + caching controls.
 */
function readWidgetHtml(assetName) {
  const filePath = path.join(ASSETS_DIR, `${assetName}.html`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing widget asset: ${filePath}. Run "npm run build:widgets" from the demo folder first.`,
    );
  }
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Why this exists (demo): ChatGPT may cache widget resources. A query hash makes it obvious when the UI changed.
 */
function widgetTemplateUriForAsset(assetName) {
  const html = readWidgetHtml(assetName);
  const hash = createHash("sha1").update(html).digest("hex").slice(0, 10);
  return `ui://widget/${assetName}.html?v=${hash}`;
}

/**
 * Why this exists (demo): the widget runs in a sandbox. Declaring a CSP early avoids review surprises later.
 * This demo widget uses only `window.openai.callTool`, so connect/resource/frame domains are empty.
 */
function widgetMeta(widget) {
  return {
    "openai/outputTemplate": widget.templateUri,
    "openai/widgetAccessible": true,
    "openai/widgetCSP": {
      connect_domains: [],
      resource_domains: [],
      redirect_domains: [],
      frame_domains: [],
    },
  };
}

/**
 * Why this exists (demo): without OAuth we still want per-user isolation.
 * We use the MCP sessionId as a stand-in identity so multiple viewers can test without clobbering each other.
 */
const storesBySession = new Map(); // sessionId -> { prompts: PromptRecord[] }

/**
 * Why this exists (demo): even without OAuth you still want isolated “per user” state in a walkthrough.
 * A Map keeps the implementation obvious (no DB, no migrations) while demonstrating the idea.
 */
function getStore(sessionId) {
  if (!storesBySession.has(sessionId)) {
    storesBySession.set(sessionId, { prompts: [] });
  }
  return storesBySession.get(sessionId);
}

/**
 * Why this exists (demo): a short preview is what you’ll show in confirmation UX (delete/edit),
 * and it keeps widget lists readable.
 */
function previewText(text, maxLen = 160) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Why this exists (demo): timestamps make it easy to demonstrate “updated vs created” behavior without extra UI.
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Why this exists (demo): a single place to define widget resources + which tools render which widget.
 * In production you’ll likely expand this into a registry and add auth + richer schemas.
 */
function createMcpServer({ sessionId }) {
  const store = getStore(sessionId);

  const widgets = [
    {
      id: "listPrompts",
      title: "Prompt Library",
      assetName: "demo-prompts",
      templateUri: widgetTemplateUriForAsset("demo-prompts"),
    },
    {
      id: "promptInsights",
      title: "Prompt Insights",
      assetName: "demo-insights",
      templateUri: widgetTemplateUriForAsset("demo-insights"),
    },
  ];

  const widgetsByTemplateUri = new Map(widgets.map((w) => [w.templateUri, w]));

  const tools = [
    {
      name: "listPrompts",
      title: "Show saved prompts (demo)",
      description: "Show the user’s saved prompts in a widget.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional text filter (demo uses substring matching)." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Max prompts to show (default 10)." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "savePrompt",
      title: "Save prompt (demo)",
      description: "Save a prompt for the current demo session.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Prompt text to save." },
          title: { type: "string", description: "Optional short title." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "updatePrompt",
      title: "Update prompt (demo)",
      description: "Update a saved prompt by key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Prompt key." },
          text: { type: "string", description: "Updated prompt text." },
          title: { type: "string", description: "Optional updated title." },
        },
        required: ["key", "text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    {
      name: "deletePrompt",
      title: "Delete prompt (demo)",
      description:
        "Delete a saved prompt. Only call after the user confirms the correct prompt (show a preview first).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "object",
            properties: {
              key: { type: "string", description: "Prompt key." },
              preview: { type: "string", description: "Short preview shown to the user for confirmation." },
              title: { type: "string", description: "Optional title shown to the user for confirmation." },
            },
            required: ["key", "preview"],
            additionalProperties: false,
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    {
      name: "promptInsights",
      title: "Prompt insights (demo)",
      description: "Show a small summary widget (count + last updated).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
  ];

  const resources = widgets.map((w) => ({
    uri: w.templateUri,
    name: w.title,
    mimeType: "text/html+skybridge",
    description: `${w.title} widget`,
    _meta: widgetMeta(w),
  }));

  const resourceTemplates = widgets.map((w) => ({
    uriTemplate: w.templateUri,
    name: w.title,
    mimeType: "text/html+skybridge",
    description: `${w.title} widget`,
    _meta: widgetMeta(w),
  }));

  const server = new Server(
    { name: "PromptBank Demo", version: "0.0.1" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const widget =
      widgetsByTemplateUri.get(request.params.uri) ??
      widgetsByTemplateUri.get(request.params.uri.split("?")[0]);
    if (!widget) throw new Error(`Unknown resource: ${request.params.uri}`);
    return {
      contents: [
        {
          uri: widget.templateUri,
          mimeType: "text/html+skybridge",
          text: readWidgetHtml(widget.assetName),
          _meta: widgetMeta(widget),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    if (name === "savePrompt") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!text) return { isError: true, content: [{ type: "text", text: "Missing required input: text." }] };

      const record = {
        key: `p-${randomUUID()}`,
        text,
        title,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      store.prompts.unshift(record);
      return {
        content: [{ type: "text", text: "Prompt saved." }],
        structuredContent: { status: "success", prompt: { ...record, preview: previewText(record.text) } },
      };
    }

    if (name === "updatePrompt") {
      const key = typeof args.key === "string" ? args.key.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!key || !text) {
        return { isError: true, content: [{ type: "text", text: "Missing required input: key and text." }] };
      }
      const existing = store.prompts.find((p) => p.key === key);
      if (!existing) return { isError: true, content: [{ type: "text", text: "Prompt not found." }] };
      existing.text = text;
      existing.title = title || existing.title;
      existing.updatedAt = nowIso();
      return {
        content: [{ type: "text", text: "Prompt updated." }],
        structuredContent: { status: "success", prompt: { ...existing, preview: previewText(existing.text) } },
      };
    }

    if (name === "deletePrompt") {
      const prompt = args.prompt ?? {};
      const key = typeof prompt.key === "string" ? prompt.key.trim() : "";
      const preview = typeof prompt.preview === "string" ? prompt.preview.trim() : "";
      const title = typeof prompt.title === "string" ? prompt.title.trim() : "";
      if (!key || !preview) {
        return { isError: true, content: [{ type: "text", text: "Missing required input: prompt.key + prompt.preview." }] };
      }
      const before = store.prompts.length;
      store.prompts = store.prompts.filter((p) => p.key !== key);
      const deleted = store.prompts.length !== before;
      return {
        content: [{ type: "text", text: deleted ? "Prompt deleted." : "Prompt not found." }],
        structuredContent: { status: "success", deleted, key, ...(title ? { title } : {}), ...(preview ? { preview } : {}) },
      };
    }

    if (name === "promptInsights") {
      const widget = widgets.find((w) => w.id === "promptInsights");
      const lastUpdatedAt = store.prompts[0]?.updatedAt ?? null;
      return {
        content: [{ type: "text", text: "Here’s a quick summary of your prompt library." }],
        structuredContent: { status: "success", count: store.prompts.length, lastUpdatedAt },
        _meta: { "openai/outputTemplate": widget.templateUri },
      };
    }

    if (name === "listPrompts") {
      const widget = widgets.find((w) => w.id === "listPrompts");
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10;

      const filtered = query
        ? store.prompts.filter((p) => (p.title + " " + p.text).toLowerCase().includes(query))
        : store.prompts;

      const matches = filtered.slice(0, limit).map((p) => ({
        key: p.key,
        metadata: { text: p.text, preview: previewText(p.text), title: p.title, createdAt: p.createdAt },
      }));

      return {
        content: [{ type: "text", text: "Here are your saved prompts." }],
        structuredContent: { status: "success", prompts: matches.map((m) => m.metadata.text), matches },
        _meta: { "openai/outputTemplate": widget.templateUri },
      };
    }

    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  });

  return server;
}

/**
 * Why this exists (demo): MCP uses SSE for the “server -> client” stream and a POST endpoint for client messages.
 * This is the minimum wiring you need to make an MCP server work with ChatGPT.
 */
const sessions = new Map(); // sessionId -> { transport, server }
const ssePath = "/mcp";
const postPath = "/mcp/messages";

/**
 * Why this exists (demo): ChatGPT connects to the SSE endpoint once and keeps it open for server events.
 * Each connection gets a sessionId which we reuse for storage + routing.
 */
async function handleSse(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;

  const server = createMcpServer({ sessionId });
  sessions.set(sessionId, { transport, server });

  transport.onclose = async () => {
    sessions.delete(sessionId);
    await server.close();
  };

  await server.connect(transport);
}

/**
 * Why this exists (demo): MCP client messages are sent via HTTP POST and routed to the matching SSE session.
 * The `sessionId` query param is how the transport correlates POSTs to the open SSE stream.
 */
async function handlePost(req, res, url) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return void res.writeHead(400).end("Missing sessionId");

  const session = sessions.get(sessionId);
  if (!session) return void res.writeHead(404).end("Unknown session");

  await session.transport.handlePostMessage(req, res);
}

const port = Number(process.env.PORT ?? 8000) || 8000;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "OPTIONS" && (url.pathname === ssePath || url.pathname === postPath)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === ssePath) return void (await handleSse(req, res));
  if (req.method === "POST" && url.pathname === postPath) return void (await handlePost(req, res, url));

  res.writeHead(404).end("Not Found");
}).listen(port, () => {
  console.log(`Demo MCP server listening: http://localhost:${port}${ssePath}`);
  console.log(`Health: http://localhost:${port}/health`);
});
