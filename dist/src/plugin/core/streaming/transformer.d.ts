import { StreamIdleTimeoutError, type SignatureStore, type StreamingCallbacks, type StreamingOptions, type ThoughtBuffer } from './types';
export { StreamIdleTimeoutError };
export declare const DEFAULT_WATCHDOG_TIMEOUT_MS = 45000;
export declare function createThoughtBuffer(): ThoughtBuffer;
export declare function transformStreamingPayload(payload: string, transformThinkingParts?: (response: unknown) => unknown): string;
export declare function deduplicateThinkingText(response: unknown, sentBuffer: ThoughtBuffer, displayedThinkingHashes?: Set<string>): unknown;
export declare function transformSseLine(line: string, signatureStore: SignatureStore, thoughtBuffer: ThoughtBuffer, sentThinkingBuffer: ThoughtBuffer, callbacks: StreamingCallbacks, options: StreamingOptions, debugState: {
    injected: boolean;
}): string;
export declare function cacheThinkingSignaturesFromResponse(response: unknown, signatureSessionKey: string, signatureStore: SignatureStore, thoughtBuffer: ThoughtBuffer, onCacheSignature?: (sessionKey: string, text: string, signature: string) => void): void;
export declare function createStreamingTransformer(signatureStore: SignatureStore, callbacks: StreamingCallbacks, options?: StreamingOptions): TransformStream<Uint8Array, Uint8Array>;
//# sourceMappingURL=transformer.d.ts.map