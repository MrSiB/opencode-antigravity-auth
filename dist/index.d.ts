import { AntigravityCLIOAuthPlugin } from "./src/plugin.js";
export { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin, createAntigravityPlugin, } from "./src/plugin.js";
export { authorizeAntigravity, exchangeAntigravity, } from "./src/antigravity/oauth.js";
export type { AntigravityAuthorization, AntigravityTokenExchangeResult, } from "./src/antigravity/oauth.js";
export declare const AntigravityPluginFactory: ({ client, directory }: import("./src/plugin/types.js").PluginContext) => Promise<import("./src/plugin/types.js").PluginResult>;
export default AntigravityCLIOAuthPlugin;
//# sourceMappingURL=index.d.ts.map