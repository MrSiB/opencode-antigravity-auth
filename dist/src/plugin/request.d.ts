import { type HeaderStyle } from "../constants.js";
import { createStreamingTransformer, transformSseLine, transformStreamingPayload } from "./core/streaming/index.js";
import { type AccountManager, type ManagedAccount } from "./accounts.js";
import { type AntigravityDebugContext } from "./debug.js";
import { cleanModelName } from "./transform/model-resolver.js";
import { type Fingerprint } from "./fingerprint.js";
import type { GoogleSearchConfig } from "./transform/types.js";
declare function buildSignatureSessionKey(sessionId: string, model?: string, conversationKey?: string, projectKey?: string): string;
declare function hashConversationSeed(seed: string): string;
declare function extractTextFromContent(content: unknown): string;
declare function extractConversationSeedFromMessages(messages: any[]): string;
declare function extractConversationSeedFromContents(contents: any[]): string;
declare function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined;
export declare function resolveProjectKey(candidate?: unknown, headers?: unknown, fallback?: string): string | undefined;
export declare function resolveAgentKey(requestPayload?: unknown, headers?: unknown): string | undefined;
declare function isGeminiToolUsePart(part: any): boolean;
declare function isGeminiThinkingPart(part: any): boolean;
declare function ensureThoughtSignature(part: any, sessionId: string): any;
declare function hasSignedThinkingPart(part: any, sessionId?: string): boolean;
declare function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[];
declare function hasToolUseInContents(contents: any[]): boolean;
declare function hasSignedThinkingInContents(contents: any[], sessionId?: string): boolean;
declare function hasToolUseInMessages(messages: any[]): boolean;
declare function hasSignedThinkingInMessages(messages: any[], sessionId?: string): boolean;
declare function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[];
/**
 * Gets the stable session ID for this plugin instance.
 */
export declare function getPluginSessionId(): string;
/**
 * Checks if an HTTP response status or error message indicates that the model is unavailable
 * on the requested account tier (HTTP 404, NOT_FOUND, "Requested entity was not found").
 */
export declare function isModelUnavailableError(status: number, message?: string, bodyText?: string): boolean;
/**
 * Classifies API error responses into standardized error categories.
 * Maps HTTP 404 / NOT_FOUND / "Requested entity was not found" to "MODEL_UNAVAILABLE".
 */
export declare function classifyApiError(status: number, message?: string, bodyText?: string): string;
export interface TelemetryMetadata {
    id?: string | undefined;
    timestamp?: string | undefined;
    sessionId?: string | undefined;
    session_id?: string | undefined;
    sourceClient?: string | undefined;
    source_client?: string | undefined;
    requestOrigin?: string | undefined;
    request_origin?: string | undefined;
    statusCode?: number | undefined;
    status_code?: number | undefined;
    isStreaming?: boolean | undefined;
    is_streaming?: boolean | undefined;
    latencyMs?: number | undefined;
    latency_ms?: number | undefined;
    projectName?: string | undefined;
    project_name?: string | undefined;
    agentName?: string | undefined;
    agent_name?: string | undefined;
}
export interface TelemetryQueueItem {
    telemetryUrl: string | undefined;
    accountEmail: string | undefined;
    model: string | undefined;
    usage: {
        promptTokens?: number;
        candidateTokens?: number;
        totalTokens?: number;
    };
    telemetryApiKey?: string | undefined;
    id?: string | undefined;
    timestamp?: string | undefined;
    sessionId?: string | undefined;
    sourceClient?: string | undefined;
    requestOrigin?: string | undefined;
    statusCode?: number | undefined;
    isStreaming?: boolean | undefined;
    latencyMs?: number | undefined;
    projectName?: string | undefined;
    agentName?: string | undefined;
}
export declare function getTelemetryQueueSize(): number;
export declare function clearTelemetryQueue(): void;
export declare function flushTelemetryQueue(timeoutMs?: number): Promise<void>;
export declare function setupProcessExitFlusher(): void;
/**
 * Sends non-blocking async token usage telemetry to the configured status endpoint.
 */
export declare function reportTokenUsageTelemetry(telemetryUrl: string | undefined, accountEmail: string | undefined, model: string | undefined, usage: {
    promptTokens?: number;
    candidateTokens?: number;
    totalTokens?: number;
}, telemetryApiKey?: string | undefined, metadata?: TelemetryMetadata): void;
/**
 * Detects requests headed to the Google Generative Language API so we can intercept them.
 */
export declare function isGenerativeLanguageRequest(input: RequestInfo): boolean;
/**
 * Options for request preparation.
 */
export interface PrepareRequestOptions {
    /** Enable Claude tool hardening (parameter signatures + system instruction). Default: true */
    claudeToolHardening?: boolean;
    /** Enable top-level Claude prompt auto-caching (`cache_control`). Default: false */
    claudePromptAutoCaching?: boolean;
    /** Google Search configuration (global default) */
    googleSearch?: GoogleSearchConfig;
    /** Per-account fingerprint for rate limit mitigation. Falls back to session fingerprint if not provided. */
    fingerprint?: Fingerprint;
}
export declare function prepareAntigravityRequest(input: RequestInfo, init: RequestInit | undefined, accessToken: string, projectId: string, endpointOverride?: string, headerStyle?: HeaderStyle, forceThinkingRecovery?: boolean, options?: PrepareRequestOptions): {
    request: RequestInfo;
    init: RequestInit;
    streaming: boolean;
    requestedModel?: string;
    effectiveModel?: string;
    projectId?: string;
    endpoint?: string;
    sessionId?: string;
    toolDebugMissing?: number;
    toolDebugSummary?: string;
    toolDebugPayload?: string;
    needsSignedThinkingWarmup?: boolean;
    headerStyle: HeaderStyle;
    thinkingRecoveryMessage?: string;
    projectName?: string;
    agentName?: string;
};
export declare function buildThinkingWarmupBody(bodyText: string | undefined, isClaudeThinking: boolean): string | null;
/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export declare function transformAntigravityResponse(response: Response, streaming: boolean, debugContext?: AntigravityDebugContext | null, requestedModel?: string, projectId?: string, endpoint?: string, effectiveModel?: string, sessionId?: string, toolDebugMissing?: number, toolDebugSummary?: string, toolDebugPayload?: string, debugLines?: string[], account?: ManagedAccount, accountManager?: AccountManager, onTokenUsageCallback?: (usage: {
    promptTokens: number;
    candidateTokens: number;
    totalTokens: number;
}) => void): Promise<Response>;
export declare const __testExports: {
    buildSignatureSessionKey: typeof buildSignatureSessionKey;
    hashConversationSeed: typeof hashConversationSeed;
    extractTextFromContent: typeof extractTextFromContent;
    extractConversationSeedFromMessages: typeof extractConversationSeedFromMessages;
    extractConversationSeedFromContents: typeof extractConversationSeedFromContents;
    resolveConversationKey: typeof resolveConversationKey;
    resolveProjectKey: typeof resolveProjectKey;
    resolveAgentKey: typeof resolveAgentKey;
    isGeminiToolUsePart: typeof isGeminiToolUsePart;
    isGeminiThinkingPart: typeof isGeminiThinkingPart;
    ensureThoughtSignature: typeof ensureThoughtSignature;
    hasSignedThinkingPart: typeof hasSignedThinkingPart;
    hasSignedThinkingInContents: typeof hasSignedThinkingInContents;
    hasSignedThinkingInMessages: typeof hasSignedThinkingInMessages;
    hasToolUseInContents: typeof hasToolUseInContents;
    hasToolUseInMessages: typeof hasToolUseInMessages;
    ensureThinkingBeforeToolUseInContents: typeof ensureThinkingBeforeToolUseInContents;
    ensureThinkingBeforeToolUseInMessages: typeof ensureThinkingBeforeToolUseInMessages;
    MIN_SIGNATURE_LENGTH: number;
    transformSseLine: typeof transformSseLine;
    transformStreamingPayload: typeof transformStreamingPayload;
    createStreamingTransformer: typeof createStreamingTransformer;
    isModelUnavailableError: typeof isModelUnavailableError;
    classifyApiError: typeof classifyApiError;
    cleanModelName: typeof cleanModelName;
};
export {};
//# sourceMappingURL=request.d.ts.map