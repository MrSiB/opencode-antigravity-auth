import crypto from "node:crypto";
import {
  ANTIGRAVITY_ENDPOINT,
  GEMINI_CLI_ENDPOINT,
  GEMINI_CLI_HEADERS,
  EMPTY_SCHEMA_PLACEHOLDER_NAME,
  EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
  SKIP_THOUGHT_SIGNATURE,
  getRandomizedHeaders,
  type HeaderStyle,
} from "../constants.js";
import { cacheSignature, getCachedSignature } from "./cache.js";
import { getKeepThinking, loadConfig } from "./config/index.js";
import {
  createStreamingTransformer,
  transformSseLine,
  transformStreamingPayload,
} from "./core/streaming/index.js";
import { defaultSignatureStore } from "./stores/signature-store.js";
import {
  clearAccountVerificationRequired,
  type AccountManager,
  type ManagedAccount,
  type ModelFamily,
} from "./accounts.js";
import {
  DEBUG_MESSAGE_PREFIX,
  isDebugEnabled,
  isDebugTuiEnabled,
  logAntigravityDebugResponse,
  logCacheStats,
  type AntigravityDebugContext,
} from "./debug.js";
import { createLogger } from "./logger.js";
import {
  cleanJSONSchemaForAntigravity,
  DEFAULT_THINKING_BUDGET,
  deepFilterThinkingBlocks,
  extractThinkingConfig,
  extractVariantThinkingConfig,
  extractUsageFromSsePayload,
  extractUsageMetadata,
  fixToolResponseGrouping,
  validateAndFixClaudeToolPairing,
  applyToolPairingFixes,
  injectParameterSignatures,
  injectToolHardeningInstruction,
  isThinkingCapableModel,
  normalizeThinkingConfig,
  parseAntigravityApiBody,
  resolveThinkingConfig,
  rewriteAntigravityPreviewAccessError,
  transformThinkingParts,
  type AntigravityApiBody,
} from "./request-helpers.js";
import {
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  CLAUDE_DESCRIPTION_PROMPT,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
} from "../constants.js";
import {
  analyzeConversationState,
  closeToolLoopForThinking,
  needsThinkingRecovery,
} from "./thinking-recovery.js";
import { sanitizeCrossModelPayloadInPlace } from "./transform/cross-model-sanitizer.js";
import { isGemini3Model, isImageGenerationModel, buildImageGenerationConfig, applyGeminiTransforms } from "./transform/index.js";
import {
  cleanModelName,
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
  getModelFamily,
} from "./transform/model-resolver.js";
import {
  isClaudeModel,
  isClaudeThinkingModel,
  CLAUDE_THINKING_MAX_OUTPUT_TOKENS,
  type ThinkingTier,
} from "./transform/index.js";
import { detectErrorType } from "./recovery.js";
import { getSessionFingerprint, buildFingerprintHeaders, type Fingerprint } from "./fingerprint.js";
import type { GoogleSearchConfig } from "./transform/types.js";

const log = createLogger("request");

const PLUGIN_SESSION_ID = `-${crypto.randomUUID()}`;

const sessionDisplayedThinkingHashes = new Set<string>();

const MIN_SIGNATURE_LENGTH = 50;

function buildSignatureSessionKey(
  sessionId: string,
  model?: string,
  conversationKey?: string,
  projectKey?: string,
): string {
  const modelKey = typeof model === "string" && model.trim() ? model.toLowerCase() : "unknown";
  const projectPart = typeof projectKey === "string" && projectKey.trim()
    ? projectKey.trim()
    : "default";
  const conversationPart = typeof conversationKey === "string" && conversationKey.trim()
    ? conversationKey.trim()
    : "default";
  return `${sessionId}:${modelKey}:${projectPart}:${conversationPart}`;
}







function shouldCacheThinkingSignatures(model?: string): boolean {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  // Both Claude and Gemini 3 models require thought signature caching
  // for multi-turn conversations with function calling
  return lower.includes("claude") || lower.includes("gemini-3");
}

function hashConversationSeed(seed: string): string {
  return crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && Array.isArray((content as any).parts)) {
    return extractTextFromContent((content as any).parts);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const anyBlock = block as any;
    if (typeof anyBlock.text === "string") {
      return anyBlock.text;
    }
    if (anyBlock.text && typeof anyBlock.text === "object" && typeof anyBlock.text.text === "string") {
      return anyBlock.text.text;
    }
  }
  return "";
}

function extractConversationSeedFromMessages(messages: any[]): string {
  const system = messages.find((message) => message?.role === "system");
  const users = messages.filter((message) => message?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const systemText = system ? extractTextFromContent(system.content) : "";
  const userText = firstUser ? extractTextFromContent(firstUser.content) : "";
  const fallbackUserText = !userText && lastUser ? extractTextFromContent(lastUser.content) : "";
  return [systemText, userText || fallbackUserText].filter(Boolean).join("|");
}

function extractConversationSeedFromContents(contents: any[]): string {
  const users = contents.filter((content) => content?.role === "user");
  const firstUser = users[0];
  const lastUser = users.length > 0 ? users[users.length - 1] : undefined;
  const primaryUser = firstUser && Array.isArray(firstUser.parts) ? extractTextFromContent(firstUser.parts) : "";
  if (primaryUser) {
    return primaryUser;
  }
  if (lastUser && Array.isArray(lastUser.parts)) {
    return extractTextFromContent(lastUser.parts);
  }
  return "";
}

function resolveConversationKey(requestPayload: Record<string, unknown>): string | undefined {
  const anyPayload = requestPayload as any;
  const candidates = [
    anyPayload.conversationId,
    anyPayload.conversation_id,
    anyPayload.thread_id,
    anyPayload.threadId,
    anyPayload.chat_id,
    anyPayload.chatId,
    anyPayload.sessionId,
    anyPayload.session_id,
    anyPayload.metadata?.conversation_id,
    anyPayload.metadata?.conversationId,
    anyPayload.metadata?.thread_id,
    anyPayload.metadata?.threadId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const systemSeed = extractTextFromContent(
    (anyPayload.systemInstruction as any)?.parts
    ?? anyPayload.systemInstruction
    ?? anyPayload.system
    ?? anyPayload.system_instruction,
  );
  const messageSeed = Array.isArray(anyPayload.messages)
    ? extractConversationSeedFromMessages(anyPayload.messages)
    : Array.isArray(anyPayload.contents)
      ? extractConversationSeedFromContents(anyPayload.contents)
      : "";
  const seed = [systemSeed, messageSeed].filter(Boolean).join("|");
  if (!seed) {
    return undefined;
  }
  return `seed-${hashConversationSeed(seed)}`;
}

function resolveConversationKeyFromRequests(requestObjects: Array<Record<string, unknown>>): string | undefined {
  for (const req of requestObjects) {
    const key = resolveConversationKey(req);
    if (key) {
      return key;
    }
  }
  return undefined;
}

function getHeaderValue(headers: unknown, key: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (headers instanceof Headers || typeof (headers as any).get === "function") {
    const val = (headers as Headers).get(key) || (headers as Headers).get(key.toLowerCase());
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  const rec = headers as Record<string, unknown>;
  const lowerKey = key.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lowerKey) {
      const val = rec[k];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }
  return undefined;
}

export function resolveProjectKey(
  candidate?: unknown,
  headers?: unknown,
  fallback?: string,
): string | undefined {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }

  const headerKeys = ["X-OpenCode-Project", "X-Project"];
  for (const key of headerKeys) {
    const val = getHeaderValue(headers, key) ?? getHeaderValue(candidate, key);
    if (val) return val;
  }

  if (candidate && typeof candidate === "object" && !(candidate instanceof Headers)) {
    const payload = candidate as Record<string, unknown>;
    const metadata = (payload.metadata && typeof payload.metadata === "object")
      ? (payload.metadata as Record<string, unknown>)
      : undefined;

    const payloadCandidates = [
      payload.project,
      payload.project_name,
      payload.projectName,
      payload.project_path,
      payload.projectPath,
      metadata?.project,
      metadata?.project_name,
      metadata?.projectName,
      metadata?.project_path,
      metadata?.projectPath,
    ];

    for (const c of payloadCandidates) {
      if (typeof c === "string" && c.trim()) {
        return c.trim();
      }
    }
  }

  if (typeof headers === "string" && headers.trim()) {
    return headers.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }

  return undefined;
}

function extractSystemPromptText(payload: Record<string, unknown>): string {
  const payloadTarget = (payload.request && typeof payload.request === "object")
    ? (payload.request as Record<string, unknown>)
    : payload;

  const candidates = [
    payloadTarget.systemInstruction,
    payloadTarget.system_instruction,
    payloadTarget.systemInstructionText,
    payloadTarget.system,
    payload.systemInstruction,
    payload.system_instruction,
    payload.systemInstructionText,
    payload.system,
  ];

  for (const candidate of candidates) {
    const extracted = extractTextFromContent(candidate);
    if (extracted) return extracted;
  }

  const messagesList = Array.isArray(payloadTarget.messages)
    ? payloadTarget.messages
    : Array.isArray(payload.messages)
    ? payload.messages
    : undefined;

  if (messagesList) {
    const systemMsg = messagesList.find((m: any) => m?.role === "system");
    if (systemMsg) {
      const extracted = extractTextFromContent(systemMsg.content);
      if (extracted) return extracted;
    }

    for (const msg of messagesList) {
      if (msg && typeof msg === "object") {
        const text = extractTextFromContent((msg as any).content);
        if (text && (text.includes("<agent-identity>") || text.includes("designated identity") || text.includes("You are"))) {
          return text;
        }
      }
    }
  }

  return "";
}

function parseAgentFromSystemPrompt(text: string): string | undefined {
  if (!text || typeof text !== "string") return undefined;

  const identityMatch = text.match(/(?:Your designated identity for this session is|designated identity)[^"'\n]*["']?([A-Za-z0-9_-]+)["']?/i);
  if (identityMatch && identityMatch[1] && identityMatch[1].trim()) {
    const candidate = identityMatch[1].trim();
    const skip = new Set(["a", "an", "the", "session", "user"]);
    if (candidate && !skip.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes("sisyphus-junior") || lower.includes("sisyphus_junior")) return "Sisyphus-Junior";
  if (lower.includes("sisyphus") || lower.includes("sisiphus")) return "Sisyphus";
  if (lower.includes("oracle")) return "Oracle";
  if (lower.includes("metis")) return "Metis";
  if (lower.includes("momus")) return "Momus";
  if (lower.includes("explore")) return "Explore";
  if (lower.includes("librarian")) return "Librarian";
  if (lower.includes("frontend-ui-ux") || lower.includes("visual-engineering")) return "Frontend";
  if (lower.includes("hephaestus")) return "Hephaestus";
  if (lower.includes("multimodal-looker")) return "Multimodal-Looker";
  if (lower.includes("prometheus")) return "Prometheus";
  if (lower.includes("atlas")) return "Atlas";
  if (lower.includes("hermes")) return "Hermes";

  const quotedMatches = text.matchAll(/You are ["']([^"']+)["']/gi);
  for (const match of quotedMatches) {
    if (match && match[1] && match[1].trim()) {
      const candidate = match[1].trim();
      const skip = new Set(["a", "an", "the", "ready", "here", "acting", "going", "designed", "powered", "system", "antigravity", "ai coding assistant"]);
      if (!skip.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  const unquotedMatch = text.match(/You are ([A-Za-z0-9_-]+)(?:\s+|-|\.|,|$)/i);
  if (unquotedMatch && unquotedMatch[1]) {
    const candidate = unquotedMatch[1].trim();
    const skipWords = new Set(["a", "an", "the", "ready", "here", "acting", "going", "designed", "powered", "system", "antigravity"]);
    if (candidate && !skipWords.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return undefined;
}

export function normalizeAgentPersona(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();

  if (
    lower.includes("sisyphus-junior") ||
    lower.includes("sisyphus_junior") ||
    lower.includes("sisyphus junior")
  ) {
    return "Sisyphus-Junior";
  }

  if (
    lower.includes("sisyphus") ||
    lower.includes("sisiphus") ||
    lower.includes("orchestrator") ||
    lower.includes("orchestration")
  ) {
    return "Sisyphus";
  }

  if (lower.includes("oracle")) {
    return "Oracle";
  }

  if (lower.includes("metis")) {
    return "Metis";
  }

  if (lower.includes("momus")) {
    return "Momus";
  }

  if (lower.includes("explore")) {
    return "Explore";
  }

  if (lower.includes("librarian")) {
    return "Librarian";
  }

  if (
    lower.includes("frontend") ||
    lower.includes("visual-engineering") ||
    lower.includes("visual_engineering") ||
    lower.includes("visual engineering") ||
    lower.includes("ui-ux") ||
    lower.includes("ui_ux")
  ) {
    return "Frontend";
  }

  if (lower.includes("multimodal")) {
    return "Multimodal-Looker";
  }

  if (
    lower.includes("hephaestus") ||
    lower === "deep" ||
    lower.startsWith("deep-") ||
    lower.startsWith("deep_") ||
    lower.startsWith("deep ")
  ) {
    return "Hephaestus";
  }

  if (lower.includes("prometheus")) {
    return "Prometheus";
  }

  if (lower.includes("atlas")) {
    return "Atlas";
  }

  if (lower.includes("hermes")) {
    return "Hermes";
  }

  if (lower.includes("build") || lower.includes("general")) {
    return "Build";
  }

  return trimmed;
}

export function resolveAgentKey(
  requestPayload?: unknown,
  headers?: unknown,
): string | undefined {
  const headerKeys = ["X-OpenCode-Agent", "X-Agent"];
  for (const key of headerKeys) {
    const val = getHeaderValue(headers, key) ?? getHeaderValue(requestPayload, key);
    if (val) return normalizeAgentPersona(val);
  }

  if (typeof requestPayload === "string" && requestPayload.trim()) {
    const parsed = parseAgentFromSystemPrompt(requestPayload);
    return parsed ? normalizeAgentPersona(parsed) : undefined;
  }

  if (requestPayload && typeof requestPayload === "object" && !(requestPayload instanceof Headers)) {
    const payload = requestPayload as Record<string, unknown>;
    const reqObj = (payload.request && typeof payload.request === "object")
      ? (payload.request as Record<string, unknown>)
      : payload;
    const metadata = (payload.metadata && typeof payload.metadata === "object")
      ? (payload.metadata as Record<string, unknown>)
      : (reqObj.metadata && typeof reqObj.metadata === "object")
      ? (reqObj.metadata as Record<string, unknown>)
      : undefined;

    const systemText = extractSystemPromptText(payload);
    if (systemText) {
      const parsed = parseAgentFromSystemPrompt(systemText);
      if (parsed) {
        const normalized = normalizeAgentPersona(parsed);
        if (normalized) return normalized;
      }
    }

    const subagentCandidates = [
      payload.subagent,
      payload.subagent_type,
      payload.subagentType,
      reqObj.subagent,
      reqObj.subagent_type,
      reqObj.subagentType,
      metadata?.subagent,
      metadata?.subagent_type,
      metadata?.subagentType,
    ];

    for (const c of subagentCandidates) {
      if (typeof c === "string" && c.trim()) {
        const normalized = normalizeAgentPersona(c.trim());
        if (normalized) return normalized;
      }
    }

    const generalCandidates = [
      payload.agent_name,
      payload.agentName,
      reqObj.agent_name,
      reqObj.agentName,
      metadata?.agent_name,
      metadata?.agentName,
      payload.agent,
      reqObj.agent,
      metadata?.agent,
      payload.category,
      reqObj.category,
      metadata?.category,
    ];

    for (const c of generalCandidates) {
      if (typeof c === "string" && c.trim()) {
        const normalized = normalizeAgentPersona(c.trim());
        if (normalized) return normalized;
      }
    }
  }

  return undefined;
}

function formatDebugLinesForThinking(lines: string[]): string {
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-50);
  const prelude = `[ThinkingResolution] source=debug_tui lines=${cleaned.length}`;
  return `${DEBUG_MESSAGE_PREFIX}\n- ${prelude}\n${cleaned.map((line) => `- ${line}`).join("\n")}`;
}

function injectDebugThinking(response: unknown, debugText: string): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }

  const resp = response as any;

  if (Array.isArray(resp.candidates) && resp.candidates.length > 0) {
    const candidates = resp.candidates.slice();
    const first = candidates[0];

    if (
      first &&
      typeof first === "object" &&
      first.content &&
      typeof first.content === "object" &&
      Array.isArray(first.content.parts)
    ) {
      const parts = [{ thought: true, text: debugText }, ...first.content.parts];
      candidates[0] = { ...first, content: { ...first.content, parts } };
      return { ...resp, candidates };
    }

    return resp;
  }

  if (Array.isArray(resp.content)) {
    const content = [{ type: "thinking", thinking: debugText }, ...resp.content];
    return { ...resp, content };
  }

  if (!resp.reasoning_content) {
    return { ...resp, reasoning_content: debugText };
  }

  return resp;
}

/**
 * Synthetic thinking placeholder text used when keep_thinking=true but debug mode is off.
 * Injected via the same path as debug text (injectDebugThinking) to ensure consistent
 * signature caching and multi-turn handling.
 */
const SYNTHETIC_THINKING_PLACEHOLDER = "[Thinking preserved]\n";

function stripInjectedDebugFromParts(parts: unknown): unknown {
  if (!Array.isArray(parts)) {
    return parts;
  }

  return parts.filter((part) => {
    if (!part || typeof part !== "object") {
      return true;
    }

    const record = part as any;
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.thinking === "string"
          ? record.thinking
          : undefined;

    // Strip debug blocks and synthetic thinking placeholders
    if (text && (text.startsWith(DEBUG_MESSAGE_PREFIX) || text.startsWith(SYNTHETIC_THINKING_PLACEHOLDER.trim()))) {
      return false;
    }

    return true;
  });
}

function stripInjectedDebugFromRequestPayload(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents.map((content: any) => {
      if (!content || typeof content !== "object") {
        return content;
      }

      if (Array.isArray(content.parts)) {
        return { ...content, parts: stripInjectedDebugFromParts(content.parts) };
      }

      if (Array.isArray(content.content)) {
        return { ...content, content: stripInjectedDebugFromParts(content.content) };
      }

      return content;
    });
  }

  if (Array.isArray(anyPayload.messages)) {
    anyPayload.messages = anyPayload.messages.map((message: any) => {
      if (!message || typeof message !== "object") {
        return message;
      }

      if (Array.isArray(message.content)) {
        return { ...message, content: stripInjectedDebugFromParts(message.content) };
      }

      return message;
    });
  }
}

function isValidRequestPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const record = part as Record<string, unknown>;

  return (
    Object.prototype.hasOwnProperty.call(record, "text") ||
    Object.prototype.hasOwnProperty.call(record, "functionCall") ||
    Object.prototype.hasOwnProperty.call(record, "functionResponse") ||
    Object.prototype.hasOwnProperty.call(record, "inlineData") ||
    Object.prototype.hasOwnProperty.call(record, "fileData") ||
    Object.prototype.hasOwnProperty.call(record, "executableCode") ||
    Object.prototype.hasOwnProperty.call(record, "codeExecutionResult") ||
    Object.prototype.hasOwnProperty.call(record, "thought")
  );
}

function sanitizeRequestPayloadForAntigravity(payload: Record<string, unknown>): void {
  const anyPayload = payload as any;

  if (Array.isArray(anyPayload.contents)) {
    anyPayload.contents = anyPayload.contents
      .map((content: unknown) => {
        if (!content || typeof content !== "object") {
          return null;
        }

        const contentRecord = content as Record<string, unknown>;
        const rawParts = Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
        let foundFirstFunctionCall = false;

        const sanitizedParts = rawParts.filter(isValidRequestPart).map((part: any) => {
          if (part && typeof part === "object" && part.functionCall) {
            let sig = part.thoughtSignature || part.thought_signature;

            // Only the first functionCall part in a block should have the signature.
            // If it's the first one and missing a valid signature, inject the sentinel
            // to prevent the API from rejecting the request with a 400 error.
            if (!foundFirstFunctionCall) {
              foundFirstFunctionCall = true;
              if (!sig || sig.length < MIN_SIGNATURE_LENGTH) {
                sig = SKIP_THOUGHT_SIGNATURE;
              }
            } else {
              // Parallel function calls MUST NOT have a signature
              sig = undefined;
            }

            if (sig) {
              return { ...part, thought_signature: sig, thoughtSignature: sig };
            }
            
            // If not the first part, just return the part without adding any signature keys
            const newPart = { ...part };
            delete newPart.thoughtSignature;
            delete newPart.thought_signature;
            return newPart;
          }
          return part;
        });

        if (sanitizedParts.length === 0) {
          return null;
        }

        return {
          ...contentRecord,
          parts: sanitizedParts,
        };
      })
      .filter((content: unknown): content is Record<string, unknown> => content !== null);
  }

  const systemInstruction = anyPayload.systemInstruction;
  if (systemInstruction && typeof systemInstruction === "object" && !Array.isArray(systemInstruction)) {
    const sys = systemInstruction as Record<string, unknown>;
    if (Array.isArray(sys.parts)) {
      const sanitizedSystemParts = sys.parts.filter(isValidRequestPart);
      if (sanitizedSystemParts.length > 0) {
        sys.parts = sanitizedSystemParts;
      } else {
        delete anyPayload.systemInstruction;
      }
    }
  }
}

function isGeminiToolUsePart(part: any): boolean {
  return !!(part && typeof part === "object" && (part.functionCall || part.tool_use || part.toolUse));
}

function isGeminiThinkingPart(part: any): boolean {
  return !!(
    part &&
    typeof part === "object" &&
    (part.thought === true || part.type === "thinking" || part.type === "reasoning")
  );
}

// Sentinel value used when signature recovery fails - allows Claude to handle gracefully
// by redacting the thinking block instead of rejecting the request entirely.
// Reference: LLM-API-Key-Proxy uses this pattern for Gemini 3 tool calls.
const SENTINEL_SIGNATURE = "skip_thought_signature_validator";

function getThinkingPartText(part: any): string {
  if (!part || typeof part !== "object") {
    return "";
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (typeof part.thinking === "string") {
    return part.thinking;
  }

  return "";
}

function hasCachedMatchingSignature(part: any, sessionId: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return false;
  }

  const expectedSignature = getCachedSignature(sessionId, text);
  if (!expectedSignature) {
    return false;
  }

  if (part.thought === true) {
    return part.thoughtSignature === expectedSignature;
  }

  return part.signature === expectedSignature;
}

function ensureThoughtSignature(part: any, sessionId: string): any {
  if (!part || typeof part !== "object") {
    return part;
  }

  if (!sessionId) {
    return part;
  }

  const text = getThinkingPartText(part);
  if (!text) {
    return part;
  }

  if (part.thought === true) {
    return { ...part, thoughtSignature: SENTINEL_SIGNATURE };
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    return { ...part, signature: SENTINEL_SIGNATURE };
  }

  return part;
}

function hasSignedThinkingPart(part: any, sessionId?: string): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }

  if (part.thought === true) {
    if (part.thoughtSignature === SENTINEL_SIGNATURE || part.thoughtSignature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  if (part.type === "thinking" || part.type === "reasoning" || part.type === "redacted_thinking") {
    if (part.signature === SENTINEL_SIGNATURE || part.signature === SKIP_THOUGHT_SIGNATURE) {
      return true;
    }

    if (typeof part.signature !== "string" || part.signature.length < MIN_SIGNATURE_LENGTH) {
      return false;
    }

    if (!sessionId) {
      return true;
    }

    return hasCachedMatchingSignature(part, sessionId);
  }

  return false;
}

function ensureThinkingBeforeToolUseInContents(contents: any[], signatureSessionKey: string): any[] {
  return contents.map((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return content;
    }

    const role = content.role;
    if (role !== "model" && role !== "assistant") {
      return content;
    }

    const parts = content.parts as any[];
    const hasToolUse = parts.some(isGeminiToolUsePart);
    if (!hasToolUse) {
      return content;
    }

    const thinkingParts = parts.filter(isGeminiThinkingPart).map((p) => ensureThoughtSignature(p, signatureSessionKey));
    const otherParts = parts.filter((p) => !isGeminiThinkingPart(p));
    const hasSignedThinking = thinkingParts.some((part) => hasSignedThinkingPart(part, signatureSessionKey));

    if (hasSignedThinking) {
      return { ...content, parts: [...thinkingParts, ...otherParts] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {
      // No cached signature available - strip thinking blocks entirely
      // Claude requires valid signatures, and we can't fake them
      // Return only tool_use parts without any thinking to avoid signature validation errors
      log.debug("Stripping thinking from tool_use content (no valid cached signature)", { signatureSessionKey });
      return { ...content, parts: otherParts };
    }

    const injected = {
      thought: true,
      text: lastThinking.text,
      thoughtSignature: SENTINEL_SIGNATURE,
    };

    return { ...content, parts: [injected, ...otherParts] };
  });
}

function ensureMessageThinkingSignature(block: any, sessionId: string): any {
  if (!block || typeof block !== "object") {
    return block;
  }

  if (block.type !== "thinking" && block.type !== "redacted_thinking") {
    return block;
  }

  const text = getThinkingPartText(block);
  if (!text) {
    return block;
  }

  if (!sessionId) {
    return block;
  }

  return { ...block, signature: SKIP_THOUGHT_SIGNATURE };
}

function hasToolUseInContents(contents: any[]): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some(isGeminiToolUsePart);
  });
}

function hasSignedThinkingInContents(contents: any[], sessionId?: string): boolean {
  return contents.some((content: any) => {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      return false;
    }
    return (content.parts as any[]).some((part) => hasSignedThinkingPart(part, sessionId));
  });
}

function hasToolUseInMessages(messages: any[]): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some(
      (block) => block && typeof block === "object" && (block.type === "tool_use" || block.type === "tool_result"),
    );
  });
}

function hasSignedThinkingInMessages(messages: any[], sessionId?: string): boolean {
  return messages.some((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return false;
    }
    return (message.content as any[]).some((block) => hasSignedThinkingPart(block, sessionId));
  });
}

function ensureThinkingBeforeToolUseInMessages(messages: any[], signatureSessionKey: string): any[] {
  return messages.map((message: any) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      return message;
    }

    if (message.role !== "assistant") {
      return message;
    }

    const blocks = message.content as any[];
    const hasToolUse = blocks.some((b) => b && typeof b === "object" && (b.type === "tool_use" || b.type === "tool_result"));
    if (!hasToolUse) {
      return message;
    }

    const thinkingBlocks = blocks
      .filter((b) => b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking"))
      .map((b) => ensureMessageThinkingSignature(b, signatureSessionKey));

    const otherBlocks = blocks.filter((b) => !(b && typeof b === "object" && (b.type === "thinking" || b.type === "redacted_thinking")));
    const hasSignedThinking = thinkingBlocks.some((block) => hasSignedThinkingPart(block, signatureSessionKey));

    if (hasSignedThinking) {
      return { ...message, content: [...thinkingBlocks, ...otherBlocks] };
    }

    const lastThinking = defaultSignatureStore.get(signatureSessionKey);
    if (!lastThinking) {
      // No cached signature available - use sentinel to bypass validation
      // This handles cache miss scenarios (restart, session mismatch, expiry)
      const existingThinking = thinkingBlocks[0];
      const thinkingText = existingThinking?.thinking || existingThinking?.text || "";
      log.debug("Injecting sentinel signature (cache miss)", { signatureSessionKey });
      const sentinelBlock = {
        type: "thinking",
        thinking: thinkingText,
        signature: SKIP_THOUGHT_SIGNATURE,
      };
      return { ...message, content: [sentinelBlock, ...otherBlocks] };
    }

    const injected = {
      type: "thinking",
      thinking: lastThinking.text,
      signature: SKIP_THOUGHT_SIGNATURE,
    };

    return { ...message, content: [injected, ...otherBlocks] };
  });
}

/**
 * Gets the stable session ID for this plugin instance.
 */
export function getPluginSessionId(): string {
  return PLUGIN_SESSION_ID;
}

/**
 * Checks if an HTTP response status or error message indicates that the model is unavailable
 * on the requested account tier (HTTP 404, NOT_FOUND, "Requested entity was not found").
 */
export function isModelUnavailableError(status: number, message?: string, bodyText?: string): boolean {
  if (status === 404) return true;
  const combined = `${message ?? ""} ${bodyText ?? ""}`.toLowerCase();
  return (
    combined.includes("requested entity was not found") ||
    combined.includes("not_found") ||
    combined.includes("model_unavailable")
  );
}

/**
 * Classifies API error responses into standardized error categories.
 * Maps HTTP 404 / NOT_FOUND / "Requested entity was not found" to "MODEL_UNAVAILABLE".
 */
export function classifyApiError(status: number, message?: string, bodyText?: string): string {
  if (isModelUnavailableError(status, message, bodyText)) {
    return "MODEL_UNAVAILABLE";
  }
  if (status === 429 || status === 503 || status === 529) {
    return "RATE_LIMIT_EXCEEDED";
  }
  if (status === 400 && (message?.includes("API key not valid") || bodyText?.includes("API key not valid"))) {
    return "RATE_LIMIT_EXCEEDED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  return "UNKNOWN";
}

const STREAM_ACTION = "streamGenerateContent";

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
  usage: { promptTokens?: number; candidateTokens?: number; totalTokens?: number };
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

const MAX_TELEMETRY_QUEUE_SIZE = 1000;
const telemetryQueue: TelemetryQueueItem[] = [];
let isProcessingTelemetryQueue = false;

export function getTelemetryQueueSize(): number {
  return telemetryQueue.length;
}

export function clearTelemetryQueue(): void {
  telemetryQueue.length = 0;
  isProcessingTelemetryQueue = false;
}

async function processTelemetryQueue(): Promise<void> {
  if (isProcessingTelemetryQueue) return;
  isProcessingTelemetryQueue = true;

  try {
    while (telemetryQueue.length > 0) {
      const batch = telemetryQueue.splice(0, 10);
      if (batch.length === 0) break;

      await Promise.allSettled(
        batch.map(async (item) => {
          const url = item.telemetryUrl || (loadConfig() as Record<string, any>)?.telemetry_url || "https://llm.wdsa.ru/v1/status/record_usage";

          const isMockedFetch = typeof (fetch as any).mock === "object" && (fetch as any).mock !== null;
          if (process.env.VITEST && !isMockedFetch && url.includes("llm.wdsa.ru")) {
            return;
          }
          const email = item.accountEmail || "local-developer";
          const apiKey =
            item.telemetryApiKey ||
            (loadConfig() as Record<string, any>)?.telemetry_api_key ||
            process.env.TELEMETRY_API_KEY ||
            process.env.INTERNAL_SERVICE_SECRET ||
            "dev_internal_secret_key_12345";

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          };

          const bodyPayload: Record<string, any> = {
            id: item.id || crypto.randomUUID(),
            timestamp: item.timestamp || new Date().toISOString(),
            email,
            model: item.model,
            prompt_tokens: item.usage.promptTokens ?? 0,
            completion_tokens: item.usage.candidateTokens ?? 0,
            total_tokens: item.usage.totalTokens ?? 0,
          };

          if (item.sessionId !== undefined) bodyPayload.session_id = item.sessionId;
          if (item.sourceClient !== undefined) bodyPayload.source_client = item.sourceClient;
          if (item.requestOrigin !== undefined) bodyPayload.request_origin = item.requestOrigin;
          if (item.statusCode !== undefined) bodyPayload.status_code = item.statusCode;
          if (item.isStreaming !== undefined) bodyPayload.is_streaming = item.isStreaming;
          if (item.latencyMs !== undefined) bodyPayload.latency_ms = item.latencyMs;
          if (item.projectName !== undefined) bodyPayload.project_name = item.projectName;
          if (item.agentName !== undefined) bodyPayload.agent_name = item.agentName;

          try {
            const primaryRes = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(bodyPayload),
              signal: AbortSignal.timeout(1500),
            }).catch(() => null);

            if (!primaryRes || !primaryRes.ok) {
              const fallbackUrl = "http://127.0.0.1:8009/v1/status/record_usage";
              if (url !== fallbackUrl) {
                await fetch(fallbackUrl, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(bodyPayload),
                  signal: AbortSignal.timeout(1500),
                }).catch(() => null);
              }
            }
          } catch {
            // Silence network / fetch errors so OpenCode model requests never hang or fail
          }
        }),
      );
    }
  } catch {
  } finally {
    isProcessingTelemetryQueue = false;
  }
}

export async function flushTelemetryQueue(timeoutMs = 2000): Promise<void> {
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  const drainPromise = (async () => {
    while (telemetryQueue.length > 0 || isProcessingTelemetryQueue) {
      await processTelemetryQueue();
      if (telemetryQueue.length === 0 && !isProcessingTelemetryQueue) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  await Promise.race([drainPromise, timeoutPromise]);
}

let exitFlusherRegistered = false;

export function setupProcessExitFlusher(): void {
  if (exitFlusherRegistered) return;
  exitFlusherRegistered = true;

  const handleExit = async (signal: string) => {
    try {
      await flushTelemetryQueue(2000);
    } catch {
    } finally {
      if (!process.env.VITEST && signal !== "beforeExit") {
        process.exit(0);
      }
    }
  };

  process.on("beforeExit", () => { void handleExit("beforeExit"); });
  process.on("SIGINT", () => { void handleExit("SIGINT"); });
  process.on("SIGTERM", () => { void handleExit("SIGTERM"); });
}

setupProcessExitFlusher();

/**
 * Sends non-blocking async token usage telemetry to the configured status endpoint.
 */
export function reportTokenUsageTelemetry(
  telemetryUrl: string | undefined,
  accountEmail: string | undefined,
  model: string | undefined,
  usage: { promptTokens?: number; candidateTokens?: number; totalTokens?: number },
  telemetryApiKey?: string | undefined,
  metadata?: TelemetryMetadata,
): void {
  if (telemetryQueue.length >= MAX_TELEMETRY_QUEUE_SIZE) {
    telemetryQueue.shift();
  }

  const id = metadata?.id || crypto.randomUUID();
  const timestamp = metadata?.timestamp || new Date().toISOString();
  const sessionId = metadata?.sessionId ?? metadata?.session_id;
  const sourceClient = metadata?.sourceClient ?? metadata?.source_client;
  const requestOrigin = metadata?.requestOrigin ?? metadata?.request_origin;
  const statusCode = metadata?.statusCode ?? metadata?.status_code;
  const isStreaming = metadata?.isStreaming ?? metadata?.is_streaming;
  const latencyMs = metadata?.latencyMs ?? metadata?.latency_ms;
  const projectName = metadata?.projectName ?? metadata?.project_name;
  const agentName = metadata?.agentName ?? metadata?.agent_name;

  telemetryQueue.push({
    telemetryUrl,
    accountEmail: accountEmail || "local-developer",
    model,
    usage,
    telemetryApiKey,
    id,
    timestamp,
    sessionId,
    sourceClient,
    requestOrigin,
    statusCode,
    isStreaming,
    latencyMs,
    projectName,
    agentName,
  });

  void processTelemetryQueue();
}

/**
 * Detects requests headed to the Google Generative Language API so we can intercept them.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): boolean {
  const url = typeof input === "string" ? input : (input as Request)?.url || String(input);
  return (
    url.includes("generativelanguage.googleapis.com") ||
    url.includes("googleapis.com") ||
    url.includes("51128") ||
    url.includes("v1beta") ||
    url.includes("v1internal") ||
    url.includes("generateContent") ||
    url.includes("chat/completions")
  );
}

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

export function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  endpointOverride?: string,
  headerStyle: HeaderStyle = "antigravity",
  forceThinkingRecovery = false,
  options?: PrepareRequestOptions,
): {
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
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  let resolvedProjectId = projectId?.trim() || "";
  let projectName = resolveProjectKey(undefined, init?.headers) || resolveProjectKey(projectId);
  let agentName = resolveAgentKey(undefined, init?.headers);
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];
  let toolDebugPayload: string | undefined;
  let sessionId: string | undefined;
  let needsSignedThinkingWarmup = false;
  let thinkingRecoveryMessage: string | undefined;

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
      projectName,
      agentName,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("api-key");
  headers.delete("apikey");
  headers.delete("x-google-api-key");
  // Strip x-goog-user-project header to prevent 403 auth/license conflicts.
  // This header is added by OpenCode/AI SDK and can force project-level checks
  // that are not required for Antigravity/Gemini CLI OAuth requests.
  headers.delete("x-goog-user-project");

  const urlString = typeof input === "string" ? input : (input as Request)?.url || String(input);
  const match = urlString.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
      headerStyle,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const requestedModel = rawModel;

  const resolved = resolveModelForHeaderStyle(rawModel, headerStyle);
  let effectiveModel = resolved.actualModel;
  if (effectiveModel.toLowerCase().includes("image")) {
    effectiveModel = "gemini-3.6-flash-tiered";
  }

  const streaming = rawAction === STREAM_ACTION;
  const defaultEndpoint = headerStyle === "gemini-cli" ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
  const baseEndpoint = endpointOverride ?? defaultEndpoint;
  const transformedUrl = `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;

  const isClaude = isClaudeModel(resolved.actualModel);
  const isClaudeThinking = isClaudeThinkingModel(resolved.actualModel);
  const keepThinkingEnabled = getKeepThinking();
  const enableClaudePromptAutoCaching = options?.claudePromptAutoCaching ?? false;

  // Tier-based thinking configuration from model resolver (can be overridden by variant config)
  let tierThinkingBudget = resolved.thinkingBudget;
  let tierThinkingLevel = resolved.thinkingLevel;
  let signatureSessionKey = buildSignatureSessionKey(
    PLUGIN_SESSION_ID,
    effectiveModel,
    undefined,
    resolveProjectKey(projectId),
  );

  let body = baseInit.body;
  let bodyString = "";
  if (typeof baseInit.body === "string") {
    bodyString = baseInit.body;
  } else if (baseInit.body && Buffer.isBuffer(baseInit.body)) {
    bodyString = baseInit.body.toString("utf8");
  } else if (baseInit.body && (baseInit.body instanceof Uint8Array || baseInit.body instanceof ArrayBuffer)) {
    bodyString = Buffer.from(baseInit.body as any).toString("utf8");
  }

  if (bodyString) {
    try {
      const parsedBody = JSON.parse(bodyString) as Record<string, unknown>;
      projectName = resolveProjectKey(parsedBody, init?.headers) || resolveProjectKey(projectId);
      agentName = resolveAgentKey(parsedBody, init?.headers);
      const isWrapped = typeof parsedBody === "object" && parsedBody !== null && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>;
        delete wrappedBody.project;

        // Some callers may already send an Antigravity-wrapped body.
        // We still need to sanitize Claude thinking blocks (remove cache_control)
        // and attach a stable sessionId so multi-turn signature caching works.
        const requestRoot = wrappedBody.request;
        const requestObjects: Array<Record<string, unknown>> = [];

        if (requestRoot && typeof requestRoot === "object") {
          requestObjects.push(requestRoot as Record<string, unknown>);
          const nested = (requestRoot as any).request;
          if (nested && typeof nested === "object") {
            requestObjects.push(nested as Record<string, unknown>);
          }
        }

        const conversationKey = resolveConversationKeyFromRequests(requestObjects);
        // Strip tier suffix from model for cache key to prevent cache misses on tier change
        // e.g., "claude-opus-4-6-thinking-high" -> "claude-opus-4-6-thinking"
        const modelForCacheKey = effectiveModel.replace(/-(minimal|low|medium|high)$/i, "");
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, modelForCacheKey, conversationKey, resolveProjectKey(parsedBody.project));

        if (requestObjects.length > 0) {
          sessionId = signatureSessionKey;
        }

        for (const req of requestObjects) {
          // Use stable session ID for signature caching across multi-turn conversations
          (req as any).sessionId = signatureSessionKey;
          stripInjectedDebugFromRequestPayload(req as Record<string, unknown>);

          if (isClaude) {
            // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
            sanitizeCrossModelPayloadInPlace(req, { targetModel: effectiveModel });

            // Step 1: Strip corrupted/unsigned thinking blocks FIRST
            deepFilterThinkingBlocks(req, signatureSessionKey, getCachedSignature, true);

            if (enableClaudePromptAutoCaching && (req as any).cache_control === undefined) {
              (req as any).cache_control = { type: "ephemeral" };
            }

            // Step 2: THEN inject signed thinking from cache (after stripping)
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).contents)) {
              (req as any).contents = ensureThinkingBeforeToolUseInContents((req as any).contents, signatureSessionKey);
            }
            if (isClaudeThinking && keepThinkingEnabled && Array.isArray((req as any).messages)) {
              (req as any).messages = ensureThinkingBeforeToolUseInMessages((req as any).messages, signatureSessionKey);
            }

            // Step 3: Apply tool pairing fixes (ID assignment, response matching, orphan recovery)
            applyToolPairingFixes(req as Record<string, unknown>, true);
          }
        }

        if (isClaudeThinking && keepThinkingEnabled && sessionId) {
          const hasToolUse = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasToolUseInContents((req as any).contents)) ||
            (Array.isArray((req as any).messages) && hasToolUseInMessages((req as any).messages)),
          );
          const hasSignedThinking = requestObjects.some((req) =>
            (Array.isArray((req as any).contents) && hasSignedThinkingInContents((req as any).contents, signatureSessionKey)) ||
            (Array.isArray((req as any).messages) && hasSignedThinkingInMessages((req as any).messages, signatureSessionKey)),
          );
          const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
          needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
        }

        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const extraBody = requestPayload.extra_body as Record<string, unknown> | undefined;

        const variantConfig = extractVariantThinkingConfig(
          requestPayload.providerOptions as Record<string, unknown> | undefined,
          rawGenerationConfig
        );

        if (variantConfig) {
          const resolvedWithVariant = resolveModelWithVariant(effectiveModel, variantConfig);
          effectiveModel = resolvedWithVariant.actualModel;
          tierThinkingBudget = resolvedWithVariant.thinkingBudget;
          tierThinkingLevel = resolvedWithVariant.thinkingLevel;
        }

        const isGemini3 = effectiveModel.toLowerCase().includes("gemini-3");

        log.debug(`[ThinkingResolution] rawModel=${rawModel} resolvedModel=${effectiveModel} resolvedTier=${tierThinkingLevel ?? "none"} variantLevel=${variantConfig?.thinkingLevel ?? "none"} variantBudget=${variantConfig?.thinkingBudget ?? "none"} providerOptions.google=${JSON.stringify((requestPayload.providerOptions as any)?.google ?? null)} generationConfig.thinkingConfig=${JSON.stringify((rawGenerationConfig as any)?.thinkingConfig ?? null)}`);

        if (isClaude) {
          if (!requestPayload.toolConfig) {
            requestPayload.toolConfig = {};
          }
          if (typeof requestPayload.toolConfig === "object" && requestPayload.toolConfig !== null) {
            const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
            if (!toolConfig.functionCallingConfig) {
              toolConfig.functionCallingConfig = {};
            }
            if (typeof toolConfig.functionCallingConfig === "object" && toolConfig.functionCallingConfig !== null) {
              (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
            }
          }
        }

        // Resolve thinking configuration based on user settings and model capabilities
        // Image generation models don't support thinking - skip thinking config entirely
        const isImageModel = isImageGenerationModel(effectiveModel);
        const userThinkingConfig = isImageModel ? undefined : extractThinkingConfig(requestPayload, rawGenerationConfig, extraBody);
        const hasAssistantHistory = Array.isArray(requestPayload.contents) &&
          requestPayload.contents.some((c: any) => c?.role === "model" || c?.role === "assistant");

        // Claude Sonnet 4.6 is non-thinking only.
        // Ignore any client-provided thinkingConfig for this model.
        const lowerEffective = effectiveModel.toLowerCase();
        const isClaudeSonnetNonThinking = lowerEffective === "claude-sonnet-4-6";
        const effectiveUserThinkingConfig = (isClaudeSonnetNonThinking || isImageModel) ? undefined : userThinkingConfig;

        // For image models, add imageConfig instead of thinkingConfig
        if (isImageModel) {
          const imageConfig = buildImageGenerationConfig();
          const generationConfig = (rawGenerationConfig ?? {}) as Record<string, unknown>;
          generationConfig.imageConfig = imageConfig;
          // Remove any thinkingConfig that might have been set
          delete generationConfig.thinkingConfig;
          // Set reasonable defaults for image generation
          if (!generationConfig.candidateCount) {
            generationConfig.candidateCount = 1;
          }
          requestPayload.generationConfig = generationConfig;

          // Add safety settings for image generation (permissive to allow creative content)
          if (!requestPayload.safetySettings) {
            requestPayload.safetySettings = [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
            ];
          }

          // Image models don't support tools - remove them entirely
          delete requestPayload.tools;
          delete requestPayload.toolConfig;

          // Replace system instruction with a simple image generation prompt
          // Image models should not receive agentic coding assistant instructions
          requestPayload.systemInstruction = {
            parts: [{ text: "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request." }]
          };
        } else {
          const finalThinkingConfig = resolveThinkingConfig(
            effectiveUserThinkingConfig,
            isClaudeSonnetNonThinking ? false : (resolved.isThinkingModel ?? isThinkingCapableModel(effectiveModel)),
            isClaude,
            hasAssistantHistory,
          );

          const normalizedThinking = normalizeThinkingConfig(finalThinkingConfig);
          if (normalizedThinking) {
            // Use tier-based thinking budget if specified via model suffix, otherwise fall back to user config
            const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;

            // Build thinking config based on model type
            let thinkingConfig: Record<string, unknown>;

            if (isClaudeThinking) {
              // Claude uses snake_case keys
              thinkingConfig = {
                include_thoughts: normalizedThinking.includeThoughts ?? true,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0
                  ? { thinking_budget: thinkingBudget }
                  : {}),
              };
            } else if (tierThinkingLevel) {
              // Gemini 3 uses thinkingLevel string (low/medium/high)
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                thinkingLevel: tierThinkingLevel,
              };
            } else {
              // Gemini 2.5 and others use numeric budget
              thinkingConfig = {
                includeThoughts: normalizedThinking.includeThoughts,
                ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
              };
            }

            if (rawGenerationConfig) {
              rawGenerationConfig.thinkingConfig = thinkingConfig;

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                const currentMax = (rawGenerationConfig.maxOutputTokens ?? rawGenerationConfig.max_output_tokens) as number | undefined;
                if (!currentMax || currentMax <= thinkingBudget) {
                  rawGenerationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
                  if (rawGenerationConfig.max_output_tokens !== undefined) {
                    delete rawGenerationConfig.max_output_tokens;
                  }
                }
              }

              requestPayload.generationConfig = rawGenerationConfig;
            } else {
              const generationConfig: Record<string, unknown> = { thinkingConfig };

              if (isClaudeThinking && typeof thinkingBudget === "number" && thinkingBudget > 0) {
                generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
              }

              requestPayload.generationConfig = generationConfig;
            }
          } else if (rawGenerationConfig?.thinkingConfig) {
            delete rawGenerationConfig.thinkingConfig;
            requestPayload.generationConfig = rawGenerationConfig;
          }
        } // End of else block for non-image models

        // Clean up thinking fields from extra_body
        if (extraBody) {
          delete extraBody.thinkingConfig;
          delete extraBody.thinking;
        }
        delete requestPayload.thinkingConfig;
        delete requestPayload.thinking;

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        if (isClaudeThinking && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
          const hint = "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";
          const existing = requestPayload.systemInstruction;

          if (typeof existing === "string") {
            requestPayload.systemInstruction = existing.trim().length > 0 ? `${existing}\n\n${hint}` : hint;
          } else if (existing && typeof existing === "object") {
            const sys = existing as Record<string, unknown>;
            const partsValue = sys.parts;

            if (Array.isArray(partsValue)) {
              const parts = partsValue as unknown[];
              let appended = false;

              for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i];
                if (part && typeof part === "object") {
                  const partRecord = part as Record<string, unknown>;
                  const text = partRecord.text;
                  if (typeof text === "string") {
                    partRecord.text = `${text}\n\n${hint}`;
                    appended = true;
                    break;
                  }
                }
              }

              if (!appended) {
                parts.push({ text: hint });
              }
            } else {
              sys.parts = [{ text: hint }];
            }

            requestPayload.systemInstruction = sys;
          } else if (Array.isArray(requestPayload.contents)) {
            requestPayload.systemInstruction = { parts: [{ text: hint }] };
          }
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
            (requestPayload.extra_body as Record<string, unknown>).cachedContent
            : undefined;
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined);
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent;
        }

        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }

        // Normalize tools. For Claude models, keep full function declarations (names + schemas).
        const hasTools = Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0;

        if (hasTools) {
          if (isClaude) {
            const functionDeclarations: any[] = [];
            const passthroughTools: any[] = [];

            const normalizeSchema = (schema: any) => {
              const createPlaceholderSchema = (base: any = {}) => ({
                ...base,
                type: "object",
                properties: {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                },
                required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
              });

              if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              const cleaned = cleanJSONSchemaForAntigravity(schema);

              if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
                toolDebugMissing += 1;
                return createPlaceholderSchema();
              }

              // Claude VALIDATED mode requires tool parameters to be an object schema
              // with at least one property.
              const hasProperties =
                cleaned.properties &&
                typeof cleaned.properties === "object" &&
                Object.keys(cleaned.properties).length > 0;

              cleaned.type = "object";

              if (!hasProperties) {
                cleaned.properties = {
                  [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
                  },
                };
                cleaned.required = Array.isArray(cleaned.required)
                  ? Array.from(new Set([...cleaned.required, EMPTY_SCHEMA_PLACEHOLDER_NAME]))
                  : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
              }

              return cleaned;
            };

            (requestPayload.tools as any[]).forEach((tool: any) => {
              const pushDeclaration = (decl: any, source: string) => {
                const schema =
                  decl?.parameters ||
                  decl?.parametersJsonSchema ||
                  decl?.input_schema ||
                  decl?.inputSchema ||
                  tool.parameters ||
                  tool.parametersJsonSchema ||
                  tool.input_schema ||
                  tool.inputSchema ||
                  tool.function?.parameters ||
                  tool.function?.parametersJsonSchema ||
                  tool.function?.input_schema ||
                  tool.function?.inputSchema ||
                  tool.custom?.parameters ||
                  tool.custom?.parametersJsonSchema ||
                  tool.custom?.input_schema;

                let name =
                  decl?.name ||
                  tool.name ||
                  tool.function?.name ||
                  tool.custom?.name ||
                  `tool-${functionDeclarations.length}`;

                // Sanitize tool name: must be alphanumeric with underscores, no special chars
                name = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

                const description =
                  decl?.description ||
                  tool.description ||
                  tool.function?.description ||
                  tool.custom?.description ||
                  "";

                functionDeclarations.push({
                  name,
                  description: String(description || ""),
                  parameters: normalizeSchema(schema),
                });

                toolDebugSummaries.push(
                  `decl=${name},src=${source},hasSchema=${schema ? "y" : "n"}`,
                );
              };

              if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
                tool.functionDeclarations.forEach((decl: any) => pushDeclaration(decl, "functionDeclarations"));
                return;
              }

              // Fall back to function/custom style definitions.
              if (
                tool.function ||
                tool.custom ||
                tool.parameters ||
                tool.input_schema ||
                tool.inputSchema
              ) {
                pushDeclaration(tool.function ?? tool.custom ?? tool, "function/custom");
                return;
              }

              // Preserve any non-function tool entries (e.g., codeExecution) untouched.
              passthroughTools.push(tool);
            });

            const finalTools: any[] = [];
            if (functionDeclarations.length > 0) {
              finalTools.push({ functionDeclarations });
            }
            requestPayload.tools = finalTools.concat(passthroughTools);
          } else {
            // Gemini-specific tool normalization and feature injection
            const geminiResult = applyGeminiTransforms(requestPayload, {
              model: effectiveModel,
              normalizedThinking: undefined, // Thinking config already applied above (lines 816-880)
              tierThinkingBudget,
              tierThinkingLevel: tierThinkingLevel as ThinkingTier | undefined,
            });

            toolDebugMissing = geminiResult.toolDebugMissing;
            toolDebugSummaries.push(...geminiResult.toolDebugSummaries);
          }

          try {
            toolDebugPayload = JSON.stringify(requestPayload.tools);
          } catch {
            toolDebugPayload = undefined;
          }

          // Apply Claude tool hardening (ported from LLM-API-Key-Proxy)
          // Injects parameter signatures into descriptions and adds system instruction
          // Can be disabled via config.claude_tool_hardening = false to reduce context size
          const enableToolHardening = options?.claudeToolHardening ?? true;
          if (enableToolHardening && isClaude && Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
            // Inject parameter signatures into tool descriptions
            requestPayload.tools = injectParameterSignatures(
              requestPayload.tools,
              CLAUDE_DESCRIPTION_PROMPT,
            );

            // Inject tool hardening system instruction
            injectToolHardeningInstruction(
              requestPayload as Record<string, unknown>,
              CLAUDE_TOOL_SYSTEM_INSTRUCTION,
            );
          }
        }

        const conversationKey = resolveConversationKey(requestPayload);
        signatureSessionKey = buildSignatureSessionKey(PLUGIN_SESSION_ID, effectiveModel, conversationKey, resolveProjectKey(projectId));

        // For Claude models, filter out unsigned thinking blocks (required by Claude API)
        // Attempts to restore signatures from cache for multi-turn conversations
        // Handle both Gemini-style contents[] and Anthropic-style messages[] payloads.
        if (isClaude) {
          // Step 0: Sanitize cross-model metadata (strips Gemini signatures when sending to Claude)
          sanitizeCrossModelPayloadInPlace(requestPayload, { targetModel: effectiveModel });

          // Step 1: Strip corrupted/unsigned thinking blocks FIRST
          deepFilterThinkingBlocks(requestPayload, signatureSessionKey, getCachedSignature, true);

          if (enableClaudePromptAutoCaching && requestPayload.cache_control === undefined) {
            requestPayload.cache_control = { type: "ephemeral" };
          }

          // Step 2: THEN inject signed thinking from cache (after stripping)
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.contents)) {
            requestPayload.contents = ensureThinkingBeforeToolUseInContents(requestPayload.contents, signatureSessionKey);
          }
          if (isClaudeThinking && keepThinkingEnabled && Array.isArray(requestPayload.messages)) {
            requestPayload.messages = ensureThinkingBeforeToolUseInMessages(requestPayload.messages, signatureSessionKey);
          }

          // Step 3: Check if warmup needed (AFTER injection attempt)
          if (isClaudeThinking && keepThinkingEnabled) {
            const hasToolUse =
              (Array.isArray(requestPayload.contents) && hasToolUseInContents(requestPayload.contents)) ||
              (Array.isArray(requestPayload.messages) && hasToolUseInMessages(requestPayload.messages));
            const hasSignedThinking =
              (Array.isArray(requestPayload.contents) && hasSignedThinkingInContents(requestPayload.contents, signatureSessionKey)) ||
              (Array.isArray(requestPayload.messages) && hasSignedThinkingInMessages(requestPayload.messages, signatureSessionKey));
            const hasCachedThinking = defaultSignatureStore.has(signatureSessionKey);
            needsSignedThinkingWarmup = hasToolUse && !hasSignedThinking && !hasCachedThinking;
          }
        }

        // For Claude models, ensure functionCall/tool use parts carry IDs (required by Anthropic).
        // We use a two-pass approach: first collect all functionCalls and assign IDs,
        // then match functionResponses to their corresponding calls using a FIFO queue per function name.
        if (isClaude && Array.isArray(requestPayload.contents)) {
          let toolCallCounter = 0;
          // Track pending call IDs per function name as a FIFO queue
          const pendingCallIdsByName = new Map<string, string[]>();

          // First pass: assign IDs to all functionCalls and collect them
          requestPayload.contents = requestPayload.contents.map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionCall) {
                const call = { ...part.functionCall };
                if (!call.id) {
                  call.id = `tool-call-${++toolCallCounter}`;
                }
                const nameKey = typeof call.name === "string" ? call.name : `tool-${toolCallCounter}`;
                // Push to the queue for this function name
                const queue = pendingCallIdsByName.get(nameKey) || [];
                queue.push(call.id);
                pendingCallIdsByName.set(nameKey, queue);
                return { ...part, functionCall: call };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Second pass: match functionResponses to their corresponding calls (FIFO order)
          requestPayload.contents = (requestPayload.contents as any[]).map((content: any) => {
            if (!content || !Array.isArray(content.parts)) {
              return content;
            }

            const newParts = content.parts.map((part: any) => {
              if (part && typeof part === "object" && part.functionResponse) {
                const resp = { ...part.functionResponse };
                if (!resp.id && typeof resp.name === "string") {
                  const queue = pendingCallIdsByName.get(resp.name);
                  if (queue && queue.length > 0) {
                    // Consume the first pending ID (FIFO order)
                    resp.id = queue.shift();
                    pendingCallIdsByName.set(resp.name, queue);
                  }
                }
                return { ...part, functionResponse: resp };
              }
              return part;
            });

            return { ...content, parts: newParts };
          });

          // Third pass: Apply orphan recovery for mismatched tool IDs
          // This handles cases where context compaction or other processes
          // create ID mismatches between calls and responses.
          // Ported from LLM-API-Key-Proxy's _fix_tool_response_grouping()
          requestPayload.contents = fixToolResponseGrouping(requestPayload.contents as any[]);
        }

        // Fourth pass: Fix Claude format tool pairing (defense in depth)
        // Handles orphaned tool_use blocks in Claude's messages[] format
        if (Array.isArray(requestPayload.messages)) {
          requestPayload.messages = validateAndFixClaudeToolPairing(requestPayload.messages);
        }

        // =====================================================================
        // LAST RESORT RECOVERY: "Let it crash and start again"
        // =====================================================================
        // If after all our processing we're STILL in a bad state (tool loop without
        // thinking at turn start), don't try to fix it - just close the turn and
        // start fresh. This prevents permanent session breakage.
        //
        // This handles cases where:
        // - Context compaction stripped thinking blocks
        // - Signature cache miss
        // - Any other corruption we couldn't repair
        // - API error indicated thinking_block_order issue (forceThinkingRecovery=true)
        //
        // The synthetic messages allow Claude to generate fresh thinking on the
        // new turn instead of failing with "Expected thinking but found text".
        if (isClaudeThinking && Array.isArray(requestPayload.contents)) {
          const conversationState = analyzeConversationState(requestPayload.contents);

          // Force recovery if API returned thinking_block_order error (retry case)
          // or if proactive check detects we need recovery
          if (forceThinkingRecovery || needsThinkingRecovery(conversationState)) {
            // Set message for toast notification (shown in plugin.ts, respects quiet mode)
            thinkingRecoveryMessage = forceThinkingRecovery
              ? "Thinking recovery: retrying with fresh turn (API error)"
              : "Thinking recovery: restarting turn (corrupted context)";

            requestPayload.contents = closeToolLoopForThinking(requestPayload.contents);

            defaultSignatureStore.delete(signatureSessionKey);
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }
        if ("project" in requestPayload) {
          delete requestPayload.project;
        }

        stripInjectedDebugFromRequestPayload(requestPayload);
        sanitizeRequestPayloadForAntigravity(requestPayload);

        const effectiveProjectId = projectId?.trim() || "";
        resolvedProjectId = effectiveProjectId;

        // Inject Antigravity system instruction with role "user" (CLIProxyAPI v6.6.89 compatibility)
        // This sets request.systemInstruction.role = "user" and request.systemInstruction.parts[0].text
        if (headerStyle === "antigravity") {
          const existingSystemInstruction = requestPayload.systemInstruction;
          if (existingSystemInstruction && typeof existingSystemInstruction === "object") {
            const sys = existingSystemInstruction as Record<string, unknown>;
            sys.role = "user";
            if (Array.isArray(sys.parts) && sys.parts.length > 0) {
              const firstPart = sys.parts[0] as Record<string, unknown>;
              if (firstPart && typeof firstPart.text === "string") {
                firstPart.text = ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + firstPart.text;
              } else {
                sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...sys.parts];
              }
            } else {
              sys.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
            }
          } else if (typeof existingSystemInstruction === "string") {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION + "\n\n" + existingSystemInstruction }],
            };
          } else {
            requestPayload.systemInstruction = {
              role: "user",
              parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }],
            };
          }
        }

        let apiModel = effectiveModel;
        if (headerStyle === "antigravity" && isImageGenerationModel(effectiveModel)) {
          apiModel = "gemini-3.6-flash-tiered";
        }

        const wrappedBody: Record<string, unknown> = {
          model: apiModel,
          request: requestPayload,
        };

        if (headerStyle === "antigravity") {
          wrappedBody.requestType = "agent";
          wrappedBody.userAgent = "antigravity";
          wrappedBody.requestId = "agent-" + crypto.randomUUID();
        }
        if (wrappedBody.request && typeof wrappedBody.request === 'object') {
          // Use stable session ID for signature caching across multi-turn conversations
          sessionId = signatureSessionKey;
          (wrappedBody.request as any).sessionId = signatureSessionKey;
        }

        body = JSON.stringify(wrappedBody);
      }
    } catch (error) {
      throw error;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  // Add interleaved thinking header for Claude thinking models
  // This enables real-time streaming of thinking tokens
  if (isClaudeThinking) {
    const existing = headers.get("anthropic-beta");
    const interleavedHeader = "interleaved-thinking-2025-05-14";

    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`);
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader);
    }
  }

  if (headerStyle === "antigravity") {
    // Use randomized headers as the fallback pool for Antigravity mode
    const selectedHeaders = getRandomizedHeaders("antigravity", requestedModel);

    // Antigravity mode: Match Antigravity Manager behavior
    // AM only sends User-Agent on content requests — no X-Goog-Api-Client, no Client-Metadata header
    // (ideType=ANTIGRAVITY goes in request body metadata via project.ts, not as a header)
    const fingerprint = options?.fingerprint ?? getSessionFingerprint();
    const fingerprintHeaders = buildFingerprintHeaders(fingerprint);

    headers.set("User-Agent", fingerprintHeaders["User-Agent"] || selectedHeaders["User-Agent"]);
  } else {
    // Gemini CLI mode: match opencode-gemini-auth Code Assist header set exactly
    headers.set("User-Agent", GEMINI_CLI_HEADERS["User-Agent"]);
    headers.set("X-Goog-Api-Client", GEMINI_CLI_HEADERS["X-Goog-Api-Client"]);
    headers.set("Client-Metadata", GEMINI_CLI_HEADERS["Client-Metadata"]);
  }
  console.error("[ANTIGRAVITY REQUEST TO CLOUDCODE-PA]:", JSON.stringify(body).slice(0, 5000));
  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel,
    effectiveModel: effectiveModel,
    projectId: resolvedProjectId,
    endpoint: transformedUrl,
    sessionId,
    toolDebugMissing,
    toolDebugSummary: toolDebugSummaries.slice(0, 20).join(" | "),
    toolDebugPayload,
    needsSignedThinkingWarmup,
    headerStyle,
    thinkingRecoveryMessage,
    projectName,
    agentName,
  };
}

export function buildThinkingWarmupBody(
  bodyText: string | undefined,
  isClaudeThinking: boolean,
): string | null {
  if (!bodyText || !isClaudeThinking) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const warmupPrompt = "Warmup request for thinking signature.";

  const updateRequest = (req: Record<string, unknown>) => {
    req.contents = [{ role: "user", parts: [{ text: warmupPrompt }] }];
    delete req.tools;
    delete (req as any).toolConfig;

    const generationConfig = (req.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = {
      include_thoughts: true,
      thinking_budget: DEFAULT_THINKING_BUDGET,
    };
    generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    req.generationConfig = generationConfig;
  };

  if (parsed.request && typeof parsed.request === "object") {
    updateRequest(parsed.request as Record<string, unknown>);
    const nested = (parsed.request as any).request;
    if (nested && typeof nested === "object") {
      updateRequest(nested as Record<string, unknown>);
    }
  } else {
    updateRequest(parsed);
  }

  return JSON.stringify(parsed);
}

/**
 * Normalizes Antigravity responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 *
 * For streaming SSE responses, uses TransformStream for true real-time incremental streaming.
 * Thinking/reasoning tokens are transformed and forwarded immediately as they arrive.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  projectId?: string,
  endpoint?: string,
  effectiveModel?: string,
  sessionId?: string,
  toolDebugMissing?: number,
  toolDebugSummary?: string,
  toolDebugPayload?: string,
  debugLines?: string[],
  account?: ManagedAccount,
  accountManager?: AccountManager,
  onTokenUsageCallback?: (usage: { promptTokens: number; candidateTokens: number; totalTokens: number }) => void,
): Promise<Response> {
  if ((response.ok || response.status === 200) && account && account.verificationRequired) {
    if (accountManager) {
      accountManager.clearAccountVerificationRequired(account, true);
    } else {
      clearAccountVerificationRequired(account, true);
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  // Generate text for thinking injection:
  // - If debug=true: inject full debug logs
  // - If keep_thinking=true (but no debug): inject placeholder to trigger signature caching
  // Both use the same injection path (injectDebugThinking) for consistent behavior
  const debugText =
    isDebugTuiEnabled() && Array.isArray(debugLines) && debugLines.length > 0
      ? formatDebugLinesForThinking(debugLines)
      : getKeepThinking()
        ? SYNTHETIC_THINKING_PLACEHOLDER
        : undefined;
  const cacheSignatures = shouldCacheThinkingSignatures(effectiveModel);

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  // For successful streaming responses, use TransformStream to transform SSE events
  // while maintaining real-time streaming (no buffering of entire response).
  // This enables thinking tokens to be displayed as they arrive, like the Codex plugin.
  if (streaming && response.ok && isEventStreamResponse && response.body) {
    const headers = new Headers(response.headers);

    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE response (real-time transform)",
    });

    const modelFamily: ModelFamily = (effectiveModel || requestedModel || "").toLowerCase().includes("claude") ? "claude" : "gemini";
    const streamingTransformer = createStreamingTransformer(
      defaultSignatureStore,
      {
        onCacheSignature: cacheSignature,
        onInjectDebug: injectDebugThinking,
        // onInjectSyntheticThinking removed - keep_thinking now uses debugText path
        transformThinkingParts,
        onTokenUsage: (usage) => {
          if (account && accountManager) {
            accountManager.recordTokenUsage(account, modelFamily, usage.totalTokens);
          }
          if (onTokenUsageCallback) {
            onTokenUsageCallback(usage);
          } else {
            const config = loadConfig();
            reportTokenUsageTelemetry(
              config.telemetry_url,
              account?.email,
              effectiveModel || requestedModel,
              usage,
              config.telemetry_api_key,
              {
                sessionId,
                isStreaming: streaming,
                statusCode: response.status,
              },
            );
          }
        },
      },
      {
        signatureSessionKey: sessionId,
        debugText,
        cacheSignatures,
        displayedThinkingHashes: effectiveModel && isGemini3Model(effectiveModel) ? sessionDisplayedThinkingHashes : undefined,
        // injectSyntheticThinking removed - keep_thinking now unified with debug via debugText
      },
    );
    return new Response(response.body.pipeThrough(streamingTransformer), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const responseFallback = response.clone();

  try {
    const headers = new Headers(response.headers);
    const text = await response.text();

    if (!response.ok) {
      let errorBody;
      try {
        errorBody = JSON.parse(text);
      } catch {
        errorBody = { error: { message: text } };
      }

      // Inject Debug Info
      if (errorBody?.error) {
        const rawErrorMessage =
          typeof errorBody.error.message === "string" && errorBody.error.message.length > 0
            ? errorBody.error.message
            : "Unknown error";
        const isUnavailable = isModelUnavailableError(response.status, rawErrorMessage, text);
        if (isUnavailable) {
          headers.set("x-antigravity-error-classification", "MODEL_UNAVAILABLE");
          headers.set("x-antigravity-model-unavailable", "true");

          if (account) {
            if (account.verificationRequired) {
              if (accountManager) {
                accountManager.clearAccountVerificationRequired(account, true);
              } else {
                clearAccountVerificationRequired(account, true);
              }
            }
            const targetModel = effectiveModel || requestedModel;
            if (targetModel && accountManager) {
              const family: ModelFamily = targetModel.toLowerCase().includes("claude") ? "claude" : "gemini";
              accountManager.markRateLimited(account, 300_000, family, "antigravity", targetModel);
            }
          }
        }

        const errorType = detectErrorType(rawErrorMessage);
        const debugInfo = `\n\n[Debug Info]\nRequested Model: ${requestedModel || "Unknown"}\nEffective Model: ${effectiveModel || "Unknown"}\nProject: ${projectId || "Unknown"}\nEndpoint: ${endpoint || "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") || "N/A"}${toolDebugMissing !== undefined ? `\nTool Debug Missing: ${toolDebugMissing}` : ""}${toolDebugSummary ? `\nTool Debug Summary: ${toolDebugSummary}` : ""}${toolDebugPayload ? `\nTool Debug Payload: ${toolDebugPayload}` : ""}`;
        const injectedDebug = debugText ? `\n\n${debugText}` : "";
        errorBody.error.message = rawErrorMessage + debugInfo + injectedDebug;

        // Check if this is a recoverable thinking error - throw to trigger retry
        if (errorType === "thinking_block_order") {
          const recoveryError = new Error("THINKING_RECOVERY_NEEDED");
          (recoveryError as any).recoveryType = errorType;
          (recoveryError as any).originalError = errorBody;
          (recoveryError as any).debugInfo = debugInfo;
          throw recoveryError;
        }

        // Detect context length / prompt too long errors - signal to caller for toast
        const errorMessage = errorBody.error.message?.toLowerCase() || "";
        if (
          errorMessage.includes("prompt is too long") ||
          errorMessage.includes("context length exceeded") ||
          errorMessage.includes("context_length_exceeded") ||
          errorMessage.includes("maximum context length")
        ) {
          headers.set("x-antigravity-context-error", "prompt_too_long");
        }

        // Detect tool pairing errors - signal to caller for toast
        if (
          errorMessage.includes("tool_use") &&
          errorMessage.includes("tool_result") &&
          (errorMessage.includes("without") || errorMessage.includes("immediately after"))
        ) {
          headers.set("x-antigravity-context-error", "tool_pairing");
        }

        return new Response(JSON.stringify(errorBody), {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }

      if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
        const retryInfo = errorBody.error.details.find(
          (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        );

        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
          if (match && match[1]) {
            const retrySeconds = parseFloat(match[1]);
            if (!isNaN(retrySeconds) && retrySeconds > 0) {
              const retryAfterSec = Math.ceil(retrySeconds).toString();
              const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
              headers.set('Retry-After', retryAfterSec);
              headers.set('retry-after-ms', retryAfterMs);
            }
          }
        }
      }
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: AntigravityApiBody | null = !streaming || !isEventStreamResponse ? parseAntigravityApiBody(text) : null;
    const patched = parsed ? rewriteAntigravityPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    
    if (usage) {
      const config = loadConfig();
      reportTokenUsageTelemetry(
        config.telemetry_url,
        account?.email,
        effectiveModel || requestedModel,
        {
          promptTokens: usage.promptTokenCount ?? 0,
          candidateTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        },
        config.telemetry_api_key,
        {
          sessionId,
          isStreaming: streaming,
          statusCode: response.status,
        },
      );
    }

    // Log cache stats when available
    if (usage && effectiveModel) {
      logCacheStats(
        effectiveModel,
        usage.cachedContentTokenCount ?? 0,
        0, // API doesn't provide cache write tokens separately
        usage.promptTokenCount ?? usage.totalTokenCount ?? 0,
      );
    }
    
    if (usage?.cachedContentTokenCount !== undefined) {
      headers.set("x-antigravity-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-antigravity-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-antigravity-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-antigravity-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered fallback)" : undefined,
      headersOverride: headers,
    });

    // Note: successful streaming responses are handled above via TransformStream.
    // This path only handles non-streaming responses or failed streaming responses.

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      let responseBody: unknown = effectiveBody.response;
      // Inject thinking text (debug logs or "[Thinking preserved]" placeholder)
      // Both debug=true and keep_thinking=true use the same path now
      if (debugText) {
        responseBody = injectDebugThinking(responseBody, debugText);
      }
      const transformed = transformThinkingParts(responseBody);
      return new Response(JSON.stringify(transformed), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
      throw error;
    }

    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    return responseFallback;
  }
}

export const __testExports = {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveConversationKey,
  resolveProjectKey,
  resolveAgentKey,
  normalizeAgentPersona,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasSignedThinkingInContents,
  hasSignedThinkingInMessages,
  hasToolUseInContents,
  hasToolUseInMessages,
  ensureThinkingBeforeToolUseInContents,
  ensureThinkingBeforeToolUseInMessages,
  MIN_SIGNATURE_LENGTH,
  transformSseLine,
  transformStreamingPayload,
  createStreamingTransformer,
  isModelUnavailableError,
  classifyApiError,
  cleanModelName,
};
