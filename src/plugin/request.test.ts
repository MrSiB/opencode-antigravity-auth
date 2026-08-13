import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  prepareAntigravityRequest,
  transformAntigravityResponse,
  getPluginSessionId,
  isGenerativeLanguageRequest,
  reportTokenUsageTelemetry,
  clearTelemetryQueue,
  getTelemetryQueueSize,
  flushTelemetryQueue,
  __testExports,
} from "./request.js";
import { DEFAULT_CONFIG } from "./config/index.js";
import { initializeDebug } from "./debug.js";
import { SKIP_THOUGHT_SIGNATURE } from "../constants.js";
import * as config from "./config/index.js";
import type { SignatureStore, ThoughtBuffer, StreamingCallbacks, StreamingOptions } from "./core/streaming/types.js";

const {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveProjectKey,
  resolveAgentKey,
  isGeminiToolUsePart,
  isGeminiThinkingPart,
  ensureThoughtSignature,
  hasSignedThinkingPart,
  hasToolUseInContents,
  hasSignedThinkingInContents,
  hasToolUseInMessages,
  hasSignedThinkingInMessages,
  MIN_SIGNATURE_LENGTH,
  transformStreamingPayload,
  createStreamingTransformer,
  transformSseLine,
} = __testExports;

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) => store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
  };
}

function createMockThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (idx: number) => buffer.get(idx),
    set: (idx: number, text: string) => buffer.set(idx, text),
    clear: () => buffer.clear(),
  };
}

const defaultCallbacks: StreamingCallbacks = {};
const defaultOptions: StreamingOptions = {};
const defaultDebugState = { injected: false };

function withKeepThinking<T>(enabled: boolean, fn: () => T): T {
  const keepThinkingSpy = vi.spyOn(config, "getKeepThinking").mockReturnValue(enabled);
  try {
    return fn();
  } finally {
    keepThinkingSpy.mockRestore();
  }
}

describe("request.ts", () => {
  describe("getPluginSessionId", () => {
    it("returns consistent session ID across calls", () => {
      const id1 = getPluginSessionId();
      const id2 = getPluginSessionId();
      expect(id1).toBe(id2);
      expect(id1).toBeTruthy();
    });
  });

  describe("isGenerativeLanguageRequest", () => {
    it("returns true for generativelanguage.googleapis.com URLs", () => {
      expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1/models")).toBe(true);
    });

    it("returns false for other URLs", () => {
      expect(isGenerativeLanguageRequest("https://api.anthropic.com/v1/messages")).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      expect(isGenerativeLanguageRequest({} as any)).toBe(false);
      expect(isGenerativeLanguageRequest(new Request("https://example.com"))).toBe(false);
    });
  });

  describe("buildSignatureSessionKey", () => {
    it("builds key from sessionId, model, project, and conversation", () => {
      const key = buildSignatureSessionKey("session-1", "claude-3", "conv-456", "proj-123");
      expect(key).toBe("session-1:claude-3:proj-123:conv-456");
    });

    it("uses defaults for missing optional params", () => {
      expect(buildSignatureSessionKey("s1", undefined, undefined, undefined)).toBe("s1:unknown:default:default");
      expect(buildSignatureSessionKey("s1", "model", undefined, undefined)).toBe("s1:model:default:default");
    });

    it("handles empty strings as defaults", () => {
      expect(buildSignatureSessionKey("s1", "", "", "")).toBe("s1:unknown:default:default");
    });
  });

  describe("hashConversationSeed", () => {
    it("returns consistent hash for same input", () => {
      const hash1 = hashConversationSeed("test-seed");
      const hash2 = hashConversationSeed("test-seed");
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different inputs", () => {
      const hash1 = hashConversationSeed("seed-1");
      const hash2 = hashConversationSeed("seed-2");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", () => {
      const hash = hashConversationSeed("");
      expect(hash).toBeTruthy();
    });
  });

  describe("extractTextFromContent", () => {
    it("extracts text from string content", () => {
      expect(extractTextFromContent("hello world")).toBe("hello world");
    });

    it("extracts first text from content array with text blocks", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ];
      expect(extractTextFromContent(content)).toBe("hello");
    });

    it("returns empty string for non-text blocks", () => {
      const content = [{ type: "image", source: {} }];
      expect(extractTextFromContent(content)).toBe("");
    });

    it("returns first text block only (not concatenated)", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "image", source: {} },
        { type: "text", text: "after" },
      ];
      expect(extractTextFromContent(content)).toBe("before");
    });

    it("returns empty string for null/undefined", () => {
      expect(extractTextFromContent(null)).toBe("");
      expect(extractTextFromContent(undefined)).toBe("");
    });
  });

  describe("extractConversationSeedFromMessages", () => {
    it("extracts seed from first user message", () => {
      const messages = [
        { role: "user", content: "first message" },
        { role: "assistant", content: "response" },
      ];
      const seed = extractConversationSeedFromMessages(messages);
      expect(seed).toContain("first message");
    });

    it("returns empty string when no user messages", () => {
      const messages = [{ role: "assistant", content: "response" }];
      expect(extractConversationSeedFromMessages(messages)).toBe("");
    });

    it("handles empty messages array", () => {
      expect(extractConversationSeedFromMessages([])).toBe("");
    });
  });

  describe("extractConversationSeedFromContents", () => {
    it("extracts seed from first user content", () => {
      const contents = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
      ];
      const seed = extractConversationSeedFromContents(contents);
      expect(seed).toContain("hello");
    });

    it("returns empty string when no user content", () => {
      const contents = [{ role: "model", parts: [{ text: "hi" }] }];
      expect(extractConversationSeedFromContents(contents)).toBe("");
    });
  });

  describe("resolveProjectKey", () => {
    it("returns candidate if it is a string", () => {
      expect(resolveProjectKey("my-project")).toBe("my-project");
    });

    it("returns fallback if candidate is not a string or object", () => {
      expect(resolveProjectKey(null, undefined, "fallback")).toBe("fallback");
      expect(resolveProjectKey(undefined, undefined, "fallback")).toBe("fallback");
      expect(resolveProjectKey({}, undefined, "fallback")).toBe("fallback");
    });

    it("extracts project key from headers X-OpenCode-Project or X-Project", () => {
      const headers1 = new Headers({ "X-OpenCode-Project": "proj-opencode-header" });
      expect(resolveProjectKey({}, headers1)).toBe("proj-opencode-header");

      const headers2 = { "x-project": "proj-x-header" };
      expect(resolveProjectKey({}, headers2)).toBe("proj-x-header");
    });

    it("extracts project key from request payload fields (project, project_name, project_path, metadata.project)", () => {
      expect(resolveProjectKey({ project: "proj-1" })).toBe("proj-1");
      expect(resolveProjectKey({ project_name: "proj-2" })).toBe("proj-2");
      expect(resolveProjectKey({ projectName: "proj-3" })).toBe("proj-3");
      expect(resolveProjectKey({ project_path: "/workspace/proj-4" })).toBe("/workspace/proj-4");
      expect(resolveProjectKey({ metadata: { project: "proj-5" } })).toBe("proj-5");
      expect(resolveProjectKey({ metadata: { project_name: "proj-6" } })).toBe("proj-6");
      expect(resolveProjectKey({ metadata: { project_path: "/workspace/proj-7" } })).toBe("/workspace/proj-7");
    });

    it("returns undefined if no valid candidate, header, payload field, or fallback", () => {
      expect(resolveProjectKey(null)).toBeUndefined();
      expect(resolveProjectKey(undefined)).toBeUndefined();
      expect(resolveProjectKey({})).toBeUndefined();
    });
  });

  describe("resolveAgentKey", () => {
    it("extracts agent key from headers X-OpenCode-Agent or X-Agent", () => {
      const headers1 = new Headers({ "X-OpenCode-Agent": "agent-opencode-header" });
      expect(resolveAgentKey({}, headers1)).toBe("agent-opencode-header");

      const headers2 = { "x-agent": "agent-x-header" };
      expect(resolveAgentKey({}, headers2)).toBe("agent-x-header");
    });

    it("extracts agent key from payload fields (agent, agent_name, subagent, subagent_type, metadata.agent)", () => {
      expect(resolveAgentKey({ agent: "agent-1" })).toBe("agent-1");
      expect(resolveAgentKey({ agent_name: "agent-2" })).toBe("agent-2");
      expect(resolveAgentKey({ subagent: "agent-3" })).toBe("agent-3");
      expect(resolveAgentKey({ subagent_type: "explore" })).toBe("explore");
      expect(resolveAgentKey({ metadata: { agent: "agent-4" } })).toBe("agent-4");
      expect(resolveAgentKey({ metadata: { subagent_type: "librarian" } })).toBe("librarian");
    });

    it("parses persona from system prompt text using regex ('You are \"...\"' or 'You are ...')", () => {
      expect(resolveAgentKey({ systemInstruction: { parts: [{ text: 'You are "Sisyphus-Junior" - a focused task executor' }] } })).toBe("Sisyphus-Junior");
      expect(resolveAgentKey({ system_instruction: { parts: [{ text: "You are 'Oracle'" }] } })).toBe("Oracle");
      expect(resolveAgentKey({ system: "You are explore" })).toBe("explore");
      expect(resolveAgentKey({ messages: [{ role: "system", content: "You are librarian" }] })).toBe("librarian");
    });

    it("returns undefined when no agent or persona can be resolved", () => {
      expect(resolveAgentKey(null)).toBeUndefined();
      expect(resolveAgentKey(undefined)).toBeUndefined();
      expect(resolveAgentKey({})).toBeUndefined();
      expect(resolveAgentKey({ system: "You are a helpful assistant" })).toBeUndefined();
    });
  });

  describe("isGeminiToolUsePart", () => {
    it("returns true for functionCall parts", () => {
      expect(isGeminiToolUsePart({ functionCall: { name: "test" } })).toBe(true);
    });

    it("returns false for non-functionCall parts", () => {
      expect(isGeminiToolUsePart({ text: "hello" })).toBe(false);
      expect(isGeminiToolUsePart({ thought: true })).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isGeminiToolUsePart(null)).toBe(false);
      expect(isGeminiToolUsePart(undefined)).toBe(false);
    });
  });

  describe("isGeminiThinkingPart", () => {
    it("returns true for thought:true parts", () => {
      expect(isGeminiThinkingPart({ thought: true, text: "thinking..." })).toBe(true);
    });

    it("returns false for thought:false parts", () => {
      expect(isGeminiThinkingPart({ thought: false, text: "not thinking" })).toBe(false);
    });

    it("returns false for parts without thought property", () => {
      expect(isGeminiThinkingPart({ text: "hello" })).toBe(false);
    });
  });

  describe("ensureThoughtSignature", () => {
    it("adds sentinel signature when no cached signature exists", () => {
      const part = { thought: true, text: "thinking..." };
      const result = ensureThoughtSignature(part, "no-cache-session");
      // Now uses sentinel fallback to prevent API rejection
      expect(result.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("replaces untrusted thoughtSignature with sentinel", () => {
      const existingSignature = "a".repeat(MIN_SIGNATURE_LENGTH + 10);
      const part = { thought: true, text: "thinking...", thoughtSignature: existingSignature };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBe("skip_thought_signature_validator");
    });

    it("does not modify non-thinking parts", () => {
      const part = { text: "regular text" };
      const result = ensureThoughtSignature(part, "session-key");
      expect(result.thoughtSignature).toBeUndefined();
    });

    it("returns null/undefined inputs unchanged", () => {
      expect(ensureThoughtSignature(null, "key")).toBeNull();
      expect(ensureThoughtSignature(undefined, "key")).toBeUndefined();
    });

    it("returns non-object inputs unchanged", () => {
      expect(ensureThoughtSignature("string", "key")).toBe("string");
      expect(ensureThoughtSignature(123, "key")).toBe(123);
    });
  });

  describe("hasSignedThinkingPart", () => {
    it("returns true for part with valid thoughtSignature", () => {
      const part = { thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:thinking with valid signature field", () => {
      const part = { type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns true for type:reasoning with valid signature field", () => {
      const part = { type: "reasoning", signature: "a".repeat(MIN_SIGNATURE_LENGTH) };
      expect(hasSignedThinkingPart(part)).toBe(true);
    });

    it("returns false for part with short signature", () => {
      const part = { thought: true, thoughtSignature: "short" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });

    it("returns false for part without signature", () => {
      const part = { thought: true, text: "no signature" };
      expect(hasSignedThinkingPart(part)).toBe(false);
    });
  });

  describe("hasToolUseInContents", () => {
    it("returns true when contents have functionCall", () => {
      const contents = [
        { role: "model", parts: [{ functionCall: { name: "test" } }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(true);
    });

    it("returns false when no functionCall present", () => {
      const contents = [
        { role: "model", parts: [{ text: "hello" }] },
      ];
      expect(hasToolUseInContents(contents)).toBe(false);
    });

    it("handles empty contents", () => {
      expect(hasToolUseInContents([])).toBe(false);
    });
  });

  describe("hasSignedThinkingInContents", () => {
    it("returns true when contents have signed thinking", () => {
      const contents = [
        {
          role: "model",
          parts: [{ thought: true, thoughtSignature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(true);
    });

    it("returns false when no signed thinking present", () => {
      const contents = [
        { role: "model", parts: [{ thought: true, text: "unsigned" }] },
      ];
      expect(hasSignedThinkingInContents(contents)).toBe(false);
    });
  });

  describe("hasToolUseInMessages", () => {
    it("returns true when messages have tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "tool_use", id: "123", name: "test" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(true);
    });

    it("returns false when no tool_use blocks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });

    it("handles string content", () => {
      const messages = [{ role: "assistant", content: "just text" }];
      expect(hasToolUseInMessages(messages)).toBe(false);
    });
  });

  describe("hasSignedThinkingInMessages", () => {
    it("returns true when messages have signed thinking blocks", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "...", signature: "a".repeat(MIN_SIGNATURE_LENGTH) }],
        },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(true);
    });

    it("returns false when thinking blocks are unsigned", () => {
      const messages = [
        { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] },
      ];
      expect(hasSignedThinkingInMessages(messages)).toBe(false);
    });
  });

  describe("MIN_SIGNATURE_LENGTH", () => {
    it("is 50", () => {
      expect(MIN_SIGNATURE_LENGTH).toBe(50);
    });
  });

  describe("transformSseLine", () => {
    const callTransformSseLine = (line: string) => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();
      return transformSseLine(line, store, buffer, sentBuffer, defaultCallbacks, defaultOptions, { ...defaultDebugState });
    };

    it("returns empty lines unchanged", () => {
      expect(callTransformSseLine("")).toBe("");
      expect(callTransformSseLine("   ")).toBe("   ");
    });

    it("returns non-data lines unchanged", () => {
      expect(callTransformSseLine("event: message")).toBe("event: message");
      expect(callTransformSseLine(": heartbeat")).toBe(": heartbeat");
    });

    it("handles data: [DONE] unchanged", () => {
      expect(callTransformSseLine("data: [DONE]")).toBe("data: [DONE]");
    });

    it("handles invalid JSON gracefully", () => {
      expect(callTransformSseLine("data: not-json")).toBe("data: not-json");
      expect(callTransformSseLine("data: {invalid}")).toBe("data: {invalid}");
    });

    it("passes through valid JSON without thinking parts", () => {
      const payload = { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
      expect(result).toContain("hello");
    });

    it("transforms thinking parts in streaming data", () => {
      const payload = {
        candidates: [{
          content: {
            parts: [{ thought: true, text: "reasoning..." }]
          }
        }]
      };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
    });
  });

  describe("transformStreamingPayload", () => {
    it("handles empty string", () => {
      expect(transformStreamingPayload("")).toBe("");
    });

    it("handles single line without data prefix", () => {
      expect(transformStreamingPayload("event: ping")).toBe("event: ping");
    });

    it("handles multiple lines", () => {
      const input = "event: message\ndata: [DONE]\n";
      const result = transformStreamingPayload(input);
      expect(result).toContain("event: message");
      expect(result).toContain("data: [DONE]");
    });

    it("preserves line structure", () => {
      const input = "line1\nline2\nline3";
      const result = transformStreamingPayload(input);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
    });
  });

  describe("createStreamingTransformer", () => {
    it("returns a TransformStream", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      expect(transformer).toBeInstanceOf(TransformStream);
      expect(transformer.readable).toBeDefined();
      expect(transformer.writable).toBeDefined();
    });

    it("accepts optional signatureSessionKey", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts optional debugText", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", debugText: "debug info" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts cacheSignatures flag", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", cacheSignatures: true });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("processes chunks through the stream", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const input = encoder.encode("data: [DONE]\n");
      const outputChunks: Uint8Array[] = [];
      
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      
      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(value);
        }
      })();
      
      await writer.write(input);
      await writer.close();
      await readPromise;
      
      const output = outputChunks.map(chunk => decoder.decode(chunk)).join("");
      expect(output).toContain("[DONE]");
    });
  });

  describe("prepareAntigravityRequest", () => {
    const mockAccessToken = "test-token";
    const mockProjectId = "test-project";

    it("extracts projectName and agentName in prepared request", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        {
          method: "POST",
          headers: {
            "X-OpenCode-Project": "my-opencode-project",
            "X-OpenCode-Agent": "Sisyphus-Junior",
          },
          body: JSON.stringify({ contents: [] }),
        },
        mockAccessToken,
        mockProjectId,
      );
      expect(result.projectName).toBe("my-opencode-project");
      expect(result.agentName).toBe("Sisyphus-Junior");
    });

    it("returns unchanged request for URLs without model pattern", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1/models",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("detects streaming from generateStreamContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(true);
    });

    it("detects non-streaming from generateContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("sets Authorization header with Bearer token", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    });

    it("removes x-api-key header", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-api-key": "old-key" } },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-api-key")).toBeNull();
    });

    it("removes x-goog-api-key header", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-api-key": "dummy-key" } },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-api-key")).toBeNull();
    });

    it("removes x-goog-user-project header for antigravity headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("removes x-goog-user-project header for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("uses exact Code Assist headers for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("User-Agent")).toBe("google-api-nodejs-client/9.15.1");
      expect(headers.get("X-Goog-Api-Client")).toBe("gl-node/22.17.0");
      expect(headers.get("Client-Metadata")).toBe("ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI");
    });

    it("builds gemini-cli wrapped body without antigravity-only fields", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
        mockAccessToken,
        "",
        undefined,
        "gemini-cli"
      );
      const parsed = JSON.parse(result.init.body as string);
      expect(parsed.project).toBeUndefined();
      expect(parsed).toHaveProperty("model");
      expect(parsed).toHaveProperty("request");
      expect(parsed.requestType).toBeUndefined();
      expect(parsed.userAgent).toBeUndefined();
      expect(parsed.requestId).toBeUndefined();
    });

    it("identifies Claude models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-20250514:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("claude");
    });

    it("identifies Gemini models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("gemini");
    });

    it("uses custom endpoint override", () => {
      const customEndpoint = "https://custom.api.com";
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        customEndpoint
      );
      expect(result.endpoint).toContain(customEndpoint);
    });

    it("handles wrapped Antigravity body format", () => {
      const wrappedBody = {
        project: "my-project",
        request: { contents: [{ parts: [{ text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles unwrapped body format", () => {
      const unwrappedBody = {
        contents: [{ parts: [{ text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("does not add Claude auto-caching to wrapped request by default", () => {
      const wrappedBody = {
        project: "my-project",
        request: { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("does not add Claude auto-caching to unwrapped request by default", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("adds Claude auto-caching when enabled", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
        false,
        { claudePromptAutoCaching: true },
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toEqual({ type: "ephemeral" });
    });

    it("strips Claude thinking blocks when keep_thinking is false (unwrapped)", () => {
      const result = withKeepThinking(false, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-unwrapped",
                    thoughtSignature: "f".repeat(MIN_SIGNATURE_LENGTH + 8),
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingParts = parts.filter((part) =>
        part.thought === true
        || part.type === "thinking"
        || part.type === "redacted_thinking"
        || part.type === "reasoning",
      );

      expect(thinkingParts).toHaveLength(0);
      expect(result.needsSignedThinkingWarmup).toBe(false);
    });

    it("strips Claude thinking blocks when keep_thinking is false (wrapped)", () => {
      const result = withKeepThinking(false, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            project: "my-project",
            request: {
              contents: [
                {
                  role: "model",
                  parts: [
                    {
                      thought: true,
                      text: "foreign-thought-wrapped",
                      thoughtSignature: "w".repeat(MIN_SIGNATURE_LENGTH + 8),
                    },
                    { functionCall: { name: "weather", args: {} } },
                  ],
                },
              ],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingParts = parts.filter((part) =>
        part.thought === true
        || part.type === "thinking"
        || part.type === "redacted_thinking"
        || part.type === "reasoning",
      );

      expect(thinkingParts).toHaveLength(0);
      expect(result.needsSignedThinkingWarmup).toBe(false);
    });

    it("does not trust foreign Gemini thoughtSignature when keep_thinking is true", () => {
      const foreignSignature = "x".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = withKeepThinking(true, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-keep-true",
                    thoughtSignature: foreignSignature,
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingBlock = parts.find((part) =>
        part.thought === true || part.type === "thinking" || part.type === "redacted_thinking",
      );
      const signature = typeof thinkingBlock?.signature === "string"
        ? thinkingBlock.signature
        : thinkingBlock?.thoughtSignature;

      expect(JSON.stringify(wrapped)).not.toContain(foreignSignature);
      if (thinkingBlock) {
        expect(signature).toBe(SKIP_THOUGHT_SIGNATURE);
      }
    });

    it("replaces foreign Claude signatures with sentinel when keep_thinking is true", () => {
      const foreignSignature = "y".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = withKeepThinking(true, () => prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "foreign-message-thinking",
                    signature: foreignSignature,
                  },
                  {
                    type: "tool_use",
                    id: "tool-1",
                    name: "weather",
                    input: {},
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      ));

      const wrapped = JSON.parse(result.init.body as string);
      const content = wrapped.request.messages[0].content as Array<Record<string, unknown>>;
      const thinkingBlock = content.find((block) => block.type === "thinking" || block.type === "redacted_thinking");

      expect(thinkingBlock).toBeTruthy();
      expect(thinkingBlock?.signature).toBe(SKIP_THOUGHT_SIGNATURE);
      expect(JSON.stringify(content)).not.toContain(foreignSignature);
      expect(result.needsSignedThinkingWarmup).toBe(false);
    });

    it("returns requestedModel matching URL model", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.requestedModel).toBe("gemini-2.5-flash");
    });

    it("handles empty body gracefully", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({}) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles minimal valid JSON body", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("removes contents entries with empty or invalid parts", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [] },
              { role: "model", parts: [null, { text: "kept" }] },
              { role: "user", parts: null },
            ],
            systemInstruction: {
              role: "user",
              parts: [null, { text: "system kept" }],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.contents).toHaveLength(1);
      expect(wrapped.request.contents[0]).toEqual({
        role: "model",
        parts: [{ text: "kept" }],
      });
      expect(wrapped.request.systemInstruction.parts).toEqual([{ text: "system kept" }]);
    });

    it("drops systemInstruction when all parts are invalid", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            systemInstruction: {
              role: "user",
              parts: [null],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.systemInstruction).toBeUndefined();
    });

    it("preserves headerStyle in response", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      expect(result.headerStyle).toBe("gemini-cli");
    });

    describe("Issue #103: model name transformation during quota fallback", () => {
      it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash");
      });

      it("transforms gemini-3.5-flash-preview to gemini-3.5-flash-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.5-flash-low");
      });

      it("transforms antigravity-gemini-3.5-flash to gemini-3.5-flash-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.5-flash-low");
      });

      it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-low");
      });

      it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3-flash to gemini-3-flash-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash-preview");
      });

      it("transforms gemini-3.5-flash to gemini-3.5-flash-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.5-flash-preview");
      });

      it("transforms gemini-3-pro-low to gemini-3-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-preview");
      });

      it("transforms gemini-3.1-pro-low to gemini-3.1-pro-preview for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview");
      });

      it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview-customtools");
      });

      it("keeps non-Gemini-3 models unchanged regardless of headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-2.5-flash");
      });
    });
  });

  describe("transformAntigravityResponse", () => {
    it("injects [ThinkingResolution] details when debug_tui is enabled", async () => {
      initializeDebug({
        ...DEFAULT_CONFIG,
        debug: false,
        debug_tui: true,
      });

      const response = new Response(
        JSON.stringify({
          error: {
            code: 500,
            message: "Upstream error",
            status: "INTERNAL",
          },
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        false,
        undefined,
        "gemini-2.5-pro",
        "test-project",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
        "gemini-2.5-pro",
        "session-1",
        0,
        "summary",
        undefined,
        [
          "status=500 INTERNAL",
          "endpoint=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
          "account=test@example.com",
        ],
      );

      const bodyText = await transformed.text();
      expect(bodyText).toContain("[ThinkingResolution]");
      expect(bodyText).toContain("status=500 INTERNAL");
      expect(bodyText).toContain("endpoint=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent");
      expect(bodyText).toContain("account=test@example.com");

      initializeDebug(DEFAULT_CONFIG);
    });

    it("does not misclassify generic INVALID_ARGUMENT as thinking recovery from debug metadata", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        true,
        undefined,
        "antigravity-claude-opus-4-6-thinking",
        "test-project",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "claude-opus-4-6-thinking",
        "session-1",
        0,
        "expected=1 found=0",
      );

      await expect(transformed.text()).resolves.toContain("Request contains an invalid argument.");
    });

    it("rethrows THINKING_RECOVERY_NEEDED for outer retry handling", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Thinking must start with a thinking block before tool use.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      await expect(
        transformAntigravityResponse(
          response,
          true,
          undefined,
          "antigravity-claude-opus-4-6-thinking",
          "test-project",
          "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
          "claude-opus-4-6-thinking",
          "session-1",
        ),
      ).rejects.toMatchObject({ message: "THINKING_RECOVERY_NEEDED" });
    });
  });

  describe("reportTokenUsageTelemetry", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearTelemetryQueue();
      fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      clearTelemetryQueue();
      vi.unstubAllGlobals();
      delete process.env.TELEMETRY_API_KEY;
    });

    it("dispatches POST request with correct email, model, prompt_tokens, completion_tokens, and total_tokens", () => {
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev@example.com",
        "gemini-3.6-flash-high",
        { promptTokens: 120, candidateTokens: 60, totalTokens: 180 },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [url, init] = call;
      expect(url).toBe("https://test.telemetry/v1/record");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

      const payload = JSON.parse(init.body as string);
      expect(payload).toMatchObject({
        email: "dev@example.com",
        model: "gemini-3.6-flash-high",
        prompt_tokens: 120,
        completion_tokens: 60,
        total_tokens: 180,
      });
      expect(payload.id).toBeDefined();
      expect(payload.timestamp).toBeDefined();
      expect(init.signal).toBeDefined();
    });

    it("includes Authorization header when telemetryApiKey is provided or TELEMETRY_API_KEY env is set", () => {
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev@example.com",
        "gemini-3.6-flash",
        { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
        "secret-key-123",
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [, init] = call;
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer secret-key-123",
      });
    });

    it("includes Authorization header from TELEMETRY_API_KEY env var if argument is omitted", () => {
      process.env.TELEMETRY_API_KEY = "env-secret-key-456";
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev@example.com",
        "gemini-3.6-flash",
        { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [, init] = call;
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer env-secret-key-456",
      });
    });

    it("handles queue buffer capacity up to 1000 items without throwing", () => {
      for (let i = 0; i < 1050; i++) {
        reportTokenUsageTelemetry(
          "https://test.telemetry/v1/record",
          "dev@example.com",
          "gemini-3.6-flash",
          { promptTokens: i, candidateTokens: i, totalTokens: i * 2 },
        );
      }
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("handles undefined values safely with defaults ('local-developer' and 0)", () => {
      const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
        ...DEFAULT_CONFIG,
        telemetry_url: "https://llm.wdsa.ru/v1/status/record_usage",
      });
      try {
        reportTokenUsageTelemetry(undefined, undefined, undefined, {});

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const call = fetchSpy.mock.calls[0] as [string, RequestInit];
        const [url, init] = call;
        expect(url).toBe("https://llm.wdsa.ru/v1/status/record_usage");

        const payload = JSON.parse(init.body as string);
        expect(payload).toMatchObject({
          email: "local-developer",
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        });
        expect(payload.id).toBeDefined();
        expect(payload.timestamp).toBeDefined();
      } finally {
        loadConfigSpy.mockRestore();
      }
    });

    it("safely ignores errors when fetch rejects", () => {
      fetchSpy.mockRejectedValue(new Error("Connection refused"));

      expect(() => {
        reportTokenUsageTelemetry(
          "https://test.telemetry/v1/record",
          "dev@example.com",
          "gemini-3.6-flash",
          { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
        );
      }).not.toThrow();
    });

    it("handles batch processing and 1s fetch timeout without blocking", async () => {
      let resolveFirstFetch!: (val: Response) => void;
      let rejectSecondFetch!: (err: Error) => void;

      const firstFetchPromise = new Promise<Response>((resolve) => {
        resolveFirstFetch = resolve;
      });
      const secondFetchPromise = new Promise<Response>((_, reject) => {
        rejectSecondFetch = reject;
      });

      fetchSpy
        .mockImplementationOnce(() => firstFetchPromise)
        .mockImplementationOnce(() => secondFetchPromise)
        .mockResolvedValue(new Response("ok"));

      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev1@example.com",
        "gemini-3.6-flash",
        { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
      );
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev2@example.com",
        "gemini-3.6-flash",
        { promptTokens: 20, candidateTokens: 20, totalTokens: 40 },
      );
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev3@example.com",
        "gemini-3.6-flash",
        { promptTokens: 30, candidateTokens: 30, totalTokens: 60 },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);

      resolveFirstFetch(new Response("ok"));
      await new Promise((r) => setTimeout(r, 10));

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      rejectSecondFetch(new Error("Timeout of 1000ms exceeded"));
      await new Promise((r) => setTimeout(r, 10));

      expect(getTelemetryQueueSize()).toBe(0);
    });
  });

  describe("process exit queue flusher", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearTelemetryQueue();
      fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      clearTelemetryQueue();
      vi.unstubAllGlobals();
    });

    it("dispatches enriched telemetry payload with id, timestamp, session_id, source_client, request_origin, status_code, is_streaming, latency_ms, project_name, and agent_name", async () => {
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev@example.com",
        "gemini-3.6-flash-high",
        { promptTokens: 100, candidateTokens: 50, totalTokens: 150 },
        "secret-key",
        {
          id: "custom-uuid-1234",
          timestamp: "2026-08-12T12:00:00.000Z",
          sessionId: "ses-test-123",
          sourceClient: "opencode-desktop",
          requestOrigin: "192.168.55.123",
          statusCode: 200,
          isStreaming: true,
          latencyMs: 350,
          projectName: "opencode-antigravity-auth-fork",
          agentName: "Sisyphus-Junior",
        },
      );

      await flushTelemetryQueue(1000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0] as [string, RequestInit];
      const [, init] = call;
      const payload = JSON.parse(init.body as string);

      expect(payload).toEqual({
        id: "custom-uuid-1234",
        timestamp: "2026-08-12T12:00:00.000Z",
        email: "dev@example.com",
        model: "gemini-3.6-flash-high",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        session_id: "ses-test-123",
        source_client: "opencode-desktop",
        request_origin: "192.168.55.123",
        status_code: 200,
        is_streaming: true,
        latency_ms: 350,
        project_name: "opencode-antigravity-auth-fork",
        agent_name: "Sisyphus-Junior",
      });
    });

    it("drains 100% of telemetry queue on simulated process exit events (beforeExit, SIGINT, SIGTERM)", async () => {
      let fetchResolve!: (val: Response) => void;
      const pendingFetch = new Promise<Response>((r) => { fetchResolve = r; });
      fetchSpy.mockImplementation(() => pendingFetch);

      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev1@example.com",
        "gemini-3.6-flash",
        { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
      );
      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev2@example.com",
        "gemini-3.6-flash",
        { promptTokens: 20, candidateTokens: 20, totalTokens: 40 },
      );

      expect(getTelemetryQueueSize()).toBeGreaterThan(0);

      fetchResolve(new Response("ok"));
      process.emit("beforeExit", 0);
      await flushTelemetryQueue(1000);

      expect(getTelemetryQueueSize()).toBe(0);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("times out gracefully without throwing if network hangs during process exit flush", async () => {
      fetchSpy.mockImplementation(() => new Promise(() => {}));

      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        "dev@example.com",
        "gemini-3.6-flash",
        { promptTokens: 10, candidateTokens: 10, totalTokens: 20 },
      );

      const startTime = Date.now();
      await expect(flushTelemetryQueue(100)).resolves.toBeUndefined();
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("losslessness and token attribution under retry and account rotation", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearTelemetryQueue();
      fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      clearTelemetryQueue();
      vi.unstubAllGlobals();
    });

    it("verifies zero token loss (sum of streaming token deltas == total reported telemetry tokens)", async () => {
      let totalStreamPromptTokens = 0;
      let totalStreamCandidateTokens = 0;

      const callbacks: StreamingCallbacks = {
        onTokenUsage: (usage) => {
          totalStreamPromptTokens += usage.promptTokens;
          totalStreamCandidateTokens += usage.candidateTokens;
          reportTokenUsageTelemetry(
            "https://test.telemetry/v1/record",
            "acc-1@example.com",
            "gemini-3.6-flash",
            usage,
            undefined,
            { sessionId: "ses-lossless-1" }
          );
        },
      };

      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, callbacks, {});
      const encoder = new TextEncoder();
      const reader = transformer.readable.getReader();
      const writer = transformer.writable.getWriter();

      const readPromise = (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })();

      const chunks = [
        `data: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 } } })}\n`,
        `data: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 45, totalTokenCount: 95 } } })}\n`,
        `data: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 80, totalTokenCount: 130 } } })}\n`,
      ];

      for (const chunk of chunks) {
        await writer.write(encoder.encode(chunk));
      }
      await writer.close();
      await readPromise;

      await flushTelemetryQueue(1000);

      let telemetryPromptTokensSum = 0;
      let telemetryCandidateTokensSum = 0;

      for (const call of fetchSpy.mock.calls as [string, RequestInit][]) {
        const payload = JSON.parse(call[1].body as string);
        telemetryPromptTokensSum += payload.prompt_tokens;
        telemetryCandidateTokensSum += payload.completion_tokens;
      }

      expect(totalStreamPromptTokens).toBe(50);
      expect(totalStreamCandidateTokens).toBe(80);
      expect(totalStreamPromptTokens - telemetryPromptTokensSum).toBe(0);
      expect(totalStreamCandidateTokens - telemetryCandidateTokensSum).toBe(0);
      expect((totalStreamPromptTokens + totalStreamCandidateTokens) - (telemetryPromptTokensSum + telemetryCandidateTokensSum)).toBe(0);
    });

    it("correctly attributes tokens during 429 account rotation events (primary account vs secondary account)", async () => {
      const primaryAccount = "acc-primary@example.com";
      const secondaryAccount = "acc-secondary@example.com";

      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        primaryAccount,
        "gemini-3.6-flash",
        { promptTokens: 30, candidateTokens: 15, totalTokens: 45 },
        undefined,
        { statusCode: 429, sessionId: "ses-retry-429" }
      );

      reportTokenUsageTelemetry(
        "https://test.telemetry/v1/record",
        secondaryAccount,
        "gemini-3.6-flash",
        { promptTokens: 30, candidateTokens: 70, totalTokens: 100 },
        undefined,
        { statusCode: 200, sessionId: "ses-retry-429" }
      );

      await flushTelemetryQueue(1000);

      const reportedPayloads = fetchSpy.mock.calls.map((call) => JSON.parse((call as [string, RequestInit])[1].body as string));

      const primaryPayloads = reportedPayloads.filter((p) => p.email === primaryAccount);
      const secondaryPayloads = reportedPayloads.filter((p) => p.email === secondaryAccount);

      expect(primaryPayloads.length).toBe(1);
      expect(primaryPayloads[0].total_tokens).toBe(45);
      expect(primaryPayloads[0].status_code).toBe(429);

      expect(secondaryPayloads.length).toBe(1);
      expect(secondaryPayloads[0].total_tokens).toBe(100);
      expect(secondaryPayloads[0].status_code).toBe(200);

      const sessionTotalTokens = reportedPayloads
        .filter((p) => p.session_id === "ses-retry-429")
        .reduce((sum, p) => sum + p.total_tokens, 0);

      expect(sessionTotalTokens).toBe(145);
    });
  });
});
