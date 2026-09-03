export class StreamIdleTimeoutError extends Error {
    timeoutMs;
    constructor(message, timeoutMs) {
        super(message ??
            (timeoutMs !== undefined
                ? `Stream stalled: no chunks received for ${timeoutMs}ms`
                : 'Stream stalled: no chunks received within timeout'));
        this.name = 'StreamIdleTimeoutError';
        if (timeoutMs !== undefined) {
            this.timeoutMs = timeoutMs;
        }
    }
}
//# sourceMappingURL=types.js.map