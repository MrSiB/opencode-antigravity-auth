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
    transformThinkingParts?: (parts: unknown) => unknown;
    onUsageMetadata?: (usage: unknown) => void;
}
export interface StreamingOptions {
    signatureSessionKey?: string;
    debugText?: string;
    cacheSignatures?: boolean;
    displayedThinkingHashes?: Set<string>;
    watchdogTimeoutMs?: number;
}
export interface ThoughtBuffer {
    get(index: number): string | undefined;
    set(index: number, text: string): void;
    clear(): void;
}
export declare class StreamIdleTimeoutError extends Error {
    readonly timeoutMs?: number;
    constructor(message?: string, timeoutMs?: number);
}
//# sourceMappingURL=types.d.ts.map