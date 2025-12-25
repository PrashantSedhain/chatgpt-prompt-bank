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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

const MCP_BASE_URL = process.env.MCP_BASE_URL ?? "https://640b66a36f4c.ngrok-free.app";
const AUTH0_ISSUER = process.env.AUTH0_ISSUER ?? "";
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE ?? "";
const AUTH0_SCOPES = process.env.AUTH0_SCOPES ?? "prompts:read prompts:write";

const requiredScopes = AUTH0_SCOPES.split(/[ ,]+/).filter(Boolean);
const parsedBaseUrl = new URL(MCP_BASE_URL);
const resourcePath = parsedBaseUrl.pathname === "/" ? "" : parsedBaseUrl.pathname;
const protectedResourcePath = `/.well-known/oauth-protected-resource${resourcePath}`;
const protectedResourceMetadataUrl = `${parsedBaseUrl.origin}${protectedResourcePath}`;

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
    const segments = token.split(".");
    const tokenParts = segments.length;
    const headerSegment = segments[0] ?? "";
    console.log("Auth token summary", {
        length: token.length,
        parts: tokenParts,
        prefix: token.slice(0, 12),
        suffix: token.slice(-6),
        headerSegment,
    });
    if (tokenParts !== 3) {
        if (tokenParts === 5) {
            console.warn(
                "Unsupported token format: looks like a JWE (encrypted token). This server expects a 3-part JWS JWT.",
                { parts: tokenParts }
            );
        }
        console.warn("Unsupported token format (expected 3-part JWS JWT)", {
            parts: tokenParts,
        });
        return { authorized: false, scopes: new Set(), error: "invalid_token" };
    }
    try {
        const { payload } = await jwtVerify(token, jwks, {
            issuer: AUTH0_ISSUER,
            audience: AUTH0_AUDIENCE,
        });
        console.log("JWT verified", {
            sub: payload.sub,
            aud: payload.aud,
            iss: payload.iss,
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
                return { authorized: false, scopes: tokenScopes, error: "insufficient_scope" };
            }
        }
        return { authorized: true, scopes: tokenScopes };
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
        name: {
            type: "string",
            description: "Context of the text that the user is trying to retrieve.",
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
    },
    required: ["text"],
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
            readOnlyHint: true,
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
            const requiresAuth = normalizedToolName === "fetchPrompt" || normalizedToolName === "savePrompt";

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

            if (normalizedToolName === "savePrompt") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Prompt saved.",
                        },
                    ],
                    structuredContent: {
                        status: "success",
                    },
                } as any;
            }

            const widget = widgetsById.get("fetchPrompt");
            if (!widget) {
                throw new Error(`Unknown tool: ${_request.params.name}`);
            }

            const prompts = [
                "Create a high-detail digital painting of a cat who is an elite cyberpunk hacker, surrounded by glowing green terminals in a dark room, wearing tiny Matrix-style sunglasses and a tiny leather jacket.",
                "Generate a majestic oil painting of a cat as a 17th-century French aristocrat, wearing an oversized ruffled lace collar and a powdered wig, sitting proudly next to a bowl of golden milk in a gilded palace.",
                "Design a hilarious 3D cartoon of a cat as a chubby astronaut floating weightlessly in the International Space Station, desperately trying to catch a floating blob of tuna while wearing a tiny space suit.",
            ];

            return {
                structuredContent: {
                    prompts,
                    status: "success",
                },
                content: [
                    {
                        type: "text",
                        text: "I've retrieved your saved image generation prompts from PromptBank. You can select one from the widget below to generate the image.",
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
        console.log("SSE auth context", {
            authorized: authContext.authorized,
            scopes: Array.from(authContext.scopes),
            error: authContext.error,
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
        console.log("POST auth context", {
            authorized: session.authContext.authorized,
            scopes: Array.from(session.authContext.scopes),
            error: session.authContext.error,
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
