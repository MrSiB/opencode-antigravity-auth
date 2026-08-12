import { promises as fs } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import type { HeaderStyle } from "../constants.js";
import { createLogger } from "./logger.js";

const log = createLogger("storage");

/**
 * Files/directories that should be gitignored in the config directory.
 * These contain sensitive data or machine-specific state.
 */
export const GITIGNORE_ENTRIES = [
  ".gitignore",
  "antigravity-accounts.json",
  "antigravity-accounts.json.*.tmp",
  "antigravity-signature-cache.json",
  "antigravity-logs/",
];

/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    try {
      content = await fs.readFile(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      await fs.writeFile(
        gitignorePath,
        missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } else {
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.includes(entry),
    );

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(
        gitignorePath,
        suffix + missingEntries.join("\n") + "\n",
        "utf-8",
      );
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

export type ModelFamily = "claude" | "gemini";
export type { HeaderStyle };

export interface RateLimitState {
  claude?: number;
  gemini?: number;
}

export interface RateLimitStateV3 {
  claude?: number;
  "gemini-antigravity"?: number;
  "gemini-cli"?: number;
  [key: string]: number | undefined;
}

export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
}

export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

export type CooldownReason = "auth-failure" | "network-error" | "project-error" | "validation-required";

export interface TokenBucket {
  timestamp: number;
  tokens: number;
}

export interface QuotaSnapshot {
  timestamp: number;
  remainingFraction: number;
  family: string;
}

export interface AccountTokenUsageState {
  fiveHourBuckets?: TokenBucket[];
  weeklyBuckets?: TokenBucket[];
  fiveHourTokenCap?: Record<string, number>;
  weeklyTokenCap?: Record<string, number>;
  last429Ts?: Record<string, number>;
  quotaSnapshots?: QuotaSnapshot[];
}

/**
 * Calculates empirical capacity from tokens used and remaining fraction.
 * Formula: Math.round(tokensUsed / Math.max(0.01, 1.0 - remainingFraction))
 * Returns number when tokensUsed > 10000 and 0.0 <= remainingFraction <= 0.99, else undefined.
 */
export function calculateEmpiricalCapacity(
  tokensUsed: number,
  remainingFraction?: number,
): number | undefined {
  if (tokensUsed <= 10000 || remainingFraction === undefined) {
    return undefined;
  }
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
    return undefined;
  }
  if (remainingFraction < 0.0 || remainingFraction > 0.99) {
    return undefined;
  }
  const usedFraction = Math.max(0.01, 1.0 - remainingFraction);
  return Math.round(tokensUsed / usedFraction);
}

export interface AccountMetadataV3 {
  email?: string;
  tag?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  enabled?: boolean;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateV3;
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
  fingerprintHistory?: import("./fingerprint").FingerprintVersion[];
  /** Set when Google asks the user to verify this account before requests can continue. */
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
  /** Cached soft quota data */
  cachedQuota?: Record<string, { remainingFraction?: number; resetTime?: string; modelCount: number }>;
  cachedQuotaUpdatedAt?: number;
  cachedGeminiCliQuota?: import("./quota").GeminiCliQuotaSummary;
  /** Rolling token usage state and empirical caps */
  tokenUsage?: AccountTokenUsageState;
}

export interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

export interface AccountStorageV4 {
  version: 4;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

type AnyAccountStorage =
  | AccountStorageV1
  | AccountStorage
  | AccountStorageV3
  | AccountStorageV4;

/**
 * Gets the legacy Windows config directory (%APPDATA%\opencode).
 * Used for migration from older plugin versions.
 */
function getLegacyWindowsConfigDir(): string {
  return join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "opencode",
  );
}

/**
 * Gets the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 *
 * On Windows, also checks for legacy %APPDATA%\opencode path for migration.
 */
function getConfigDir(): string {
  // 1. Check for explicit override via env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }

  // 2. Use ~/.config/opencode on all platforms (including Windows)
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Migrates config from legacy Windows location to the new path.
 * Moves the file if legacy exists and new doesn't.
 * Returns true if migration was performed.
 */
function migrateLegacyWindowsConfig(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const newPath = join(getConfigDir(), "antigravity-accounts.json");
  const legacyPath = join(
    getLegacyWindowsConfigDir(),
    "antigravity-accounts.json",
  );

  // Only migrate if legacy exists and new doesn't
  if (!existsSync(legacyPath) || existsSync(newPath)) {
    return false;
  }

  try {
    // Ensure new config directory exists
    const newConfigDir = getConfigDir();

    mkdirSync(newConfigDir, { recursive: true });

    // Try rename first (atomic, but fails across filesystems)
    try {
      renameSync(legacyPath, newPath);
      log.info("Migrated Windows config via rename", { from: legacyPath, to: newPath });
    } catch {
      // Fallback: copy then delete (for cross-filesystem moves)
      copyFileSync(legacyPath, newPath);
      unlinkSync(legacyPath);
      log.info("Migrated Windows config via copy+delete", { from: legacyPath, to: newPath });
    }

    return true;
  } catch (error) {
    log.warn("Failed to migrate legacy Windows config, will use legacy path", {
      legacyPath,
      newPath,
      error: String(error),
    });
    return false;
  }
}

/**
 * Gets the storage path, migrating from legacy Windows location if needed.
 * On Windows, attempts to move legacy config to new path for alignment.
 */
function getStoragePathWithMigration(): string {
  const newPath = join(getConfigDir(), "antigravity-accounts.json");

  // On Windows, attempt to migrate legacy config to new location
  if (process.platform === "win32") {
    migrateLegacyWindowsConfig();

    // If migration failed and legacy still exists, fall back to it
    if (!existsSync(newPath)) {
      const legacyPath = join(
        getLegacyWindowsConfigDir(),
        "antigravity-accounts.json",
      );
      if (existsSync(legacyPath)) {
        log.info("Using legacy Windows config path (migration failed)", {
          legacyPath,
          newPath,
        });
        return legacyPath;
      }
    }
  }

  return newPath;
}

export function getStoragePath(): string {
  return getStoragePathWithMigration();
}

/**
 * Gets the config directory path. Exported for use by other modules.
 */
export { getConfigDir };

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

/**
 * Ensures the file has secure permissions (0600) on POSIX systems.
 * This is a best-effort operation and ignores errors on Windows/unsupported FS.
 */
async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Ignore errors (e.g. Windows, file doesn't exist, FS doesn't support chmod)
  }
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: 4, accounts: [], activeIndex: 0 }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        log.warn("Failed to release lock", { error: String(unlockError) });
      }
    }
  }
}

function mergeAccountStorage(
  existing: AccountStorageV4,
  incoming: AccountStorageV4,
): AccountStorageV4 {
  const accountMap = new Map<string, AccountMetadataV3>();

  for (const acc of existing.accounts) {
    const key = acc.email || acc.refreshToken;
    if (key) {
      accountMap.set(key, acc);
    }
  }

  for (const acc of incoming.accounts) {
    const key = acc.email || acc.refreshToken;
    if (key) {
      const existingAcc = accountMap.get(key);
      if (existingAcc) {
        accountMap.set(key, {
          ...existingAcc,
          ...acc,
          projectId: acc.projectId ?? existingAcc.projectId,
          managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        });
      } else {
        accountMap.set(key, acc);
      }
    }
  }

  const mergedAccounts = deduplicateAccountsByEmail(Array.from(accountMap.values()));

  return {
    version: 4,
    accounts: mergedAccounts,
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily,
  };
}

export function deduplicateAccountsByEmail<
  T extends { email?: string; lastUsed?: number; addedAt?: number },
>(accounts: T[]): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  // First pass: find the newest account for each email (by lastUsed, then addedAt)
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;

    if (!acc.email) {
      // No email - keep this account (can't deduplicate without email)
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Compare to find which is newer
    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Prefer higher lastUsed, then higher addedAt
    // Compare fields separately to avoid integer overflow with large timestamps
    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;

    const isNewer =
      currLastUsed > existLastUsed ||
      (currLastUsed === existLastUsed && currAddedAt > existAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }

  // Add all the newest email-based indices to the keep set
  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  // Build the deduplicated list, preserving original order for kept items
  const result: T[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }

  return result;
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (
        acc.isRateLimited &&
        acc.rateLimitResetTime &&
        acc.rateLimitResetTime > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

export function migrateV2ToV3(v2: AccountStorage): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateV3 = {};
      if (
        acc.rateLimitResetTimes?.claude &&
        acc.rateLimitResetTimes.claude > Date.now()
      ) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
      }
      if (
        acc.rateLimitResetTimes?.gemini &&
        acc.rateLimitResetTimes.gemini > Date.now()
      ) {
        rateLimitResetTimes["gemini-antigravity"] =
          acc.rateLimitResetTimes.gemini;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes:
          Object.keys(rateLimitResetTimes).length > 0
            ? rateLimitResetTimes
            : undefined,
      };
    }),
    activeIndex: v2.activeIndex,
  };
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

function pruneBuckets(buckets: TokenBucket[], maxSpanMs: number, now: number): TokenBucket[] {
  const cutoff = now - maxSpanMs;
  return buckets.filter((b) => b.timestamp >= cutoff);
}

export function addTokensToUsageState(
  state: AccountTokenUsageState | undefined,
  _family: string,
  tokens: number,
  now: number = Date.now(),
): AccountTokenUsageState {
  const currentState: AccountTokenUsageState = state ? { ...state } : {};

  const fifteenMinSlot = Math.floor(now / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const fiveHourBuckets = pruneBuckets(currentState.fiveHourBuckets || [], FIVE_HOURS_MS, now);
  const existing15mSlot = fiveHourBuckets.find((b) => b.timestamp === fifteenMinSlot);
  if (existing15mSlot) {
    existing15mSlot.tokens += tokens;
  } else {
    fiveHourBuckets.push({ timestamp: fifteenMinSlot, tokens });
  }
  currentState.fiveHourBuckets = fiveHourBuckets;

  const oneDaySlot = Math.floor(now / ONE_DAY_MS) * ONE_DAY_MS;
  const weeklyBuckets = pruneBuckets(currentState.weeklyBuckets || [], SEVEN_DAYS_MS, now);
  const existing1dSlot = weeklyBuckets.find((b) => b.timestamp === oneDaySlot);
  if (existing1dSlot) {
    existing1dSlot.tokens += tokens;
  } else {
    weeklyBuckets.push({ timestamp: oneDaySlot, tokens });
  }
  currentState.weeklyBuckets = weeklyBuckets;

  return currentState;
}

export function getRollingTokenUsage(
  state: AccountTokenUsageState | undefined,
  _family: string,
  windowMs: number,
  now: number = Date.now(),
): number {
  if (!state) return 0;
  const buckets = windowMs <= FIVE_HOURS_MS ? state.fiveHourBuckets : state.weeklyBuckets;
  if (!buckets || buckets.length === 0) return 0;

  const slotSpan = windowMs <= FIVE_HOURS_MS ? FIFTEEN_MINUTES_MS : ONE_DAY_MS;
  const windowStart = now - windowMs;

  let totalTokens = 0;
  for (const bucket of buckets) {
    const bucketStart = bucket.timestamp;
    const bucketEnd = bucketStart + slotSpan;
    if (bucketEnd <= windowStart || bucketStart >= now) {
      continue;
    }
    if (bucketStart >= windowStart) {
      totalTokens += bucket.tokens;
    } else {
      const overlapMs = bucketEnd - windowStart;
      const ratio = Math.max(0, Math.min(1, overlapMs / slotSpan));
      totalTokens += Math.floor(bucket.tokens * ratio);
    }
  }

  return totalTokens;
}

export function migrateV3ToV4(v3: AccountStorageV3): AccountStorageV4 {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      ...acc,
      fingerprint: undefined,
      fingerprintHistory: undefined,
    })),
    activeIndex: v3.activeIndex,
    activeIndexByFamily: v3.activeIndexByFamily,
  };
}

export async function loadAccounts(): Promise<AccountStorageV4 | null> {
  try {
    const path = getStoragePath();
    // Ensure permissions are correct on load (fixes existing files)
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }

    let storage: AccountStorageV4;

    if (data.version === 1) {
      log.info("Migrating account storage from v1 to v4");
      const v2 = migrateV1ToV2(data);
      const v3 = migrateV2ToV3(v2);
      storage = migrateV3ToV4(v3);
      try {
        await saveAccounts(storage);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    } else if (data.version === 2) {
      log.info("Migrating account storage from v2 to v4");
      const v3 = migrateV2ToV3(data);
      storage = migrateV3ToV4(v3);
      try {
        await saveAccounts(storage);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    } else if (data.version === 3) {
      log.info("Migrating account storage from v3 to v4");
      storage = migrateV3ToV4(data);
      try {
        await saveAccounts(storage);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    } else if (data.version === 4) {
      storage = data;
    } else {
      log.warn("Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return null;
    }

    // Validate accounts have required fields
    const validAccounts = storage.accounts.filter(
      (a): a is AccountMetadataV3 => {
        return (
          !!a &&
          typeof a === "object" &&
          typeof (a as AccountMetadataV3).refreshToken === "string"
        );
      },
    );

    // Deduplicate accounts by email (keeps newest entry for each email)
    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);

    // Clamp activeIndex to valid range after deduplication
    let activeIndex =
      typeof storage.activeIndex === "number" &&
      Number.isFinite(storage.activeIndex)
        ? storage.activeIndex
        : 0;
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
      activeIndex = Math.max(activeIndex, 0);
    } else {
      activeIndex = 0;
    }

    return {
      version: 4,
      accounts: deduplicatedAccounts,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

export async function saveAccounts(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = existing ? mergeAccountStorage(existing, storage) : storage;

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      // Clean up temp file on failure to prevent accumulation
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors (file may not exist)
      }
      throw error;
    }
  });
}

/**
 * Save accounts storage by replacing the entire file (no merge).
 * Use this for destructive operations like delete where we need to
 * remove accounts that would otherwise be merged back from existing storage.
 */
export async function saveAccountsReplace(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(storage, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorageV4 | null> {
  try {
    const path = getStoragePath();
    // Ensure permissions are correct on load (fixes existing files)
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    if (parsed.version === 1) {
      return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(parsed)));
    }
    if (parsed.version === 2) {
      return migrateV3ToV4(migrateV2ToV3(parsed));
    }
    if (parsed.version === 3) {
      return migrateV3ToV4(parsed);
    }

    return {
      ...parsed,
      accounts: deduplicateAccountsByEmail(parsed.accounts),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    await fs.unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to clear account storage", { error: String(error) });
    }
  }
}
