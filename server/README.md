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

## ☁️ Deploy (AWS Lambda, zip)

This repo includes a GitHub Actions workflow that builds the server, zips `dist/ + node_modules/ + assets/`, and runs `aws lambda update-function-code --publish`.

### Required GitHub secrets
- `AWS_ROLE_TO_ASSUME` (uses GitHub OIDC)

Optional overrides (defaults are `us-east-1` and `chatgpt-prompt-bank`):
- `AWS_REGION`
- `LAMBDA_FUNCTION_NAME`

Workflow file: `.github/workflows/deploy-lambda.yml`

Note: this codebase currently runs as a long-lived HTTP server (`node:http`). To run behind Lambda + HTTPS you typically need API Gateway/Function URL integration (for example via an adapter) or a Lambda-style handler.

## ☁️ Deploy (AWS App Runner, SSE-friendly)

App Runner is a better fit than Lambda for SSE/long-lived connections. This repo includes a workflow that builds a Docker image, pushes it to ECR, then creates/updates an App Runner service to use that image.

Workflow file: `.github/workflows/deploy-apprunner.yml`

### Required GitHub secrets
- `AWS_ROLE_TO_ASSUME` (GitHub OIDC role used by the workflow)

Optional overrides:
- `AWS_REGION` (default `us-east-1`)
- `APPRUNNER_SERVICE_NAME` (default `chatgpt-prompt-bank`)
- `ECR_REPOSITORY` (default `chatgpt-prompt-bank`)
- `IMAGE_TAG_LATEST` is pushed as `latest` on every deploy; configure App Runner to track the `latest` tag for automatic deployments.

IAM policy reference: `docs/apprunner-instance-role.md`

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
