export interface SignedThinking {
  text: string;
  signature: string;
}

export interface SignatureStore {
  get(sessionKey: string): SignedThinking | undefined;
  set(sessionKey: string, value: SignedThinking): void;
  has(sessionKey: string): boolean;
  delete(sessionKey: string): void;
}

export interface StreamingCallbacks {
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void;
  onInjectDebug?: (response: unknown, debugText: string) => unknown;
  // Note: onInjectSyntheticThinking removed - keep_thinking now unified with debug via debugText
  transformThinkingParts?: (parts: unknown) => unknown;
  onUsageMetadata?: (usage: unknown) => void;
}

export interface StreamingOptions {
  signatureSessionKey?: string;
  debugText?: string;
  cacheSignatures?: boolean;
  displayedThinkingHashes?: Set<string>;
  watchdogTimeoutMs?: number;
  // Note: injectSyntheticThinking removed - keep_thinking now unified with debug via debugText
}

export interface ThoughtBuffer {
  get(index: number): string | undefined;
  set(index: number, text: string): void;
  clear(): void;
}

export class StreamIdleTimeoutError extends Error {
  readonly timeoutMs?: number;

  constructor(message?: string, timeoutMs?: number) {
    super(
      message ??
        (timeoutMs !== undefined
          ? `Stream stalled: no chunks received for ${timeoutMs}ms`
          : 'Stream stalled: no chunks received within timeout'),
    );
    this.name = 'StreamIdleTimeoutError';
    if (timeoutMs !== undefined) {
      this.timeoutMs = timeoutMs;
    }
  }
}
