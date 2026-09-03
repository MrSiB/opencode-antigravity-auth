# Resilience and Recovery Architecture (v1.6.2+)

This document details the self-healing invariants, crash recovery mechanisms, and operational safeguards introduced in `opencode-antigravity-auth` v1.6.2 following forensic investigations into multi-account cascading outages, SQLite corruption under Docker bind mounts, and token refresh storms.

---

## 1. Multi-Account Invariants & Fail-Safe Recovery

### The Last Survivor Rule
In previous versions, receiving an upstream HTTP 403 with `validation_required` (e.g. during transient Google Security challenges, network initialization delays, or IP reputation checks) caused `markAccountVerificationRequired()` to unconditionally disable the account (`account.enabled = false`).

During network hiccups or sequential requests, this triggered a cascade where 100% of accounts were disabled one-by-one. Once all accounts had `enabled: false`, subsequent requests failed with:
```text
No Antigravity accounts available and no valid Gemini API key configured. Run opencode auth login to authenticate.
```

**v1.6.2 Invariant**:
- Before disabling an account, the plugin inspects the active pool size via `getEnabledAccounts().length`.
- If disabling the account would leave **0 enabled accounts** (`length <= 1`), the **Last Survivor Rule** activates:
  1. The account remains `enabled: true`.
  2. A temporary 10-minute cooldown is applied (`markAccountCoolingDown(10 * 60 * 1000, "last-survivor-cooldown")`).
  3. A prominent warning is logged:
     ```text
     [Account] Last survivor rule activated: account N (user@domain.com) remains enabled with cooldown
     ```
  4. The system **never exhausts the pool down to zero**, preventing deadlocks.

### Startup Fail-Safe Recovery
If an external script, previous version, or manual edit left `antigravity-accounts.json` with all accounts set to `enabled: false`, the plugin automatically self-heals during `loadAccounts()` and `AccountManager` initialization:
1. Detects `accounts.length > 0 && accounts.every(acc => acc.enabled === false)`.
2. Restores `acc.enabled = true` across the entire account pool.
3. Automatically prunes stale `verificationRequired` flags older than 30 minutes, allowing transient errors to expire while keeping fresh legitimate challenges visible.
4. Asynchronously commits the healed state to disk.

---

## 2. Token Concurrency & Blacklist Self-Healing

### In-Flight Token Refresh Mutex (Single-Flight Pattern)
When multiple concurrent subagents or background tasks send requests when an account's `access_token` has expired, they previously issued simultaneous POST requests to `https://oauth2.googleapis.com/token` using the identical `refresh_token`.

Google detects duplicate refresh token usage as token replay, returning:
```json
HTTP 400 Bad Request
{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
```
This false positive caused the plugin to permanently delete the account from the pool and write its hash to `deletedRefreshTokenHashes`.

**v1.6.2 Implementation**:
- Module-level `inFlightRefreshes = new Map<string, Promise<OAuthAuthDetails | undefined>>()`.
- When `refreshAccessToken()` is called, it checks if an in-flight Promise exists for `parts.refreshToken`.
- If a refresh is already in progress, concurrent callers await and share that same Promise without dispatching additional network calls.
- A `finally` block guarantees cleanup of the in-flight map entry on both success and rejection.

### Blacklist TTL & Un-Blacklist on Account Addition
Previous versions stored revoked token hashes in `deletedRefreshTokenHashes` permanently without expiration. Even if an account was re-added or re-authenticated, `mergeAccountStorage()` silently filtered it out on every save.

**v1.6.2 Implementation**:
- Blacklist entries support deletion timestamps: `DeletedRefreshTokenHashEntry` (`{ hash: string, deletedAt: number }`).
- Enforces `DELETED_HASH_TTL_MS = 24 * 60 * 60 * 1000` (24 hours). Stale blacklist entries older than 24 hours are automatically pruned during `loadAccounts()` and `mergeAccountStorage()`.
- **Self-Healing Un-Blacklisting**: When an account is explicitly added, saved, or imported via `saveAccounts()` or `saveAccountsReplace()`, its hash is removed from `deletedRefreshTokenHashes`, allowing immediate recovery.

---

## 3. Storage Resilience & Docker Bind-Mount Safety

### Atomic Write EBUSY Fallback
In containerized environments (such as Docker, Podman, or Kubernetes), mounting configuration files directly as single-file bind mounts (`- /host/path/file.json:/container/path/file.json:rw`) turns the target into a Linux mount point.

Standard atomic writes (`write to temp file + fs.rename()`) fail on mount points with:
```text
[Errno 16] Device or resource busy (EBUSY) / EXDEV / EPERM
```

**v1.6.2 Implementation**:
- `writeAccountsAtomically()` catches `EBUSY`, `EXDEV`, and `EPERM` during `fs.rename()`.
- Automatically falls back to copying the temp file over the target (`await fs.copyFile(tempPath, path)`) followed by unlinking the temporary file (`await fs.unlink(tempPath)`).
- Preserves the existing inode on active bind mounts and prevents orphaned temporary files.

### Docker SQLite Directory Mount Invariant
When using Write-Ahead Logging (`PRAGMA journal_mode=WAL;`), SQLite creates auxiliary files (`.db-wal` and `.db-shm`) in the same directory as the database file.

**Crucial Docker Configuration**:
- **NEVER** bind-mount an SQLite database as a single file:
  ```yaml
  # BAD: WAL and SHM are written to container overlayfs; desynchronizes on reboot!
  volumes:
    - /root/.config/opencode/antigravity-analytics.db:/root/.config/opencode/antigravity-analytics.db:rw
  ```
- **ALWAYS** bind-mount the parent directory:
  ```yaml
  # GOOD: Database, WAL, and SHM stay on identical host filesystem
  volumes:
    - /root/.config/opencode:/root/.config/opencode:rw
  ```

### Non-Destructive Quarantine in SQLite Services
If an SQLite database is reported malformed, services must avoid `shutil.move()` across active mount points. Instead, use:
1. `shutil.copy2(db_path, backup_path)`
2. In-place truncation: `open(db_path, "wb").truncate(0)`
3. Removal of associated `-wal` and `-shm` files
4. Auto-rotation retaining strictly `max 2` backup files to prevent disk exhaustion (`ENOSPC`).

---

## 4. Process Termination & Exit Flush Handlers

To avoid losing account state, rate-limit reset markers, or active account indexes when the systemd service or container restarts:
1. **Debounce Flush (`flushSaveToDisk`)**:
   - Cancels the 1000ms debounce timer immediately and executes the disk write synchronously without waiting.
2. **Process Signals**:
   - `AccountManager.registerExitHandlers()` registers listeners for `SIGTERM`, `SIGINT`, and `beforeExit` to flush pending writes before termination.
3. **Systemd Service Timeout**:
   - Systemd units (`opencode.service` / `opencode-web.service`) should configure `TimeoutStopSec=15s` and `KillSignal=SIGTERM` so processes have sufficient time to flush buffers and release file locks before receiving `SIGKILL`.

---

## 5. Defensive Sorting (`localeCompare` Safety)

All internal array sort comparators (`messages.sort`, `parts.sort`, `models.sort`, `accounts.sort`) use defensive nullish coalescing to prevent fatal `TypeError: Cannot read properties of undefined (reading 'localeCompare')`:

```typescript
// Safe Message Sorting
messages.sort((a, b) => {
  const aTime = a.time?.created ?? 0;
  const bTime = b.time?.created ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return (a.id ?? "").localeCompare(b.id ?? "");
});

// Safe Part Sorting
parts.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));

// Safe Model Sorting
models.sort((a, b) => (a.modelId ?? "").localeCompare(b.modelId ?? ""));

// Safe CLI Row Sorting (ag-status)
rows.sort((a, b) => (b.gRem - a.gRem) || (b.cRem - a.cRem) || (a.email || "").localeCompare(b.email || ""));
```

---

## 6. Verification & Health Monitoring

To verify the resilience of an OpenCode node running `opencode-antigravity-auth`:

```bash
# 1. Check account pool health (all accounts enabled, empty blacklist)
node -e "
  const data = JSON.parse(require('fs').readFileSync('/root/.config/opencode/antigravity-accounts.json', 'utf8'));
  const total = data.accounts.length;
  const enabled = data.accounts.filter(a => a.enabled !== false).length;
  console.log('Total accounts:', total, '| Enabled:', enabled, '| Blacklist:', data.deletedRefreshTokenHashes?.length || 0);
"

# 2. Check SQLite database integrity
sqlite3 /root/.config/opencode/antigravity-analytics.db "PRAGMA integrity_check;"

# 3. Check CLI quota status
ag-status
ag-status limits
```
