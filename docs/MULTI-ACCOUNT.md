# Multi-Account Setup

Add multiple Google accounts to increase your combined quota and improve availability. The plugin automatically rotates between accounts when one is rate-limited.

```bash
opencode auth login  # Run again to add more accounts
```

---

## Load Balancing Behavior

- **Sticky account selection** — Sticks to the same account until rate-limited (preserves Anthropic's prompt cache)
- **Per-model-family limits** — Rate limits tracked separately for Claude and Gemini models
- **Antigravity-first for Gemini** — Explicit `antigravity-*` models use Antigravity quota across accounts without Gemini CLI fallback
- **Smart retry threshold** — Short rate limits (≤5s) are retried on same account
- **Exponential backoff** — Increasing delays for consecutive rate limits

---

## Dual Quota Pools

For Gemini models, the plugin can access **two independent quota pools** per account. The auto-configured OpenCode models are explicit `antigravity-*` models, so they stay on Antigravity quota only.

| Quota Pool | When Used |
|------------|-----------|
| **Antigravity** | Default and only route for explicit `antigravity-*` models |
| **Gemini CLI** | Backward-compatible route for prefixless Gemini model names |

Prefixless Gemini model names can still use Gemini CLI fallback for backward compatibility, but the recommended model list is Antigravity-only.

### How Quota Fallback Works

1. Explicit `antigravity-*` requests use Antigravity quota on the current account
2. If rate-limited, plugin checks if ANY other account has Antigravity available
3. If yes → switch to that account and stay on Antigravity
4. If no → wait or fail fast according to rate-limit settings
5. Prefixless Gemini names may still fall back to Gemini CLI for compatibility

Automatic fallback between pools is not enabled for explicit `antigravity-*` requests.

---

## Checking Quotas

Check your current API usage across all accounts:

```bash
opencode auth login
# Select "Check quotas" from the menu
```

This shows remaining quota percentages and reset times for each model family:
- **Claude** - Claude Opus/Sonnet quota
- **Gemini 3 Pro** - Gemini 3 Pro quota
- **Gemini 3 Flash** - Gemini 3 Flash quota

### Standalone Quota Script

For checking quotas outside of OpenCode (for debugging, CI, etc.):

```bash
node scripts/check-quota.mjs                    # Check all accounts
node scripts/check-quota.mjs --account 2        # Check specific account
node scripts/check-quota.mjs --path /path/to/accounts.json  # Custom path
```

---

## Managing Accounts

Enable or disable specific accounts to control which ones are used for requests:

```bash
opencode auth login
# Select "Manage accounts (enable/disable)"
```

Or select an account from the list and choose "Enable/Disable account".

**Disabled accounts:**
- Are excluded from automatic rotation
- Still appear in quota checks (marked `[disabled]`)
- Can be re-enabled at any time

Useful when:
- An account is temporarily banned or rate-limited for an extended period
- You want to reserve certain accounts for specific use cases
- Testing with a subset of accounts

---

## Adding Accounts

When running `opencode auth login` with existing accounts:

```
2 account(s) saved:
  1. user1@gmail.com
  2. user2@gmail.com

(a)dd new account(s) or (f)resh start? [a/f]:
```

Choose `a` to add more accounts while keeping existing ones.

---

## Account Storage

Accounts are stored in `~/.config/opencode/antigravity-accounts.json`:

```json
{
  "version": 4,
  "accounts": [
    {
      "email": "user1@gmail.com",
      "refreshToken": "1//0abc...",
      "projectId": "my-gcp-project",
      "enabled": true
    },
    {
      "email": "user2@gmail.com",
      "refreshToken": "1//0xyz...",
      "enabled": false
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "claude": 0,
    "gemini": 0
  }
}
```

> **Note:** Storage formats v1-v3 automatically migrate to v4 on load.

> ⚠️ **Security:** This file contains OAuth refresh tokens. Treat it like a password file.

### Fields

| Field | Description |
|-------|-------------|
| `email` | Google account email |
| `refreshToken` | OAuth refresh token (auto-managed) |
| `projectId` | Optional. Required for Gemini CLI models. See [Troubleshooting](TROUBLESHOOTING.md#gemini-cli-permission-error). |
| `enabled` | Optional. Set to `false` to disable account rotation. Defaults to `true`. |
| `activeIndex` | Currently active account index |
| `activeIndexByFamily` | Per-model-family active account (claude/gemini tracked separately) |

---

## Token Revocation

If Google revokes a token (e.g., password change, security event), you'll see `invalid_grant` errors. The plugin automatically removes invalid accounts.

To manually reset:

**macOS / Linux:**
```bash
rm ~/.config/opencode/antigravity-accounts.json
opencode auth login
```

**Windows (PowerShell):**
```powershell
Remove-Item "$env:USERPROFILE\.config\opencode\antigravity-accounts.json" -Force -ErrorAction SilentlyContinue
opencode auth login
```

---

## Parallel Sessions (oh-my-opencode)

When using oh-my-opencode with parallel subagents, multiple processes may select the same account, causing rate limit errors.

**Solution:** Enable PID-based offset in `antigravity.json`:

```json
{
  "pid_offset_enabled": true
}
```

This distributes sessions across accounts based on process ID.

Alternatively, add more accounts via `opencode auth login`.

---

## Account Selection Strategies

Configure in `antigravity.json`:

```json
{
  "account_selection_strategy": "hybrid"
}
```

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Prompt cache preservation |
| `round-robin` | Rotate to next account on every request | Maximum throughput |
| `hybrid` | Deterministic selection based on health score + token bucket + LRU | Best overall distribution |

See [Configuration](CONFIGURATION.md#account-selection) for more details.
