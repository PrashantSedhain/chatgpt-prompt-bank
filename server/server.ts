import "dotenv/config";

import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    type CallToolRequest,
    type ListResourceTemplatesRequest,
    type ListResourcesRequest,
    type ListToolsRequest,
    type ReadResourceRequest,
    type Resource,
    type ResourceTemplate,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { AwsVectorStore } from "./awsVectorStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "https://640b66a36f4c.ngrok-free.app";
const AUTH0_ISSUER = process.env.AUTH0_ISSUER ?? "";
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE ?? "";
const AUTH0_SCOPES = process.env.AUTH0_SCOPES ?? "prompts:read prompts:write";

const S3VECTORS_ARN =
    process.env.S3VECTORS_ARN ??
    "arn:aws:s3vectors:us-east-1:559118953851:bucket/prompt-bank-vectors";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const BEDROCK_REGION = process.env.BEDROCK_REGION ?? "us-east-1";
const BEDROCK_EMBEDDING_MODEL_ID =
    process.env.BEDROCK_EMBEDDING_MODEL_ID ?? "amazon.titan-embed-text-v2:0";

const requiredScopes = AUTH0_SCOPES.split(/[ ,]+/).filter(Boolean);
const parsedBaseUrl = new URL(MCP_BASE_URL);
const resourcePath = parsedBaseUrl.pathname === "/" ? "" : parsedBaseUrl.pathname;
const protectedResourcePath = `/.well-known/oauth-protected-resource${resourcePath}`;
const protectedResourceMetadataUrl = `${parsedBaseUrl.origin}${protectedResourcePath}`;

const vectorStore = new AwsVectorStore({
    s3VectorsArn: S3VECTORS_ARN,
    region: AWS_REGION,
    bedrockRegion: BEDROCK_REGION,
    bedrockEmbeddingModelId: BEDROCK_EMBEDDING_MODEL_ID,
});

const jwks = AUTH0_ISSUER
    ? createRemoteJWKSet(new URL(`${AUTH0_ISSUER.replace(/\/?$/, "/")}.well-known/jwks.json`))
    : null;

type Widget = {
    id: string;
    title: string;
    templateUri: string;
    invoking: string;
    invoked: string;
    assetName: string;
    responseText: string;
};

type AuthContext = {
    authorized: boolean;
    scopes: Set<string>;
    error?: string;
    subject?: string;
};

function readWidgetHtml(componentName: string): string {
    if (!fs.existsSync(ASSETS_DIR)) {
        throw new Error(
            `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "npm run build:widget" in /web before starting the server.`
        );
    }

    const directPath = path.join(ASSETS_DIR, `${componentName}.html`);
    if (fs.existsSync(directPath)) {
        return fs.readFileSync(directPath, "utf8");
    }

    const candidates = fs
        .readdirSync(ASSETS_DIR)
        .filter((file) => file.startsWith(`${componentName}-`) && file.endsWith(".html"))
        .sort();

    const fallback = candidates[candidates.length - 1];
    if (fallback) {
        return fs.readFileSync(path.join(ASSETS_DIR, fallback), "utf8");
    }

    throw new Error(
        `Widget HTML for "${componentName}" not found in ${ASSETS_DIR}. Run "npm run build:widget" in /web to generate assets.`
    );
}

function widgetDescriptorMeta(widget: Widget) {
    return {
        "openai/outputTemplate": widget.templateUri,
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
        "openai/widgetAccessible": true,
    } as const;
}

function widgetInvocationMeta(widget: Widget) {
    return {
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
    } as const;
}

function buildWwwAuthenticate(error: string, description: string) {
    const safeError = error.replace(/"/g, "\\\"");
    const safeDescription = description.replace(/"/g, "\\\"");
    const parts = [
        `resource_metadata=\"${protectedResourceMetadataUrl}\"`,
        `error=\"${safeError}\"`,
        `error_description=\"${safeDescription}\"`,
    ];
    if (requiredScopes.length > 0) {
        parts.push(`scope=\"${requiredScopes.join(" ")}\"`);
    }
    return `Bearer ${parts.join(", ")}`;
}

async function validateAuthHeader(authHeader: string | undefined): Promise<AuthContext> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        console.warn("Auth header missing or not Bearer", {
            hasAuthHeader: Boolean(authHeader),
            scheme: authHeader?.split(" ")[0] ?? null,
        });
        return { authorized: false, scopes: new Set(), error: "missing_token" };
    }

    if (!AUTH0_ISSUER || !AUTH0_AUDIENCE || !jwks) {
        console.warn("Auth0 config missing", {
            AUTH0_ISSUER: Boolean(AUTH0_ISSUER),
            AUTH0_AUDIENCE: Boolean(AUTH0_AUDIENCE),
            jwks: Boolean(jwks),
        });
        return { authorized: false, scopes: new Set(), error: "auth_config_missing" };
    }

    const token = authHeader.slice("Bearer ".length).trim();

    try {
        const { payload } = await jwtVerify(token, jwks, {
            issuer: AUTH0_ISSUER,
            audience: AUTH0_AUDIENCE,
        });
        const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
        const permissionsClaim = Array.isArray(payload.permissions) ? payload.permissions : [];
        const scpClaim =
            Array.isArray((payload as any).scp) && (payload as any).scp.every((v: unknown) => typeof v === "string")
                ? ((payload as any).scp as string[])
                : [];
        const tokenScopes = new Set([
            ...scopeClaim.split(" ").filter(Boolean),
            ...permissionsClaim.filter((item) => typeof item === "string"),
            ...scpClaim,
        ]);
        console.log("Token scopes", {
            scopeClaim,
            permissionsClaim,
            scpClaim,
            tokenScopeCount: tokenScopes.size,
        });
        if (tokenScopes.size === 0 && requiredScopes.length > 0) {
            console.warn(
                "No scopes/permissions found on token. For Auth0, ensure your API has these permissions defined and enable 'RBAC' + 'Add Permissions in the Access Token'."
            );
        }
        if (requiredScopes.length > 0) {
            const missingScope = requiredScopes.find((scope) => !tokenScopes.has(scope));
            if (missingScope) {
                console.warn("Token missing required scope", {
                    missingScope,
                    tokenScopes: Array.from(tokenScopes),
                });
                return {
                    authorized: false,
                    scopes: tokenScopes,
                    error: "insufficient_scope",
                    subject: typeof payload.sub === "string" ? payload.sub : undefined,
                };
            }
        }
        return {
            authorized: true,
            scopes: tokenScopes,
            subject: typeof payload.sub === "string" ? payload.sub : undefined,
        };
    } catch (error) {
        console.error("Token verification failed", error);
        return { authorized: false, scopes: new Set(), error: "invalid_token" };
    }
}

function authErrorResult(message: string, error = "invalid_request") {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        _meta: {
            "mcp/www_authenticate": [buildWwwAuthenticate(error, message)],
        },
    } as any;
}

const promptWidget: Widget = {
    id: "fetchPrompt",
    title: "Prompt Suggestions",
    templateUri: "ui://widget/prompt-suggestions.html?v=18",
    invoking: "Gathering prompt suggestions",
    invoked: "Prompt suggestions ready",
    assetName: "prompt-suggestions",
    responseText: "Here are prompt suggestions from PromptBank.",
};

const widgets = [promptWidget];
const widgetsById = new Map<string, Widget>();
const widgetsByUri = new Map<string, Widget>();
widgets.forEach((widget) => {
    widgetsById.set(widget.id, widget);
    widgetsByUri.set(widget.templateUri, widget);
});

const fetchPromptSchema: Tool["inputSchema"] = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "Text to search for the most relevant prompts.",
        },
        name: {
            type: "string",
            description: "Deprecated alias for `query`.",
        },
    },
    required: [],
    additionalProperties: false,
};

const savePromptSchema: Tool["inputSchema"] = {
    type: "object",
    properties: {
        text: {
            type: "string",
            description: "Prompt text to save for the current user.",
        },
        title: {
            type: "string",
            description: "Optional short title for this prompt.",
        },
        tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags to help organize prompts.",
        },
        source: {
            type: "string",
            description: "Optional source identifier (e.g. chatgpt, web, api).",
        },
    },
    required: ["text"],
    additionalProperties: false,
};

const deletePromptSchema: Tool["inputSchema"] = {
    type: "object",
    properties: {
        key: {
            type: "string",
            description: "Vector key of the prompt to delete.",
        },
    },
    required: ["key"],
    additionalProperties: false,
};

const updatePromptSchema: Tool["inputSchema"] = {
    type: "object",
    properties: {
        key: {
            type: "string",
            description: "Vector key of the prompt to update.",
        },
        text: {
            type: "string",
            description: "Updated prompt text.",
        },
        title: {
            type: "string",
            description: "Optional updated title for this prompt.",
        },
        tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional updated tags for this prompt.",
        },
        source: {
            type: "string",
            description: "Optional updated source identifier.",
        },
    },
    required: ["key", "text"],
    additionalProperties: false,
};

const oauthSecuritySchemes: NonNullable<Tool["securitySchemes"]> = [
    {
        type: "oauth2",
        scopes: requiredScopes,
    },
];

const tools: Tool[] = [
    {
        name: promptWidget.id,
        description: promptWidget.title,
        inputSchema: fetchPromptSchema,
        title: promptWidget.title,
        _meta: {
            ...widgetDescriptorMeta(promptWidget),
            securitySchemes: oauthSecuritySchemes,
        },
        annotations: {
            destructiveHint: false,
            openWorldHint: false,
            readOnlyHint: true,
        },
        securitySchemes: oauthSecuritySchemes,
    },
    {
        name: "savePrompt",
        title: "Save prompt",
        description: "Save a prompt for the authenticated user.",
        inputSchema: savePromptSchema,
        annotations: {
            destructiveHint: false,
            openWorldHint: false,
            readOnlyHint: false,
        },
        securitySchemes: oauthSecuritySchemes,
    },
    {
        name: "deletePrompt",
        title: "Delete prompt",
        description: "Delete a saved prompt for the authenticated user.",
        inputSchema: deletePromptSchema,
        annotations: {
            destructiveHint: true,
            openWorldHint: false,
            readOnlyHint: false,
        },
        securitySchemes: oauthSecuritySchemes,
    },
    {
        name: "updatePrompt",
        title: "Update prompt",
        description: "Update a saved prompt for the authenticated user.",
        inputSchema: updatePromptSchema,
        annotations: {
            destructiveHint: false,
            openWorldHint: false,
            readOnlyHint: false,
        },
        securitySchemes: oauthSecuritySchemes,
    },
];

const resources: Resource[] = widgets.map((widget) => ({
    uri: widget.templateUri,
    name: widget.title,
    description: `${widget.title} widget markup`,
    mimeType: "text/html+skybridge",
    _meta: widgetDescriptorMeta(widget),
}));

const resourceTemplates: ResourceTemplate[] = widgets.map((widget) => ({
    uriTemplate: widget.templateUri,
    name: widget.title,
    description: `${widget.title} widget markup`,
    mimeType: "text/html+skybridge",
    _meta: widgetDescriptorMeta(widget),
}));

function createServerInstance(authContext: AuthContext): Server {
    const server = new Server(
        {
            name: "PromptBank",
            version: "0.1.0",
        },
        {
            capabilities: {
                tools: {},
                resources: {},
            },
        }
    );

    server.setRequestHandler(
        ListToolsRequestSchema,
        async (_request: ListToolsRequest) => ({
            tools,
        })
    );

    server.setRequestHandler(
        ListResourcesRequestSchema,
        async (_request: ListResourcesRequest) => ({
            resources,
        })
    );

    server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async (_request: ListResourceTemplatesRequest) => ({
            resourceTemplates,
        })
    );

    server.setRequestHandler(
        ReadResourceRequestSchema,
        async (request: ReadResourceRequest) => {
            const widget = widgetsByUri.get(request.params.uri);

            if (!widget) {
                throw new Error(`Resource not found: ${request.params.uri}`);
            }

            return {
                contents: [
                    {
                        uri: widget.templateUri,
                        mimeType: "text/html+skybridge",
                        text: readWidgetHtml(widget.assetName),
                        _meta: widgetDescriptorMeta(widget),
                    },
                ],
            };
        }
    );

    server.setRequestHandler(
        CallToolRequestSchema,
        async (_request: CallToolRequest) => {
            const toolName = _request.params.name;
            console.log("CallTool request", { toolName, authorized: authContext.authorized });
            const normalizedToolName =
                toolName === "fetchRelevantPrompts" ? "fetchPrompt" : toolName;
            const requiresAuth =
                normalizedToolName === "fetchPrompt" ||
                normalizedToolName === "savePrompt" ||
                normalizedToolName === "deletePrompt" ||
                normalizedToolName === "updatePrompt";

            if (!authContext.authorized && requiresAuth) {
                const error =
                    authContext.error === "invalid_token"
                        ? "invalid_token"
                        : authContext.error === "missing_token"
                            ? "invalid_request"
                            : authContext.error === "insufficient_scope"
                                ? "insufficient_scope"
                                : "invalid_request";
                const message =
                    authContext.error === "invalid_token"
                        ? "Authentication required: invalid access token."
                        : "Authentication required: no access token provided.";
                return authErrorResult(message, error);
            }

            if (requiresAuth && !authContext.subject) {
                return authErrorResult("Authentication required: missing user identity on token.", "invalid_token");
            }

            if (normalizedToolName === "savePrompt") {
                const userSub = authContext.subject!;
                const text = typeof _request.params.arguments?.text === "string" ? _request.params.arguments.text : "";
                if (!text.trim()) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Missing required input: `text`." }],
                    } as any;
                }

                let id: string;
                let indexName: string;
                let metadata: any;
                try {
                    const title =
                        typeof _request.params.arguments?.title === "string" ? _request.params.arguments.title : undefined;
                    const source =
                        typeof _request.params.arguments?.source === "string" ? _request.params.arguments.source : undefined;
                    const tags =
                        Array.isArray(_request.params.arguments?.tags)
                            ? (_request.params.arguments?.tags as unknown[]).filter((t): t is string => typeof t === "string")
                            : undefined;
                    const result = await vectorStore.upsertPrompt(userSub, text, { title, tags, source });
                    id = result.id;
                    indexName = result.indexName;
                    metadata = result.metadata;
                } catch (error) {
                    console.error("savePrompt failed", error);
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Failed to save prompt." }],
                    } as any;
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: "Prompt saved.",
                        },
                    ],
                    structuredContent: {
                        status: "success",
                        id,
                        indexName,
                        prompt: metadata,
                    },
                } as any;
            }

            if (normalizedToolName === "deletePrompt") {
                const userSub = authContext.subject!;
                const key = typeof _request.params.arguments?.key === "string" ? _request.params.arguments.key : "";
                if (!key.trim()) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Missing required input: `key`." }],
                    } as any;
                }

                try {
                    const result = await vectorStore.deletePrompt(userSub, key);
                    return {
                        content: [{ type: "text", text: result.deleted ? "Prompt deleted." : "Prompt not found." }],
                        structuredContent: {
                            status: "success",
                            deleted: result.deleted,
                            key,
                            indexName: result.indexName,
                        },
                    } as any;
                } catch (error) {
                    console.error("deletePrompt failed", error);
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Failed to delete prompt." }],
                    } as any;
                }
            }

            if (normalizedToolName === "updatePrompt") {
                const userSub = authContext.subject!;
                const key = typeof _request.params.arguments?.key === "string" ? _request.params.arguments.key : "";
                const text = typeof _request.params.arguments?.text === "string" ? _request.params.arguments.text : "";
                if (!key.trim() || !text.trim()) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Missing required input: `key` and `text`." }],
                    } as any;
                }

                const title =
                    typeof _request.params.arguments?.title === "string" ? _request.params.arguments.title : undefined;
                const source =
                    typeof _request.params.arguments?.source === "string" ? _request.params.arguments.source : undefined;
                const tags =
                    Array.isArray(_request.params.arguments?.tags)
                        ? (_request.params.arguments?.tags as unknown[]).filter((t): t is string => typeof t === "string")
                        : undefined;

                try {
                    const result = await vectorStore.updatePrompt(userSub, key, text, { title, tags, source });
                    return {
                        content: [{ type: "text", text: "Prompt updated." }],
                        structuredContent: {
                            status: "success",
                            key,
                            indexName: result.indexName,
                            prompt: result.metadata,
                        },
                    } as any;
                } catch (error) {
                    console.error("updatePrompt failed", error);
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Failed to update prompt." }],
                    } as any;
                }
            }

            const widget = widgetsById.get("fetchPrompt");
            if (!widget) {
                throw new Error(`Unknown tool: ${_request.params.name}`);
            }

            const userSub = authContext.subject!;
            const query =
                typeof _request.params.arguments?.query === "string"
                    ? _request.params.arguments.query
                    : typeof _request.params.arguments?.name === "string"
                        ? _request.params.arguments.name
                        : "";
            let matches: any[] = [];
            let prompts: string[] = [];
            try {
                const trimmedQuery = query.trim();
                matches = trimmedQuery
                    ? await vectorStore.queryPromptRecords(userSub, trimmedQuery, 4)
                    : await vectorStore.listPromptRecords(userSub, 4);
                prompts = matches
                    .map((m) => m?.metadata?.text)
                    .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
                    .slice(0, 4);
            } catch (error) {
                console.error("fetchPrompt failed", error);
                prompts = [];
                matches = [];
            }

            return {
                structuredContent: {
                    prompts,
                    matches,
                    status: "success",
                },
                content: [
                    {
                        type: "text",
                        text: "Here are your top prompt suggestions from PromptBank.",
                    },
                ],
                _meta: {
                    ...widgetInvocationMeta(widget),
                    "openai/outputTemplate": widget.templateUri,
                },
            } as any;
        }
    );

    return server;
}

type SessionRecord = {
    server: Server;
    transport: SSEServerTransport;
    authContext: AuthContext;
};

const sessions = new Map<string, SessionRecord>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";

async function handleSseRequest(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const authContext: AuthContext = { authorized: false, scopes: new Set() };
    const server = createServerInstance(authContext);
    const transport = new SSEServerTransport(postPath, res);
    const sessionId = transport.sessionId;

    sessions.set(sessionId, { server, transport, authContext });

    transport.onclose = async () => {
        sessions.delete(sessionId);
        await server.close();
    };

    transport.onerror = (error) => {
        console.error("SSE transport error", error);
    };

    try {
        const authResult = await validateAuthHeader(req.headers.authorization);
        authContext.authorized = authResult.authorized;
        authContext.scopes = authResult.scopes;
        authContext.error = authResult.error;
        authContext.subject = authResult.subject;
        console.log("SSE auth context", {
            authorized: authContext.authorized,
            scopes: Array.from(authContext.scopes),
            error: authContext.error,
            subject: authContext.subject ?? null,
        });
        await server.connect(transport);
    } catch (error) {
        sessions.delete(sessionId);
        console.error("Failed to start SSE session", error);
        if (!res.headersSent) {
            res.writeHead(500).end("Failed to establish SSE connection");
        }
    }
}

async function handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
        res.writeHead(400).end("Missing sessionId query parameter");
        return;
    }

    const session = sessions.get(sessionId);

    if (!session) {
        res.writeHead(404).end("Unknown session");
        return;
    }

    try {
        const authResult = await validateAuthHeader(req.headers.authorization);
        session.authContext.authorized = authResult.authorized;
        session.authContext.scopes = authResult.scopes;
        session.authContext.error = authResult.error;
        session.authContext.subject = authResult.subject;
        console.log("POST auth context", {
            authorized: session.authContext.authorized,
            scopes: Array.from(session.authContext.scopes),
            error: session.authContext.error,
            subject: session.authContext.subject ?? null,
        });
        await session.transport.handlePostMessage(req, res);
    } catch (error) {
        console.error("Failed to process message", error);
        if (!res.headersSent) {
            res.writeHead(500).end("Failed to process message");
        }
    }
}

const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;

const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
        if (!req.url) {
            res.writeHead(400).end("Missing URL");
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
        console.log(`[${req.method}] ${url.pathname}${url.search}`);

        if (req.method === "GET" && url.pathname === protectedResourcePath) {
            const body = {
                resource: MCP_BASE_URL,
                authorization_servers: AUTH0_ISSUER ? [AUTH0_ISSUER] : [],
                scopes_supported: requiredScopes,
                resource_documentation: `${MCP_BASE_URL}/docs`,
            };
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
            return;
        }

        if (
            req.method === "OPTIONS" &&
            (url.pathname === ssePath || url.pathname === postPath)
        ) {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "content-type, authorization",
            });
            res.end();
            return;
        }

        if (req.method === "GET" && url.pathname === ssePath) {
            console.log("Establishing new SSE connection");
            await handleSseRequest(req, res);
            return;
        }

        if (req.method === "POST" && (url.pathname === postPath || url.pathname === ssePath)) {
            const sessionId = url.searchParams.get("sessionId");
            console.log(`Processing POST message for session: ${sessionId}`);
            await handlePostMessage(req, res, url);
            return;
        }

        console.warn(`Path not found: ${url.pathname}`);
        res.writeHead(404).end("Not Found");
    }
);

httpServer.on("clientError", (err: Error, socket) => {
    console.error("HTTP client error", err);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
    console.log(`MCP server listening on http://localhost:${port}`);
    console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
    console.log(
        `  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`
    );
    console.log(`  Protected resource metadata: GET ${protectedResourceMetadataUrl}`);
    console.log("  OAuth config", {
        MCP_BASE_URL,
        AUTH0_ISSUER: AUTH0_ISSUER || null,
        AUTH0_AUDIENCE: AUTH0_AUDIENCE || null,
        requiredScopes,
    });
});
