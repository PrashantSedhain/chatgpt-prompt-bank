# PromptBank MCP Demo (no auth)

This folder is a **minimal, extractable demo** you can use in a YouTube walkthrough. It intentionally skips OAuth and external storage so viewers can focus on the MCP fundamentals:

- An MCP server over **SSE** (`GET /mcp` + `POST /mcp/messages`)
- A **widget resource** (`ui://widget/...`) served via MCP `ReadResource`
- Tools that return `openai/outputTemplate` to render the widget
- A UI split into multiple components + multiple widget entrypoints

## Run locally

```bash
cd demo
npm install
npm run build:widgets
npm run dev
```

Server URL (local): `http://localhost:8000/mcp`

## What to demo in ChatGPT

1) Ask: “Show my prompts”
2) Use the widget to add/edit/delete prompts
3) Ask: “How many prompts do I have?” to see the insights widget

## Add more widgets (more than two UIs)

1) Create a new entry file in `web/src/widgets/` (example: `web/src/widgets/myWidget.tsx`)
2) Add it to the list in `web/scripts/build-widgets.mjs`
3) Register it in `server/server.mjs` as a widget resource + tool outputTemplate

## Notes

- Storage is **in-memory per session** for demo simplicity.
- In production, use OAuth for identity + a durable database (and keep destructive tools behind explicit confirmation).

