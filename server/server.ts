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
const WIDGET_VERSION_RAW = process.env.WIDGET_VERSION ?? "19";
const WIDGET_VERSION = WIDGET_VERSION_RAW.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "19";

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

const MAX_PROMPTS_PER_SAVE = Number.parseInt(process.env.MAX_PROMPTS_PER_SAVE ?? "50", 10) || 50;
const LOG_CHUNKING = (process.env.LOG_CHUNKING ?? "").toLowerCase() === "true" || process.env.LOG_CHUNKING === "1";
const FETCH_PROMPT_MAX_DISTANCE =
    Number.parseFloat(process.env.FETCH_PROMPT_MAX_DISTANCE ?? "0.8") || 0.8;
const FETCH_PROMPT_DISTANCE_DELTA =
    Number.parseFloat(process.env.FETCH_PROMPT_DISTANCE_DELTA ?? "0.08") || 0.08;

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

type FetchPromptFilters = {
    source?: string;
    uploadId?: string;
    tagsAny?: string[];
    tagsAll?: string[];
};

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
    return out.length ? out : undefined;
}

function applyFetchPromptFilters(
    matches: Array<{ key: string; metadata?: any; distance?: number }>,
    filters: FetchPromptFilters
) {
    const source = normalizeString(filters.source);
    const uploadId = normalizeString(filters.uploadId);
    const tagsAny = filters.tagsAny?.map((t) => t.trim()).filter(Boolean);
    const tagsAll = filters.tagsAll?.map((t) => t.trim()).filter(Boolean);

    return matches.filter((m) => {
        const metadata = m.metadata;
        if (!metadata || typeof metadata !== "object") return false;
        if (source && metadata.source !== source) return false;
        if (uploadId && metadata.uploadId !== uploadId) return false;
        if (tagsAny || tagsAll) {
            const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((t: unknown) => typeof t === "string") : [];
            if (tagsAny && tagsAny.length > 0) {
                const ok = tagsAny.some((t) => tags.includes(t));
                if (!ok) return false;
            }
            if (tagsAll && tagsAll.length > 0) {
                const ok = tagsAll.every((t) => tags.includes(t));
                if (!ok) return false;
            }
        }
        return true;
    });
}

function normalizePromptKey(text: string) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseIsoTime(value: unknown): number {
    if (typeof value !== "string") return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function dedupePromptMatches(
    matches: Array<{ key: string; metadata?: any; distance?: number }>,
    opts: { mode: "newest" | "closest" }
) {
    const byText = new Map<string, { key: string; metadata?: any; distance?: number }>();

    for (const match of matches) {
        const text = typeof match?.metadata?.text === "string" ? match.metadata.text : "";
        const normalized = normalizePromptKey(text);
        if (!normalized) continue;

        const existing = byText.get(normalized);
        if (!existing) {
            byText.set(normalized, match);
            continue;
        }

        if (opts.mode === "closest") {
            const currentDistance = typeof match.distance === "number" ? match.distance : Number.POSITIVE_INFINITY;
            const existingDistance = typeof existing.distance === "number" ? existing.distance : Number.POSITIVE_INFINITY;
            if (currentDistance < existingDistance) byText.set(normalized, match);
            continue;
        }

        const currentTime = parseIsoTime(match?.metadata?.updatedAt) || parseIsoTime(match?.metadata?.createdAt);
        const existingTime = parseIsoTime(existing?.metadata?.updatedAt) || parseIsoTime(existing?.metadata?.createdAt);
        if (currentTime > existingTime) byText.set(normalized, match);
    }

    const out = Array.from(byText.values());
    if (opts.mode === "closest") {
        out.sort((a, b) => {
            const da = typeof a.distance === "number" ? a.distance : Number.POSITIVE_INFINITY;
            const db = typeof b.distance === "number" ? b.distance : Number.POSITIVE_INFINITY;
            return da - db;
        });
        return out;
    }

    out.sort((a, b) => {
        const ta = parseIsoTime(a?.metadata?.updatedAt) || parseIsoTime(a?.metadata?.createdAt);
        const tb = parseIsoTime(b?.metadata?.updatedAt) || parseIsoTime(b?.metadata?.createdAt);
        return tb - ta;
    });
    return out;
}

type SplitPrompt = { text: string; title?: string };

function logChunking(label: string, data: unknown) {
    if (!LOG_CHUNKING) return;
    console.log(`[chunking] ${label}`, data);
}

function normalizePromptText(text: string) {
    return text.replace(/\s+/g, " ").trim();
}

function slugifyTag(value: string) {
    const slug = value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");
    return slug || undefined;
}

function normalizeTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const tag of tags) {
        if (typeof tag !== "string") continue;
        const slug = slugifyTag(tag);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        normalized.push(slug);
        if (normalized.length >= 12) break;
    }
    return normalized.length ? normalized : undefined;
}

function extractInlineTitle(promptText: string): { title?: string; text: string } {
    const lines = promptText.replace(/\r\n/g, "\n").split("\n");
    const firstNonEmptyIndex = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIndex === -1) return { text: "" };

    const first = lines[firstNonEmptyIndex].trim();
    const rest = lines.slice(firstNonEmptyIndex + 1).join("\n").trim();

    // If the prompt starts with a heading-like label and has body text after it,
    // treat the label as the title and store the body as the prompt text.
    const markdownHeading = first.match(/^#{1,6}\s*(\d+)?[.)]?\s*(.+?)\s*$/);
    if (markdownHeading && rest) {
        return { title: markdownHeading[2], text: rest };
    }

    const numberedHeading = first.match(/^(\d+)[.)]\s+(.+?)\s*$/);
    if (numberedHeading && rest) {
        return { title: numberedHeading[2], text: rest };
    }

    return { text: promptText.trim() };
}

function inferTagsFromPrompt(title: string | undefined, promptText: string): string[] | undefined {
    const combined = `${title ?? ""}\n${promptText}`.toLowerCase();

    const categoryTags: string[] = [];
    const addCategory = (tag: string, re: RegExp) => {
        if (re.test(combined)) categoryTags.push(tag);
    };

    addCategory("coding", /\b(code|coding|debug|bug|refactor|clean code|framework|typescript|javascript|python|api)\b/);
    addCategory("marketing", /\b(marketing|content|brand|social|seo|newsletter)\b/);
    addCategory("productivity", /\b(productivity|eisenhower|time[- ]?block|schedule|deep work|tasks?)\b/);
    addCategory("writing", /\b(creative|write|writing|story|plot|chapter|protagonist|hero[’']?s journey)\b/);
    addCategory("learning", /\b(learn|learning|education|teach|feynman|explain|practice questions?)\b/);
    addCategory("image-generation", /\b(image|photo|photoreal|painting|3d|render|illustration)\b/);

    const stopwords = new Set([
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "based",
        "by",
        "can",
        "create",
        "for",
        "from",
        "generate",
        "i",
        "in",
        "include",
        "it",
        "of",
        "on",
        "or",
        "please",
        "provide",
        "the",
        "then",
        "this",
        "to",
        "use",
        "with",
        "you",
        "your",
    ]);

    const seed = title?.trim() || promptText.split("\n")[0]?.trim() || "";
    const keywordTags: string[] = [];
    const seen = new Set<string>();

    for (const rawToken of seed.split(/[^a-zA-Z0-9]+/g)) {
        const token = rawToken.toLowerCase();
        if (!token || token.length < 3) continue;
        if (stopwords.has(token)) continue;
        const slug = slugifyTag(token);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        keywordTags.push(slug);
        if (keywordTags.length >= 6) break;
    }

    const merged = normalizeTags([...categoryTags, ...keywordTags]);
    return merged?.length ? merged : undefined;
}

function splitPrompts(raw: string): SplitPrompt[] {
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const prompts: SplitPrompt[] = [];
    let currentLines: string[] = [];
    let currentTitle: string | undefined;

    const flush = () => {
        const joined = normalizePromptText(currentLines.join(" "));
        if (joined) prompts.push({ text: joined, title: currentTitle });
        currentLines = [];
        currentTitle = undefined;
    };

    const markdownNumberedHeading = (line: string) =>
        line.match(/^#{2,6}\s*(\d+)[.)]?\s+(.+?)\s*$/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            flush();
            continue;
        }

        // Markdown numbered headings like: "## 1. Coding & Development"
        const headingMatch = markdownNumberedHeading(trimmed);
        if (headingMatch) {
            flush();
            currentTitle = headingMatch[2];
            continue;
        }

        // Other markdown headings act like separators (don't store as prompt text).
        if (/^#{1,6}\s+/.test(trimmed)) {
            flush();
            continue;
        }

        const bulletMatch = trimmed.match(/^([-*•]+)\s+(.*)$/);
        const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
        if (bulletMatch) {
            flush();
            currentLines.push(bulletMatch[2]);
            continue;
        }
        if (numberedMatch) {
            flush();
            currentLines.push(numberedMatch[2]);
            continue;
        }

        // Continuation line of previous prompt
        currentLines.push(trimmed);
    }
    flush();

    // If split produced nothing (all whitespace), return empty.
    return prompts;
}

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
    templateUri: `ui://widget/prompt-suggestions-${WIDGET_VERSION}.html`,
    invoking: "Gathering prompt suggestions",
    invoked: "Prompt suggestions ready",
    assetName: `prompt-suggestions-${WIDGET_VERSION}`,
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
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Max number of prompts to return (default 3).",
        },
        maxDistance: {
            type: "number",
            minimum: 0,
            maximum: 2,
            description:
                "Optional similarity cutoff. When `query` is provided, only return matches with distance <= this value (lower is more similar).",
        },
        source: {
            type: "string",
            description: "Optional filter: only return prompts saved from this source.",
        },
        uploadId: {
            type: "string",
            description: "Optional filter: only return prompts from a specific uploadId batch.",
        },
        tagsAny: {
            type: "array",
            items: { type: "string" },
            description: "Optional filter: match prompts containing any of these tags.",
        },
        tagsAll: {
            type: "array",
            items: { type: "string" },
            description: "Optional filter: match prompts containing all of these tags.",
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
        prompts: {
            type: "array",
            description:
                "Preferred. Save multiple prompts in ONE call. If the user gives a blob containing many prompts, first extract them into this array. Include per-item `title` and `tags` when possible.",
            minItems: 1,
            items: {
                anyOf: [
                    { type: "string", description: "Prompt text." },
                    {
                        type: "object",
                        properties: {
                            text: { type: "string", description: "Prompt text." },
                            title: { type: "string", description: "Optional short title for this prompt." },
                            tags: {
                                type: "array",
                                items: { type: "string" },
                                description: "Optional tags for this prompt (recommended).",
                            },
                            source: { type: "string", description: "Optional source identifier for this prompt." },
                        },
                        required: ["text"],
                        additionalProperties: false,
                    },
                ],
            },
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
    required: ["prompts"],
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
        title: "Save prompt(s)",
        description:
            "Save one or more prompts for the authenticated user in a single call. Always pass `prompts` as an array; each item should be a standalone prompt.",
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
	                const title =
	                    typeof _request.params.arguments?.title === "string" ? _request.params.arguments.title : undefined;
	                const source =
	                    typeof _request.params.arguments?.source === "string" ? _request.params.arguments.source : undefined;
                const tags = normalizeTags(_request.params.arguments?.tags);

                const promptsArg = _request.params.arguments?.prompts;

                let promptsToSave: Array<{ text: string; title?: string; tags?: string[]; source?: string }> = [];

                if (Array.isArray(promptsArg)) {
	                    promptsToSave = promptsArg
	                        .map((item): { text: string; title?: string; tags?: string[]; source?: string } | null => {
	                            if (typeof item === "string") {
	                                const extracted = extractInlineTitle(item);
	                                const text = extracted.text.trim();
	                                if (!text) return null;
	                                const inferredTitle = extracted.title?.trim() || undefined;
	                                const finalTitle = title ?? inferredTitle;
	                                const finalTags = tags ?? inferTagsFromPrompt(finalTitle ?? inferredTitle, text);
	                                return { text, title: finalTitle, tags: finalTags, source };
	                            }
	                            if (item && typeof item === "object" && !Array.isArray(item)) {
	                                const rawText = typeof (item as any).text === "string" ? (item as any).text : "";
	                                const extracted = extractInlineTitle(rawText);
	                                const text = extracted.text.trim();
	                                if (!text) return null;
	                                const inferredTitle = extracted.title?.trim() || undefined;
	                                const itemTitle =
	                                    typeof (item as any).title === "string" ? (item as any).title.trim() : undefined;
	                                const itemSource = typeof (item as any).source === "string" ? (item as any).source : undefined;
	                                const itemTags = normalizeTags((item as any).tags);
	                                const finalTitle = itemTitle ?? title ?? inferredTitle;
	                                const finalTags =
	                                    itemTags ?? tags ?? inferTagsFromPrompt(finalTitle ?? inferredTitle, text);
	                                return {
	                                    text,
	                                    title: finalTitle,
	                                    tags: finalTags,
	                                    source: itemSource ?? source,
	                                };
	                            }
	                            return null;
	                        })
                        .filter((v): v is { text: string; title?: string; tags?: string[]; source?: string } => Boolean(v))
                        .slice(0, MAX_PROMPTS_PER_SAVE);

                    if (promptsArg.length > MAX_PROMPTS_PER_SAVE) {
                        return {
                            isError: true,
                            content: [
                                {
                                    type: "text",
                                    text: `Too many prompts in one save (${promptsArg.length}). Max allowed is ${MAX_PROMPTS_PER_SAVE}.`,
                                },
                            ],
                        } as any;
                    }
                } else {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Missing required input: `prompts` must be an array." }],
                    } as any;
                }

                if (promptsToSave.length === 0) {
                    return {
                        isError: true,
		                        content: [{ type: "text", text: "No valid prompts found to save." }],
		                    } as any;
		                }

                    // Deduplicate within the same request by normalized text.
                    const seen = new Set<string>();
                    promptsToSave = promptsToSave.filter((p) => {
                        const key = normalizePromptKey(p.text);
                        if (!key) return false;
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });

		                let indexName: string;
		                let uploadId: string | undefined;
		                let saved: Array<{ key: string }> = [];
                try {
                    if (promptsToSave.length === 1) {
                        const only = promptsToSave[0];
                        const result = await vectorStore.upsertPrompt(userSub, only.text, {
                            title: only.title,
                            tags: only.tags,
                            source: only.source,
                        });
                        indexName = result.indexName;
                        saved = [{ key: result.id }];
                    } else {
                        const result = await vectorStore.upsertPrompts(
                            userSub,
                            promptsToSave.map((p) => ({ text: p.text, title: p.title, tags: p.tags, source: p.source }))
                        );
                        indexName = result.indexName;
                        uploadId = result.uploadId;
                        saved = result.saved.map((s) => ({ key: s.key }));
                    }
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
                            text: promptsToSave.length === 1 ? "Prompt saved." : `Saved ${promptsToSave.length} prompts.`,
                        },
                    ],
                    structuredContent: {
                        status: "success",
                        indexName,
                        uploadId,
                        count: saved.length,
                        keys: saved.map((s) => s.key),
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
	                const tags = normalizeTags(_request.params.arguments?.tags);

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
            const limit =
                typeof _request.params.arguments?.limit === "number" && Number.isFinite(_request.params.arguments.limit)
                    ? Math.max(1, Math.min(20, Math.floor(_request.params.arguments.limit)))
                    : 3;
            const maxDistance =
                typeof _request.params.arguments?.maxDistance === "number" && Number.isFinite(_request.params.arguments.maxDistance)
                    ? Math.max(0, Math.min(2, _request.params.arguments.maxDistance))
                    : FETCH_PROMPT_MAX_DISTANCE;
            const filters: FetchPromptFilters = {
                source: normalizeString(_request.params.arguments?.source),
                uploadId: normalizeString(_request.params.arguments?.uploadId),
                tagsAny: normalizeStringArray(_request.params.arguments?.tagsAny),
                tagsAll: normalizeStringArray(_request.params.arguments?.tagsAll),
            };
            let matches: any[] = [];
            let prompts: string[] = [];
            try {
                const trimmedQuery = query.trim();
                matches = trimmedQuery
                    ? await vectorStore.queryPromptRecords(userSub, trimmedQuery, { topK: Math.min(200, limit * 10), returnDistance: true })
                    : await vectorStore.listPromptRecords(userSub, Math.min(200, limit * 10));

                matches = applyFetchPromptFilters(matches, filters);
                matches = dedupePromptMatches(matches, { mode: trimmedQuery ? "closest" : "newest" });
                if (trimmedQuery) {
                    const bestDistance = matches.reduce((best: number, m) => {
                        const d = typeof m.distance === "number" ? m.distance : Number.POSITIVE_INFINITY;
                        return d < best ? d : best;
                    }, Number.POSITIVE_INFINITY);
                    const relativeCutoff = Number.isFinite(bestDistance) ? bestDistance + FETCH_PROMPT_DISTANCE_DELTA : maxDistance;
                    const cutoff = Math.min(maxDistance, relativeCutoff);
                    matches = matches.filter((m) => {
                        const d = typeof m.distance === "number" ? m.distance : Number.POSITIVE_INFINITY;
                        return d <= cutoff;
                    });
                }
                prompts = matches
                    .map((m) => m?.metadata?.text)
                    .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
                    .slice(0, limit);
                matches = matches.slice(0, limit);
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
