# Support Matrix

This document provides a breakdown of feature support, model availability, credential requirements, and limitations across the three transport modes supported by `opencode-antigravity-auth`.

---

## Transport Modes Overview

The plugin connects to model backends through three distinct transport layers:

1. **`gateway` (CloudCode Gateway Shim)**: Default transport mode. Intercepts OpenCode requests and forwards them directly to Google internal IDE gateway endpoints. It supports full streaming, function tool calling, multi-account pool rotation, thinking models, and automatic rate limit backoff.
2. **`cli` (`agy --print` Subprocess)**: Opt-in transport mode. Executes the local `agy` command line tool in subprocess mode. It handles plain text responses and basic streaming, but lacks structured tool calling, thinking budget controls, and multi-account rotation.
3. **`managed-agent` (Public API)**: Opt-in transport mode for public Google Cloud Vertex and Gemini API endpoints using standard API keys. Standard Google Cloud project billing applies.

> [!WARNING]
> **Gemini CLI Sunset Notice (2026-06-18)**
> Google announced that Gemini CLI quota access for individual and free Google AI Pro/Ultra and Gemini Code Assist users will end on **June 18, 2026**.
> Legacy Gemini CLI model IDs (`gemini-2.5-pro`, `gemini-2.5-flash`) and CLI pool fallback will stop serving requests after this date. All users should use the default `gateway` mode and active `antigravity-*` model IDs.

---

## Feature Comparison Matrix

| Feature | `gateway` (CloudCode Shim) | `cli` (`agy --print`) | `managed-agent` (Public API) |
|---------|---------------------------|----------------------|-----------------------------|
| **Status** | Default / Recommended | Deprecated (Sunset 2026-06-18) | Opt-in |
| **Response Streaming (SSE)** | Yes | Yes (Stdout pipe) | Yes |
| **Function & Tool Calling** | Yes (Full JSON schema validation) | No (Text only) | Yes |
| **Multi-Account Pool Rotation** | Yes (`sticky`, `hybrid`, `round-robin`) | No (Single CLI profile) | No |
| **Thinking Models & Budget Signatures** | Yes (`low`, `medium`, `high`) | No | Partial (Model dependent) |
| **Web Search Grounding** | Yes (`google_search` tool) | No | Yes (Grounding API) |
| **Rate Limit Backoff & Cooldown** | Yes (Exponential backoff + jitter) | No | Handled by SDK |
| **Credential Type** | Google OAuth refresh tokens | Local `agy` binary session | Gemini API key / GCP Service Account |
| **Quota & Billing** | Free Antigravity IDE tier | Gemini CLI free tier | Standard GCP pay-as-you-go |

---

## Model Availability Matrix

| Model Identifier | `gateway` | `cli` | `managed-agent` | Notes |
|------------------|-----------|-------|-----------------|-------|
| `antigravity-gemini-3.1-pro-low` | Yes | No | No | Active Antigravity quota set |
| `antigravity-gemini-3.1-pro-high` | Yes | No | No | Active Antigravity quota set |
| `antigravity-gemini-3.5-flash-low` | Yes | No | No | Active Antigravity quota set |
| `antigravity-gemini-3.5-flash-medium` | Yes | No | No | Active Antigravity quota set |
| `antigravity-gemini-3.5-flash-high` | Yes | No | No | Active Antigravity quota set |
| `antigravity-claude-sonnet-4-6-thinking` | Yes | No | No | Preserves thought signatures |
| `antigravity-claude-opus-4-6-thinking` | Yes | No | No | Preserves thought signatures |
| `antigravity-gpt-oss-120b-medium` | Yes | No | No | Active Antigravity quota set |
| `gemini-2.5-pro` (Legacy CLI) | Fallback only | Yes | Yes | Sunsetting 2026-06-18 |
| `gemini-2.5-flash` (Legacy CLI) | Fallback only | Yes | Yes | Sunsetting 2026-06-18 |

---

## Transport Configuration

To select or configure transport options, update `~/.config/opencode/antigravity.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json",
  "cli_first": false,
  "quota_fallback": false
}
```

- Keep `quota_fallback: false` to ensure requests route strictly through the high-capacity `gateway` mode.
- Setting `cli_first: true` prioritizes CLI routing for prefixless Gemini models, which is not recommended due to the upcoming June 2026 deprecation.
