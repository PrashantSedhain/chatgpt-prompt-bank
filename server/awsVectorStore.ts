import { randomUUID, createHash } from "node:crypto";

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
    CreateIndexCommand,
    DataType,
    DeleteVectorsCommand,
    GetIndexCommand,
    GetVectorsCommand,
    ListVectorsCommand,
    PutVectorsCommand,
    QueryVectorsCommand,
    type PutInputVector,
    S3VectorsClient,
    DistanceMetric,
} from "@aws-sdk/client-s3vectors";

export type AwsVectorStoreConfig = {
    s3VectorsArn: string;
    region: string;
    bedrockRegion: string;
    bedrockEmbeddingModelId: string;
};

export type PromptMetadata = {
    schemaVersion: 1;
    modelId: string;
    text: string;
    preview: string;
    title?: string;
    tags?: string[];
    source?: string;
    createdAt: string;
    updatedAt: string;
    length: number;
    wordCount: number;
};

export type PromptRecord = {
    key: string;
    distance?: number;
    metadata: PromptMetadata;
};

type ParsedS3VectorsArn = {
    region: string;
    accountId: string;
    bucketName: string;
};

function parseS3VectorsArn(arn: string): ParsedS3VectorsArn {
    // Example: arn:aws:s3vectors:us-east-1:559118953851:bucket/prompt-bank-vectors
    const parts = arn.split(":");
    if (parts.length < 6 || parts[0] !== "arn" || parts[2] !== "s3vectors") {
        throw new Error(`Invalid S3 Vectors ARN: ${arn}`);
    }
    const region = parts[3];
    const accountId = parts[4];
    const resource = parts.slice(5).join(":");
    const match = resource.match(/^bucket\/(.+)$/);
    if (!match) {
        throw new Error(`Invalid S3 Vectors ARN resource, expected bucket/<name>: ${arn}`);
    }
    return { region, accountId, bucketName: match[1] };
}

function userIndexName(userSub: string): string {
    // S3 Vectors index names are strict; keep it safe and deterministic:
    // - lowercase
    // - [a-z0-9-] only
    // - start/end alphanumeric
    // - keep <= 63 chars
    const lower = userSub.toLowerCase();
    const cleaned = lower
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");

    const hash = createHash("sha256").update(userSub).digest("hex").slice(0, 16);
    const base = cleaned.length > 0 ? `u-${cleaned}` : `u-${hash}`;

    if (base.length <= 63) return base;

    // Reserve space for "-<hash>"
    const suffix = `-${hash}`;
    const maxPrefix = 63 - suffix.length;
    const prefix = base.slice(0, maxPrefix).replace(/-+$/, "");
    return `${prefix}${suffix}`;
}

function toBedrockBodyJson(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

function fromBedrockBodyJson<T>(bytes: Uint8Array): T {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
}

function previewText(text: string, maxLen = 160): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen) return normalized;
    return normalized.slice(0, maxLen - 1).trimEnd() + "…";
}

function wordCount(text: string): number {
    const normalized = text.trim();
    if (!normalized) return 0;
    return normalized.split(/\s+/).filter(Boolean).length;
}

export class AwsVectorStore {
    private readonly config: AwsVectorStoreConfig;
    private readonly vectorsClient: S3VectorsClient;
    private readonly bedrockClient: BedrockRuntimeClient;
    private readonly vectorBucketName: string;
    private embeddingDimensionPromise: Promise<number> | null = null;

    constructor(config: AwsVectorStoreConfig) {
        this.config = config;
        const parsed = parseS3VectorsArn(config.s3VectorsArn);
        this.vectorBucketName = parsed.bucketName;

        const credentials = defaultProvider();

        this.vectorsClient = new S3VectorsClient({
            region: config.region || parsed.region,
            credentials,
        });

        this.bedrockClient = new BedrockRuntimeClient({
            region: config.bedrockRegion,
            credentials,
        });
    }

    private getEmbeddingDimension(): Promise<number> {
        if (!this.embeddingDimensionPromise) {
            this.embeddingDimensionPromise = this.embedText("dimension probe").then((v) => v.length);
        }
        return this.embeddingDimensionPromise;
    }

    async embedText(text: string): Promise<number[]> {
        // Titan Text Embeddings v2. Exact response shape can vary by model version;
        // we defensively accept either `embedding` or `embeddings[0]`.
        const command = new InvokeModelCommand({
            modelId: this.config.bedrockEmbeddingModelId,
            contentType: "application/json",
            accept: "application/json",
            body: toBedrockBodyJson({
                inputText: text,
            }),
        });

        const response = await this.bedrockClient.send(command);
        if (!response.body) throw new Error("Bedrock returned empty body");
        const bodyBytes: Uint8Array =
            typeof (response.body as any).transformToByteArray === "function"
                ? await (response.body as any).transformToByteArray()
                : (response.body as Uint8Array);
        const payload = fromBedrockBodyJson<any>(bodyBytes);

        const embedding =
            Array.isArray(payload?.embedding) ? payload.embedding :
            Array.isArray(payload?.embeddings) && Array.isArray(payload.embeddings[0]) ? payload.embeddings[0] :
            null;

        if (!Array.isArray(embedding) || !embedding.every((v) => typeof v === "number")) {
            throw new Error(`Unexpected embedding response shape: ${JSON.stringify(payload).slice(0, 500)}`);
        }
        return embedding as number[];
    }

    async ensureUserIndex(userSub: string): Promise<string> {
        const indexName = userIndexName(userSub);
        try {
            await this.vectorsClient.send(
                new GetIndexCommand({
                    vectorBucketName: this.vectorBucketName,
                    indexName,
                })
            );
            return indexName;
        } catch (error: any) {
            const name = typeof error?.name === "string" ? error.name : "";
            if (name && !name.toLowerCase().includes("notfound")) {
                // If it's a permissions/network error, surface it.
                throw error;
            }
        }

        const dimension = await this.getEmbeddingDimension();
        await this.vectorsClient.send(
            new CreateIndexCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                dataType: DataType.FLOAT32,
                dimension,
                distanceMetric: DistanceMetric.COSINE,
                metadataConfiguration: {
                    nonFilterableMetadataKeys: ["text", "preview"],
                },
            })
        );
        return indexName;
    }

    private async doesIndexExist(indexName: string): Promise<boolean> {
        try {
            await this.vectorsClient.send(
                new GetIndexCommand({
                    vectorBucketName: this.vectorBucketName,
                    indexName,
                })
            );
            return true;
        } catch (error: any) {
            const name = typeof error?.name === "string" ? error.name : "";
            if (name && name.toLowerCase().includes("notfound")) {
                return false;
            }
            throw error;
        }
    }

    async upsertPrompt(
        userSub: string,
        promptText: string,
        extra?: Pick<PromptMetadata, "title" | "tags" | "source">
    ): Promise<{ id: string; indexName: string; metadata: PromptMetadata }> {
        const indexName = await this.ensureUserIndex(userSub);
        const id = randomUUID();
        const vector = await this.embedText(promptText);

        const now = new Date().toISOString();
        const metadata: PromptMetadata = {
            schemaVersion: 1,
            modelId: this.config.bedrockEmbeddingModelId,
            text: promptText,
            preview: previewText(promptText),
            title: extra?.title?.trim() || undefined,
            tags: extra?.tags?.length ? extra.tags : undefined,
            source: extra?.source?.trim() || undefined,
            createdAt: now,
            updatedAt: now,
            length: promptText.length,
            wordCount: wordCount(promptText),
        };

        const record: PutInputVector = {
            key: id,
            data: { float32: vector },
            metadata,
        };

        await this.vectorsClient.send(
            new PutVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                vectors: [record],
            })
        );

        return { id, indexName, metadata };
    }

    async deletePrompt(userSub: string, key: string): Promise<{ indexName: string; deleted: boolean }> {
        const indexName = userIndexName(userSub);
        const exists = await this.doesIndexExist(indexName);
        if (!exists) {
            return { indexName, deleted: false };
        }

        await this.vectorsClient.send(
            new DeleteVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                keys: [key],
            })
        );

        return { indexName, deleted: true };
    }

    async updatePrompt(
        userSub: string,
        key: string,
        promptText: string,
        extra?: Pick<PromptMetadata, "title" | "tags" | "source">
    ): Promise<{ indexName: string; metadata: PromptMetadata }> {
        const indexName = userIndexName(userSub);
        const exists = await this.doesIndexExist(indexName);
        if (!exists) {
            throw new Error("User index does not exist");
        }

        const existing = await this.vectorsClient.send(
            new GetVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                keys: [key],
                returnMetadata: true,
            })
        );

        const existingVector = Array.isArray(existing.vectors) ? existing.vectors[0] : undefined;
        const existingMetadataRaw = existingVector?.metadata;
        const existingMetadata =
            existingMetadataRaw && typeof existingMetadataRaw === "object" && !Array.isArray(existingMetadataRaw)
                ? (existingMetadataRaw as Partial<PromptMetadata>)
                : {};

        const now = new Date().toISOString();
        const metadata: PromptMetadata = {
            schemaVersion: 1,
            modelId: this.config.bedrockEmbeddingModelId,
            text: promptText,
            preview: previewText(promptText),
            title: extra?.title?.trim() || existingMetadata.title || undefined,
            tags: extra?.tags?.length ? extra.tags : existingMetadata.tags || undefined,
            source: extra?.source?.trim() || existingMetadata.source || undefined,
            createdAt: existingMetadata.createdAt || now,
            updatedAt: now,
            length: promptText.length,
            wordCount: wordCount(promptText),
        };

        const vector = await this.embedText(promptText);
        const record: PutInputVector = {
            key,
            data: { float32: vector },
            metadata,
        };

        await this.vectorsClient.send(
            new PutVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                vectors: [record],
            })
        );

        return { indexName, metadata };
    }

    async queryPromptRecords(userSub: string, queryText: string, k = 4): Promise<PromptRecord[]> {
        const indexName = await this.ensureUserIndex(userSub);
        const queryVector = await this.embedText(queryText);

        const result = await this.vectorsClient.send(
            new QueryVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                queryVector: { float32: queryVector },
                topK: k,
                returnMetadata: true,
            })
        );

        const vectors = Array.isArray(result.vectors) ? result.vectors : [];
        return vectors
            .map((v): PromptRecord | null => {
                const metadata = v.metadata;
                if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
                const text = (metadata as any).text;
                if (typeof v.key !== "string" || typeof text !== "string" || !text.trim()) return null;
                const distance = typeof v.distance === "number" ? v.distance : undefined;
                return {
                    key: v.key,
                    ...(distance !== undefined ? { distance } : {}),
                    metadata: metadata as PromptMetadata,
                };
            })
            .filter((v): v is PromptRecord => v !== null)
            .slice(0, k);
    }

    async listPromptRecords(userSub: string, limit = 4): Promise<PromptRecord[]> {
        const indexName = await this.ensureUserIndex(userSub);
        const result = await this.vectorsClient.send(
            new ListVectorsCommand({
                vectorBucketName: this.vectorBucketName,
                indexName,
                maxResults: limit,
                returnMetadata: true,
            })
        );

        const vectors = Array.isArray(result.vectors) ? result.vectors : [];
        return vectors
            .map((v): PromptRecord | null => {
                const metadata = v.metadata;
                if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
                const text = (metadata as any).text;
                if (typeof v.key !== "string" || typeof text !== "string" || !text.trim()) return null;
                return { key: v.key, metadata: metadata as PromptMetadata };
            })
            .filter((v): v is PromptRecord => v !== null)
            .slice(0, limit);
    }
}
