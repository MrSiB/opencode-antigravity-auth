import type { OAuthAuthDetails, PluginClient } from "./types";
export declare class AntigravityTokenRefreshError extends Error {
    code?: string;
    description?: string;
    status: number;
    statusText: string;
    constructor(options: {
        message: string;
        code?: string;
        description?: string;
        status: number;
        statusText: string;
    });
}
export declare function clearInFlightRefreshes(): void;
export declare function refreshAccessToken(auth: OAuthAuthDetails, _client: PluginClient, _providerId: string): Promise<OAuthAuthDetails | undefined>;
//# sourceMappingURL=token.d.ts.map