import { describe, expect, it, vi } from "vitest";
import {
  createStreamingTransformer,
  transformSseLine,
  transformStreamingPayload,
  deduplicateThinkingText,
  createThoughtBuffer,
} from "./transformer.js";
import type { SignatureStore, StreamingCallbacks } from "./types.js";

function createMockSignatureStore(): SignatureStore {
  const map = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: { text: string; signature: string }) => {
      map.set(key, value);
    },
    has: (key: string) => map.has(key),
    delete: (key: string) => {
      map.delete(key);
    },
  };
}

describe("streaming transformer", () => {
  describe("createThoughtBuffer", () => {
    it("gets, sets, and clears thought text", () => {
      const buffer = createThoughtBuffer();
      expect(buffer.get(0)).toBeUndefined();
      buffer.set(0, "thought 1");
      expect(buffer.get(0)).toBe("thought 1");
      buffer.clear();
      expect(buffer.get(0)).toBeUndefined();
    });
  });

  describe("transformStreamingPayload", () => {
    it("transforms thinking parts in data: JSON lines", () => {
      const input = 'data: {"response":{"text":"hello"}}\n';
      const result = transformStreamingPayload(input, (resp: any) => ({
        ...resp,
        transformed: true,
      }));
      expect(result).toContain('"transformed":true');
    });

    it("passes non-data lines untouched", () => {
      const input = "event: message\n";
      expect(transformStreamingPayload(input)).toBe("event: message\n");
    });
  });

  describe("deduplicateThinkingText", () => {
    it("deduplicates candidates thinking content with deltas", () => {
      const sentBuffer = createThoughtBuffer();
      const response = {
        candidates: [
          {
            content: {
              parts: [
                { type: "thinking", text: "Thinking step 1" },
              ],
            },
          },
        ],
      };

      const firstPass = deduplicateThinkingText(response, sentBuffer) as any;
      expect(firstPass.candidates[0].content.parts[0].text).toBe("Thinking step 1");

      const secondResponse = {
        candidates: [
          {
            content: {
              parts: [
                { type: "thinking", text: "Thinking step 1 step 2" },
              ],
            },
          },
        ],
      };

      const secondPass = deduplicateThinkingText(secondResponse, sentBuffer) as any;
      expect(secondPass.candidates[0].content.parts[0].text).toBe(" step 2");
    });
  });

  describe("createStreamingTransformer delta token tracking", () => {
    it("emits non-negative deltas across streaming SSE chunks", async () => {
      const store = createMockSignatureStore();
      const tokenUsageCalls: Array<{ promptTokens: number; candidateTokens: number; totalTokens: number }> = [];

      const callbacks: StreamingCallbacks = {
        onTokenUsage: (usage) => {
          tokenUsageCalls.push(usage);
        },
      };

      const transformer = createStreamingTransformer(store, callbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const chunk1 = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 10,
              totalTokenCount: 110,
            },
          },
        })}\n`,
      );

      const chunk2 = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 25,
              totalTokenCount: 125,
            },
          },
        })}\n`,
      );

      const chunk3 = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 25,
              totalTokenCount: 125,
            },
          },
        })}\n`,
      );

      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const outputChunks: string[] = [];

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(decoder.decode(value));
        }
      })();

      await writer.write(chunk1);
      await writer.write(chunk2);
      await writer.write(chunk3);
      await writer.close();
      await readPromise;

      // Check token usage calls
      // Chunk 1: 100 prompt, 10 candidates -> delta (100, 10, 110)
      // Chunk 2: 100 prompt, 25 candidates -> delta (0, 15, 15)
      // Chunk 3: 100 prompt, 25 candidates -> delta (0, 0, 0) -> not emitted
      expect(tokenUsageCalls).toHaveLength(2);
      expect(tokenUsageCalls[0]).toEqual({
        promptTokens: 100,
        candidateTokens: 10,
        totalTokens: 110,
      });
      expect(tokenUsageCalls[1]).toEqual({
        promptTokens: 0,
        candidateTokens: 15,
        totalTokens: 15,
      });

      // Total tokens accumulated across deltas equals 110 + 15 = 125
      const sumTotalTokens = tokenUsageCalls.reduce((sum, u) => sum + u.totalTokens, 0);
      expect(sumTotalTokens).toBe(125);
    });

    it("flushes remaining deltas when usageMetadata is in final flushed chunk", async () => {
      const store = createMockSignatureStore();
      const tokenUsageCalls: Array<{ promptTokens: number; candidateTokens: number; totalTokens: number }> = [];

      const callbacks: StreamingCallbacks = {
        onTokenUsage: (usage) => {
          tokenUsageCalls.push(usage);
        },
      };

      const transformer = createStreamingTransformer(store, callbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // Send chunk without trailing newline so it remains in buffer until flush
      const unflushedChunk = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 50,
              candidatesTokenCount: 5,
              totalTokenCount: 55,
            },
          },
        })}`,
      );

      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const outputChunks: string[] = [];

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(decoder.decode(value));
        }
      })();

      await writer.write(unflushedChunk);
      await writer.close(); // Triggers flush()
      await readPromise;

      expect(tokenUsageCalls).toHaveLength(1);
      expect(tokenUsageCalls[0]).toEqual({
        promptTokens: 50,
        candidateTokens: 5,
        totalTokens: 55,
      });
    });

    it("injects synthetic usage metadata if missing in stream", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, {});
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const chunk = encoder.encode('data: {"response":{"text":"hello"}}\n');

      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const outputChunks: string[] = [];

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(decoder.decode(value));
        }
      })();

      await writer.write(chunk);
      await writer.close();
      await readPromise;

      const output = outputChunks.join("");
      expect(output).toContain("usageMetadata");
      expect(output).toContain('"promptTokenCount":0');
    });

    it("prevents negative deltas if cumulative count decreases unexpectedly", async () => {
      const store = createMockSignatureStore();
      const tokenUsageCalls: Array<{ promptTokens: number; candidateTokens: number; totalTokens: number }> = [];

      const callbacks: StreamingCallbacks = {
        onTokenUsage: (usage) => {
          tokenUsageCalls.push(usage);
        },
      };

      const transformer = createStreamingTransformer(store, callbacks);
      const encoder = new TextEncoder();

      const chunk1 = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 20,
              totalTokenCount: 120,
            },
          },
        })}\n`,
      );

      // Decreased prompt count (should be ignored)
      const chunk2 = encoder.encode(
        `data: ${JSON.stringify({
          response: {
            usageMetadata: {
              promptTokenCount: 80,
              candidatesTokenCount: 20,
              totalTokenCount: 100,
            },
          },
        })}\n`,
      );

      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();

      const readPromise = (async () => {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })();

      await writer.write(chunk1);
      await writer.write(chunk2);
      await writer.close();
      await readPromise;

      expect(tokenUsageCalls).toHaveLength(1);
      expect(tokenUsageCalls[0]).toEqual({
        promptTokens: 100,
        candidateTokens: 20,
        totalTokens: 120,
      });
    });
  });
});
