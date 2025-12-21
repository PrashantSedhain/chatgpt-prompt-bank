# MCP Server Template (Node.js)

A clean, production-ready template for building **Model Context Protocol (MCP)** servers using Node.js and TypeScript. This template is designed to be the foundation for building ChatGPT-compatible applications with rich UI capabilities.

## 🚀 Features
- **SSE Transport**: Built-in support for Server-Sent Events, making it ideal for remote connections and web-based MCP clients.
- **TypeScript First**: Fully typed with the official `@modelcontextprotocol/sdk`.
- **Fast Development**: Uses `tsx` for zero-config execution and hot reloading during development.
- **Modular Design**: Easy patterns for adding new tools, resources, and custom logic.

## 🛠 Prerequisites
- **Node.js**: v18.0.0 or higher
- **Package Manager**: npm (default), yarn, or pnpm

## 📦 Installation

```bash
# Install dependencies
npm install
```

## 🚦 Usage

### Start the Server (SSE mode)
By default, the server listens on port `8000`. You can change this via the `PORT` environment variable.

```bash
npm start
```
The server will expose:
- `GET /mcp`: The SSE connection endpoint.
- `POST /mcp/messages`: The endpoint for sending messages to the server.

---

## 🔍 Testing & Debugging

### Using MCP Inspector
The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the best way to test your tools.

#### Option A: Connect via SSE (Recommended)
1. Start your server: `npm start`
2. Launch inspector: `npx @modelcontextprotocol/inspector`
3. Open the inspector URL (usually `http://localhost:5173`).
4. Select **SSE** transport and enter `http://localhost:8000/mcp`.


## 📄 License
MIT


