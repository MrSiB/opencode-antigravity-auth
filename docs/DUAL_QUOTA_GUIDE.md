# Dual Quota Guide (Antigravity & Gemini CLI)

This document describes the Dual Quota architecture and configuration in `opencode-antigravity-auth`, enabling Google One AI Premium / Google AI Pro users to leverage both **Antigravity** and **Gemini CLI** quota limits simultaneously.

---

## 1. Overview & Dual Quota Architecture

Google AI Pro subscriptions provide access to model capacity through two distinct internal quota pools:
1. **Antigravity Quota Pool**:
   - Primary quota pool for high-tier models (`Claude Opus/Sonnet 4.6`, `Gemini 3 Pro`, `Gemini 3 Flash`, `Gemini 3.6 Flash`).
   - Endpoint: `https://cloudcode-pa.googleapis.com` (or sandbox endpoints).
   - Headers: `User-Agent: antigravity/...`, `X-Goog-Api-Client: google-cloud-sdk...`.
   - Request Body: Includes `{ project, model, request, requestType: "agent", userAgent: "antigravity" }`.

2. **Gemini CLI Quota Pool (The 2nd Limit)**:
   - Secondary/fallback quota pool for Gemini models (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.6-flash`).
   - Endpoint: Production `https://cloudcode-pa.googleapis.com` only.
   - Headers: `User-Agent: google-api-nodejs-client/9.15.1`, `X-Goog-Api-Client: gl-node/22.17.0`, `Client-Metadata: ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI`.
   - Request Body: Includes `{ project: syntheticProjectId, model: cliModelName, request }`.

---

## 2. Key Fixes for the 2nd Limit (Gemini CLI)

- **Project ID Fallback**: Resolves `effectiveProjectId` using synthetic/default Project ID when `projectId` is unassigned, preventing HTTP 400/403 API rejections on Gemini CLI endpoints.
- **Model Resolver Alignment**: Updated `resolveModelForHeaderStyle` to transform Gemini 2.5 and Gemini 3 model names correctly for Gemini CLI production endpoints.
- **Additive Quota Caching**: Integrated `geminiCliQuota` into `AccountMetadataV3`, `cachedQuota`, and `AccountManager` soft-quota threshold checks (`isOverSoftQuotaThreshold`).
- **Zero-Impact Antigravity Isolation**: All Gemini CLI logic is strictly isolated inside `headerStyle === "gemini-cli"` conditionals. Existing Antigravity requests remain 100% untouched.

---

## 3. Quota Status Checking

To view live quota percentages for both **Antigravity** and **Gemini CLI** pools across all configured accounts:

```bash
node scripts/check-quota.mjs
```

Example output:
```text
lhsvoteam2@gmail.com
  project: future-grove-w40ks
  fetchAvailableModels: 200
  Claude: OK (remaining 100%, resets in 5h 0m)
  Gemini 3 Pro: OK (remaining 99%, resets in 4h 29m)
  Gemini 3 Flash: OK (remaining 99%, resets in 4h 29m)
  Gemini CLI (gemini-2.5-flash): OK (remaining 100%, resets in 24h 0m)
  Gemini CLI (gemini-2.5-pro): OK (remaining 100%, resets in 24h 0m)
```

---

## 4. Model Usage Commands

### Gemini CLI Models (2nd Limit)
```bash
# Gemini 2.5 Flash
opencode run -m google/gemini-2.5-flash "Test message"

# Gemini 2.5 Pro
opencode run -m google/gemini-2.5-pro "Test message"

# Gemini 3 Flash Preview
opencode run -m google/gemini-3-flash-preview "Test message"

# Gemini 3 Pro Preview
opencode run -m google/gemini-3-pro-preview "Test message"

# Gemini 3.6 Flash CLI
opencode run -m google/gemini-3.6-flash "Test message"
```

### Antigravity Models (1st Limit)
```bash
# Antigravity Gemini 3.6 Flash High Thinking
opencode run -m google/antigravity-gemini-3.6-flash-high "Test message"

# Antigravity Claude Sonnet 4.6
opencode run -m google/claude-sonnet-4-6 "Test message"
```

---

## 5. Pre-Edit Backup & Automated Restoration

All source file modifications are backed up in `.backup/` before editing. A 1-command rollback script and manual restoration instructions are provided:

- **Dry-run simulation**:
  ```bash
  bash scripts/restore.sh --dry-run
  ```
- **Automated restoration**:
  ```bash
  bash scripts/restore.sh
  ```
- **Manual restoration guide**: See `RESTORE_INSTRUCTIONS.md`.
