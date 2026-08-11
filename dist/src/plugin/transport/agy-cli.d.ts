export interface AgyBinary {
    path: string;
    version: string;
}
export interface AgyCommand {
    binary: string;
    args: string[];
    timeoutMs: number;
}
export interface AgyResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}
declare function parseVersion(text: string): string | null;
declare function execFileText(file: string, args: string[], timeoutMs: number): Promise<AgyResult>;
export declare function findAgyBinary(): Promise<AgyBinary | null>;
/**
 * Best-effort non-interactive auth probe.
 *
 * There is no documented `agy auth status` command. This deliberately uses
 * a very short timeout and no OAuth automation. If agy starts an auth flow,
 * this returns "unknown" instead of waiting.
 */
export declare function checkAgyAuthState(binary: string): Promise<"authenticated" | "unauthenticated" | "unknown">;
export declare function executeAgyCommand(command: AgyCommand): Promise<Response>;
export declare const _test: {
    parseVersion: typeof parseVersion;
    execFileText: typeof execFileText;
    UNAUTHENTICATED_RE: RegExp;
};
export {};
//# sourceMappingURL=agy-cli.d.ts.map