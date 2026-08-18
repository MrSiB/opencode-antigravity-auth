# Google Models Discovery & Integration Guide

This guide documents the automated and direct API mechanisms to discover valid Google Cloud Code (Antigravity) and Gemini API model IDs without manual trial-and-error, as well as the step-by-step procedure for adding new models to `opencode-antigravity-auth`.

---

## 1. How to Retrieve the Official Model List from Google

### Method A: Google Cloud Code RPC (`fetchAvailableModels`)

Google Cloud Code backend maintains an active registry of all models available for OAuth accounts:

* **Endpoint:** `POST https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels`
* **Headers:**
  ```http
  Authorization: Bearer <GOOGLE_OAUTH_ACCESS_TOKEN>
  Content-Type: application/json
  User-Agent: antigravity/windows/amd64
  Client-Metadata: {"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}
  ```
* **Body:**
  ```json
  { "project": "" }
  ```

#### CLI Command:
```bash
node scripts/check-quota.mjs
```

---

### Method B: Public Gemini API (`ListModels`)

For models accessed via `GEMINI_API_KEY`:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" | jq '.models[].name'
```

---

## 2. Integration Checklist for New Models

When adding a newly announced Google model:

1. **Discover Backend ID**: Run `check-quota.mjs` or probe `fetchAvailableModels` to get the exact ID (e.g. `gemini-3.7-flash-tiered`).
2. **Probe Thinking Levels**: Test `minimal`, `low`, `medium`, `high` against `/v1internal:generateContent`.
3. **Update Model Resolver**: Add mapping in `src/plugin/transform/model-resolver.ts`.
4. **Update Sampling Sanitizer**: If strict sampling applies, update `STRICT_SAMPLING_MODEL_REGEX` in `src/plugin/transform/gemini.ts`.
5. **Update Model Configs**: Add definitions in `src/plugin/config/models.ts` and run `npm run build:schema`.
6. **Execute Test Suite**: Run `npm test && npm run typecheck`.
7. **Deploy to Target Server 123**: Sync `dist/` via rsync and restart `opencode.service`.
