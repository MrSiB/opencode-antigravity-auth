import { type Server as HttpServer } from "node:http";
import { type HeaderStyle } from "./constants.js";
import { type ModelFamily } from "./plugin/accounts.js";
import { type AntigravityConfig } from "./plugin/config/index.js";
import type { PluginContext, PluginResult } from "./plugin/types.js";
export declare function startEmbeddedProxyServer(port?: number): HttpServer;
/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export declare const createAntigravityPlugin: (providerId: string) => ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const AntigravityCLIOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
export declare const GoogleOAuthPlugin: ({ client, directory }: PluginContext) => Promise<PluginResult>;
export default AntigravityCLIOAuthPlugin;
declare function resolveQuotaFallbackHeaderStyle(input: {
    family: ModelFamily;
    headerStyle: HeaderStyle;
    alternateStyle: HeaderStyle | null;
}): HeaderStyle | null;
type HeaderRoutingDecision = {
    cliFirst: boolean;
    preferredHeaderStyle: HeaderStyle;
    explicitQuota: boolean;
    allowQuotaFallback: boolean;
};
declare function resolveHeaderRoutingDecision(urlString: string, family: ModelFamily, config: AntigravityConfig): HeaderRoutingDecision;
declare function getHeaderStyleFromUrl(urlString: string, family: ModelFamily, cliFirst?: boolean): HeaderStyle;
export declare function __testExports(): {
    getHeaderStyleFromUrl: typeof getHeaderStyleFromUrl;
    resolveHeaderRoutingDecision: typeof resolveHeaderRoutingDecision;
    resolveQuotaFallbackHeaderStyle: typeof resolveQuotaFallbackHeaderStyle;
};
//# sourceMappingURL=plugin.d.ts.map