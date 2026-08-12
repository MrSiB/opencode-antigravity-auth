# PLUGIN MODULE KNOWLEDGE BASE

## OVERVIEW
Core plugin implementation containing request interception, embedded proxy server (port 51128), multi-account rotation, model transformation, and recovery hooks.

## STRUCTURE
```
src/plugin/
├── config/       # Schema, configuration loader, and opencode.json updater
├── core/         # Streaming payload transformers
├── recovery/     # Session recovery hooks and storage
├── stores/       # Thought signature store
├── transform/    # Model resolver, Claude & Gemini payload sanitizers
├── accounts.ts   # Multi-account rotation, health scores, quota thresholds
├── auth.ts       # OAuth token parsing and validation
├── debug.ts      # Structured debug logging
├── errors.ts     # Custom error classes
├── logger.ts     # TUI & console logger
├── quota.ts      # Google API quota checker
├── recovery.ts   # Session recovery (tool_result_missing)
├── request.ts    # Request interceptor and Google API payload formatter
└── server.ts     # OAuth local listener (port 51121)
```

## WHERE TO LOOK
| Component | File | Key Functions |
|-----------|------|---------------|
| Interceptor | `request.ts` | `prepareAntigravityRequest()`, `isGenerativeLanguageRequest()` |
| Model Resolver | `transform/model-resolver.ts` | `resolveModelWithTier()`, `MODEL_ALIASES` |
| Proxy Server | `../plugin.ts` | `startEmbeddedProxyServer()`, `createAntigravityPlugin()` |
| Config Loader | `config/loader.ts` | `loadConfig()`, `getProjectConfigPath()` |
| Account Pool | `accounts.ts` | `AccountManager.loadFromDisk()`, `getAccountForFamily()` |

## CONVENTIONS
- All model resolution defaults to Antigravity quota.
- `loadConfig` must handle `undefined` or optional `directory` parameter safely.
- `startEmbeddedProxyServer` uses stream event listeners `req.on("data")` and `req.on("end")` for reliable body reading in Node.js v22.
- `isGenerativeLanguageRequest` must match `127.0.0.1:51128` requests to avoid recursive loop hangs.
