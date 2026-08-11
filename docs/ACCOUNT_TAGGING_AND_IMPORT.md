# Tagged Accounts, Remote Import, and Emergency Killswitch

This guide explains how to tag accounts by origin/source (e.g. imported from external servers/services), safely import remote authorization records, and use the Emergency Killswitch to instantly manage or disconnect tagged account groups.

---

## Overview

When connecting accounts or authorization tokens from external sources (such as a remote team server or shared infrastructure), you need:
1. **Source Tagging**: Easily identify where an account originated (`tag: "remote-team-31.76.244.138"`).
2. **Visual Badging**: See which accounts belong to which group in the interactive TUI menu (`[remote-team-31.76.244.138]`).
3. **Emergency Disconnect (Killswitch)**: Instant single-command disable, enable, or permanent deletion of an entire tagged group without affecting your primary local accounts.
4. **Safe Remote Import**: Import accounts and full authorization payloads via SSH with dual-deduplication (prevents overwriting local credentials) and automatic timestamped backups.

---

## 1. Safe Remote Import

Use `scripts/import_accounts.ts` to fetch authorization records from a remote SSH host or local file target.

### Usage

```bash
# Preview import with dry-run (no disk changes)
npx tsx scripts/import_accounts.ts --target root@31.76.244.138 --dry-run

# Import remote authorization data with default tag (remote-team-31.76.244.138)
npx tsx scripts/import_accounts.ts --target root@31.76.244.138

# Import with custom tag and custom remote path
npx tsx scripts/import_accounts.ts \
  --target root@31.76.244.138 \
  --tag my-friend-group \
  --remote-path /path/to/remote/antigravity-accounts.json
```

### Safety Features
- **Parameterized SSH Execution**: Uses `execFile("ssh", [target, ...])` to prevent shell injection.
- **Dual Deduplication**: Compares incoming records against local storage on BOTH `refreshToken` AND `email`. If either matches, the incoming item is safely skipped to protect existing local accounts.
- **Automatic Backup**: Creates a timestamped backup (`antigravity-accounts.json.bak.<timestamp>`) before modifying disk storage.
- **Full Payload Extraction**: Preserves `refreshToken`, packed `projectId`/`managedProjectId`, `email`, `fingerprint`, and `rateLimitResetTimes`.

---

## 2. Emergency Killswitch CLI

Use `scripts/manage_tagged_accounts.ts` for 1-second bulk operations on tagged account groups.

### Commands

```bash
# List accounts by tag
npx tsx scripts/manage_tagged_accounts.ts list --tag remote-team-31.76.244.138

# Instant Disable (Emergency Disconnect)
npx tsx scripts/manage_tagged_accounts.ts disable --tag remote-team-31.76.244.138

# Re-enable Tagged Group
npx tsx scripts/manage_tagged_accounts.ts enable --tag remote-team-31.76.244.138

# Permanent Purge / Deletion
npx tsx scripts/manage_tagged_accounts.ts delete --tag remote-team-31.76.244.138
```

### Safety Features
- **Strict Tag Requirement**: Mutating commands (`disable`, `enable`, `delete`) require a non-empty `--tag <name>`. Running without `--tag` will fail immediately with exit code 1 to avoid accidental global operations.
- **Atomic Deletion**: `delete` uses `saveAccountsReplace()` so deleted accounts are completely removed from disk and cannot be restored by file merging routines.
- **Pre-Operation Backup**: Generates `antigravity-accounts.json.bak.<timestamp>` prior to executing mutating actions.

---

## 3. TUI & Programmatic API

### TUI Badge Display

When launching `opencode auth login`, accounts with a `tag` property display a colored badge:
```text
1. myemail@gmail.com [current] [active]
2. team-user@example.com [remote-team-31.76.244.138] [active]
3. backup@example.com [remote-team-31.76.244.138] [disabled]
```

### Programmatic API (`AccountManager`)

In TypeScript / plugin code, `AccountManager` provides dedicated methods for tagged account management:

```typescript
import { AccountManager } from "./src/plugin/accounts";

const manager = await AccountManager.loadFromDisk();

// Filter accounts by tag
const taggedAccounts = manager.getAccountsByTag("remote-team-31.76.244.138");

// Bulk enable/disable
manager.setTagEnabled("remote-team-31.76.244.138", false); // Disables all matching accounts

// Bulk deletion with atomic replacement
manager.removeAccountsByTag("remote-team-31.76.244.138"); // Deletes and saves via saveAccountsReplace
```
