import { createAntigravityPlugin, ANTIGRAVITY_PROVIDER_ID, AntigravityCLIOAuthPlugin } from "./src/plugin.js";

export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
  createAntigravityPlugin,
} from "./src/plugin.js";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth.js";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth.js";

export const AntigravityPluginFactory = AntigravityCLIOAuthPlugin;

export default AntigravityCLIOAuthPlugin;
