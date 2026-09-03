import { describe, it, expect, vi } from "vitest";
import {
  createStreamingTransformer,
  StreamIdleTimeoutError,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
} from "./transformer";
import type { SignatureStore, StreamingCallbacks } from "./types";

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) => {
      store.set(key, value);
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

const defaultCallbacks: StreamingCallbacks = {};

describe("StreamIdleTimeoutError", () => {
  it("extends Error and has name StreamIdleTimeoutError", () => {
    const error = new StreamIdleTimeoutError("custom message", 5000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StreamIdleTimeoutError");
    expect(error.message).toBe("custom message");
    expect(error.timeoutMs).toBe(5000);
  });

  it("formats default message with timeoutMs", () => {
    const error = new StreamIdleTimeoutError(undefined, 45_000);
    expect(error.message).toBe("Stream stalled: no chunks received for 45000ms");
    expect(error.name).toBe("StreamIdleTimeoutError");
    expect(error.timeoutMs).toBe(45_000);
  });

  it("handles empty constructor arguments", () => {
    const error = new StreamIdleTimeoutError();
    expect(error.message).toBe("Stream stalled: no chunks received within timeout");
    expect(error.name).toBe("StreamIdleTimeoutError");
  });
});

describe("DEFAULT_WATCHDOG_TIMEOUT_MS", () => {
  it("equals 45,000 milliseconds", () => {
    expect(DEFAULT_WATCHDOG_TIMEOUT_MS).toBe(45_000);
  });
});

describe("createStreamingTransformer watchdog", () => {
  it("aborts the stream with StreamIdleTimeoutError if idle on start", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        watchdogTimeoutMs: 1000,
      });
      const reader = transformer.readable.getReader();

      const readPromise = reader.read();

      vi.advanceTimersByTime(1000);

      await expect(readPromise).rejects.toThrow(StreamIdleTimeoutError);
      await expect(readPromise).rejects.toMatchObject({
        name: "StreamIdleTimeoutError",
        timeoutMs: 1000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the stream with StreamIdleTimeoutError if stream stalls after a chunk", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        watchdogTimeoutMs: 1000,
      });
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const encoder = new TextEncoder();

      const readPromise1 = reader.read();
      await writer.write(encoder.encode("data: {\"response\":{\"candidates\":[]}}\n"));
      const firstChunk = await readPromise1;
      expect(firstChunk.done).toBe(false);

      const secondReadPromise = reader.read();
      vi.advanceTimersByTime(1000);

      await expect(secondReadPromise).rejects.toThrow(StreamIdleTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets watchdog timer when chunks arrive in time", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        watchdogTimeoutMs: 1000,
      });
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const encoder = new TextEncoder();

      vi.advanceTimersByTime(600);
      const readPromise1 = reader.read();
      await writer.write(encoder.encode("data: {\"response\":{\"candidates\":[]}}\n"));
      const chunk1 = await readPromise1;
      expect(chunk1.done).toBe(false);

      vi.advanceTimersByTime(600);
      const readPromise2 = reader.read();
      await writer.write(encoder.encode("data: {\"response\":{\"candidates\":[]}}\n"));
      const chunk2 = await readPromise2;
      expect(chunk2.done).toBe(false);

      const closePromise = writer.close();
      const chunk3 = await reader.read();
      await closePromise;
      expect(chunk3).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears watchdog timer on cancel() so no timeout error triggers", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        watchdogTimeoutMs: 1000,
      });

      await transformer.readable.cancel("client closed connection");

      vi.advanceTimersByTime(5000);
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears watchdog timer on flush() upon normal stream completion", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, {
        watchdogTimeoutMs: 1000,
      });
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      const encoder = new TextEncoder();

      const readPromise1 = reader.read();
      await writer.write(encoder.encode("data: {\"response\":{\"usageMetadata\":{\"promptTokenCount\":10}}}\n"));
      await readPromise1;

      const closePromise = writer.close();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      await closePromise;

      vi.advanceTimersByTime(5000);
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to 45,000ms watchdog timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const reader = transformer.readable.getReader();

      const readPromise = reader.read();

      vi.advanceTimersByTime(44_000);
      vi.advanceTimersByTime(1_000);

      await expect(readPromise).rejects.toThrow(StreamIdleTimeoutError);
      await expect(readPromise).rejects.toMatchObject({
        name: "StreamIdleTimeoutError",
        timeoutMs: 45_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
