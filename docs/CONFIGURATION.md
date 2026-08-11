# Configuration

Create `~/.config/opencode/antigravity.json` (or `.opencode/antigravity.json` in project root):

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json"
}
```

Most settings have sensible defaults, so only configure what you need.

---

## Quick Start

**Minimal config (recommended for most users):**

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json"
}
```

**Web Search:**

The plugin provides a `google_search` tool that models can call to search the web. No extra configuration is needed because the tool is always available.

---

## Model & Tool Behavior

Settings that affect model reasoning, recovery, and tool execution.

| Option | Default | Description |
|--------|---------|-------------|
| `keep_thinking` | `false` | Preserve Claude thinking blocks across turns. Enabling this may degrade model stability. |
| `session_recovery` | `true` | Auto-recover from tool_result_missing errors. |
| `auto_resume` | `false` | Auto-send resume prompt after successful recovery. |
| `resume_text` | `"continue"` | Text sent when auto-resuming a recovered session. |
| `claude_prompt_auto_caching` | `false` | Auto-add top-level `cache_control` to Claude prompts when missing. |
| `claude_tool_hardening` | `true` | Prevent parameter hallucinations in Claude tools by injecting signatures. |
| `tool_id_recovery` | `true` | Recover orphaned tool IDs caused by context compaction. |

> **Note:** Legacy `web_search` config options are deprecated. Google Search is now handled directly by the `google_search` tool.

### About `keep_thinking`

When set to `true`, Claude thinking blocks remain in conversation history:
- **Pros:** Preserves model reasoning for better continuity.
- **Cons:** May reduce model stability and uses more context tokens.

When set to `false` (default), thinking blocks are stripped:
- **Pros:** Stable model behavior and smaller context size.
- **Cons:** Model cannot review its prior reasoning chain.

---

## Account Rotation & Scheduling

Settings for managing multiple Google accounts and rate limit distribution.

| Option | Default | Description |
|--------|---------|-------------|
| `account_selection_strategy` | `"hybrid"` | Account selection algorithm (`sticky`, `round-robin`, or `hybrid`). |
| `scheduling_mode` | `"cache_first"` | Rate limit behavior (`cache_first`, `balance`, or `performance_first`). |
| `switch_on_first_rate_limit` | `true` | Switch to another account immediately on the first 429 response. |
| `pid_offset_enabled` | `false` | Distribute session starting indices using process ID (ideal for parallel agents). |
| `max_cache_first_wait_seconds` | `60` | Max seconds to wait for the same account in `cache_first` mode before switching. |
| `failure_ttl_seconds` | `3600` | Expiration time in seconds for resetting consecutive account failure counts. |
| `cli_first` | `false` | Prefer `gemini-cli` routing before Antigravity for prefixless Gemini models. |
| `quota_fallback` | `false` | Deprecated (ignored). Prefixless Gemini models fall back automatically; `antigravity-*` models stay on Antigravity. |

### Strategy Guide

| Your Setup | Recommended Strategy | Why |
|------------|---------------------|-----|
| **1 account** | `"sticky"` | Avoids rotation and preserves prompt cache. |
| **2-3 accounts** | `"hybrid"` (default) | Rotates based on health scoring and token bucket freshness. |
| **4+ accounts** | `"round-robin"` | Distributes load evenly for high throughput. |
| **Parallel agents** | `"round-robin"` + `pid_offset_enabled: true` | Offsets initial account per process to prevent collision. |

### Available Strategies

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Reuses the same account until rate-limited. | Single account setups and prompt caching. |
| `round-robin` | Rotates to the next account on every request. | Maximum throughput across accounts. |
| `hybrid` | Uses health scores, token buckets, and LRU freshness. | Smart multi-account distribution (default). |

---

## Quota & Protection

Settings for monitoring quota limits and preventing account exhaustion.

| Option | Default | Description |
|--------|---------|-------------|
| `soft_quota_threshold_percent` | `90` | Skip account when quota usage hits this percentage (set to 100 to disable). |
| `quota_refresh_interval_minutes` | `15` | Background quota refresh interval in minutes (set to 0 to disable). |
| `soft_quota_cache_ttl_minutes` | `"auto"` | Cache freshness TTL for quota checks (`"auto"` calculates max(2 * refresh_interval, 10)). |
| `max_rate_limit_wait_seconds` | `300` | Maximum wait time in seconds when all accounts are rate-limited (0 = wait indefinitely). |

---

## App & General Behavior

Settings that control notifications, logging, and background updates.

| Option | Default | Description |
|--------|---------|-------------|
| `quiet_mode` | `false` | Hide non-critical toast notifications. |
| `toast_scope` | `"root_only"` | Control toast scope (`root_only` limits toasts to root sessions; `all` includes subagents). |
| `debug` | `false` | Write detailed debug logs to disk. |
| `debug_tui` | `false` | Display debug logs directly in the TUI log panel. |
| `log_dir` | OS default | Custom directory path for debug log files. |
| `auto_update` | `true` | Automatically update the plugin when new versions release. |

### Debug Logging

```json
{
  "debug": true,
  "debug_tui": true
}
```

Logs write to `~/.config/opencode/antigravity-logs/` (or your custom `log_dir`).

---

## Recommended Configs

Ready to use configuration presets.

### 1 Account

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json",
  "account_selection_strategy": "sticky"
}
```

**Why these settings:**
- `sticky`: Keeps using the active account to preserve Anthropic prompt cache.

### 2-3 Accounts

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json",
  "account_selection_strategy": "hybrid"
}
```

**Why these settings:**
- `hybrid`: Smart rotation using health scores to bypass degraded accounts.

### 3+ Accounts (Power Users / Parallel Agents)

```json
{
  "$schema": "https://raw.githubusercontent.com/mrsib/opencode-antigravity-auth/master/assets/antigravity.schema.json",
  "account_selection_strategy": "round-robin",
  "switch_on_first_rate_limit": true,
  "pid_offset_enabled": true
}
```

**Why these settings:**
- `round-robin`: Maximizes overall request throughput.
- `switch_on_first_rate_limit`: Switches account immediately on 429 response.
- `pid_offset_enabled`: Offsets account choice across concurrent processes.

---

## Defaults Overview

These features run with `true` by default without needing explicit configuration:

| Setting | Default | What it does |
|---------|---------|--------------|
| `session_recovery` | `true` | Auto-recovers from session errors. |
| `tool_id_recovery` | `true` | Fixes mismatched tool IDs. |
| `claude_tool_hardening` | `true` | Hardens tool parameter descriptions. |
| `proactive_token_refresh` | `true` | Refreshes Google OAuth tokens in the background. |
| `switch_on_first_rate_limit` | `true` | Fast account switching on 429 errors. |
| `auto_update` | `true` | Keeps plugin up to date. |

These options remain `false` by default:

| Setting | Default | What it does |
|---------|---------|--------------|
| `keep_thinking` | `false` | Preserves Claude thinking blocks. |
| `auto_resume` | `false` | Auto-sends resume text after recovery. |
| `claude_prompt_auto_caching` | `false` | Automatically adds prompt cache headers to Claude requests. |
| `quiet_mode` | `false` | Suppresses user notifications. |
| `debug` | `false` | Writes debug log files. |
| `debug_tui` | `false` | Shows debug events in TUI logs. |

---

## Advanced Settings

> These settings target specialized use cases. Most setups work fine with defaults.

<details>
<summary><b>Retry, Backoff & Jitter</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `empty_response_max_attempts` | `4` | Retry attempts when API returns an empty candidate response. |
| `empty_response_retry_delay_ms` | `2000` | Delay in milliseconds between empty response retries. |
| `default_retry_after_seconds` | `60` | Default wait time in seconds when API response lacks a Retry-After header. |
| `max_backoff_seconds` | `60` | Maximum cap in seconds for exponential backoff delays. |
| `request_jitter_max_ms` | `0` | Maximum random delay in milliseconds added before API requests (0 disables). |

</details>

<details>
<summary><b>Token Management</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Background token refresh before expiration. |
| `proactive_refresh_buffer_seconds` | `1800` | Lead time in seconds before token expiry to trigger refresh (30 min). |
| `proactive_refresh_check_interval_seconds` | `300` | Interval in seconds between background token checks (5 min). |

</details>

<details>
<summary><b>Signature Cache</b></summary>

Used when `keep_thinking` is enabled.

| Option | Default | Description |
|--------|---------|-------------|
| `signature_cache.enabled` | `true` | Enables disk caching for thinking block signatures. |
| `signature_cache.memory_ttl_seconds` | `3600` | In-memory signature cache TTL (1 hour). |
| `signature_cache.disk_ttl_seconds` | `172800` | Disk signature cache TTL (48 hours). |
| `signature_cache.write_interval_seconds` | `60` | Background disk flush interval in seconds. |

</details>

<details>
<summary><b>Health Score Tuning</b></summary>

Used by the `hybrid` strategy.

| Option | Default | Description |
|--------|---------|-------------|
| `health_score.initial` | `70` | Initial health score assigned to accounts. |
| `health_score.success_reward` | `1` | Health points gained per successful request. |
| `health_score.rate_limit_penalty` | `-10` | Health points deducted on rate limit encounter. |
| `health_score.failure_penalty` | `-20` | Health points deducted on request failure. |
| `health_score.recovery_rate_per_hour` | `2` | Health points restored per hour of inactivity. |
| `health_score.min_usable` | `50` | Minimum score required before skipping an account. |
| `health_score.max_score` | `100` | Maximum cap for account health score. |

</details>

<details>
<summary><b>Token Bucket Tuning</b></summary>

Used by the `hybrid` strategy.

| Option | Default | Description |
|--------|---------|-------------|
| `token_bucket.max_tokens` | `50` | Maximum token bucket capacity. |
| `token_bucket.regeneration_rate_per_minute` | `6` | Tokens regenerated per minute. |
| `token_bucket.initial_tokens` | `50` | Starting token count in bucket. |

</details>
