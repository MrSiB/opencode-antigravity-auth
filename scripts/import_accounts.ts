#!/usr/bin/env tsx

import { existsSync, copyFileSync, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getStoragePath,
  loadAccounts,
  saveAccountsReplace,
  type AccountMetadataV3,
  type AccountStorageV4,
} from "../src/plugin/storage";

const execFileAsync = promisify(execFile);

interface CLIArgs {
  target: string;
  tag: string;
  remotePath: string;
  dryRun: boolean;
  help: boolean;
}

function printUsage(): void {
  console.log(`Safe Remote Authorization Data Import CLI

Usage:
  npx tsx scripts/import_accounts.ts [options]

Options:
  --target <host-or-file>   Remote SSH target or local file path (default: root@31.76.244.138)
  --tag <name>              Tag name to attach to imported accounts (default: remote-team-31.76.244.138)
  --remote-path <path>      Remote path to accounts JSON file (default: ~/.config/opencode/antigravity-accounts.json)
  --dry-run                 Run validation and preview imports without modifying disk
  -h, --help                Show this help message
`);
}

function parseArgs(args: string[]): CLIArgs {
  let target = "root@31.76.244.138";
  let tag = "remote-team-31.76.244.138";
  let remotePath = "~/.config/opencode/antigravity-accounts.json";
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--target=")) {
      target = arg.slice(9).trim();
    } else if (arg === "--target") {
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        target = args[i + 1]!.trim();
        i++;
      }
    } else if (arg.startsWith("--tag=")) {
      tag = arg.slice(6).trim();
    } else if (arg === "--tag") {
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        tag = args[i + 1]!.trim();
        i++;
      }
    } else if (arg.startsWith("--remote-path=")) {
      remotePath = arg.slice(14).trim();
    } else if (arg === "--remote-path") {
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        remotePath = args[i + 1]!.trim();
        i++;
      }
    }
  }

  return { target, tag, remotePath, dryRun, help };
}

async function fetchAccountsPayload(target: string, remotePath: string): Promise<string> {
  const isLocalFile =
    existsSync(target) ||
    target.endsWith(".json") ||
    target.startsWith("/") ||
    target.startsWith("./") ||
    target.startsWith("../");

  if (isLocalFile) {
    if (!existsSync(target)) {
      throw new Error(`Local file target specified but does not exist: "${target}"`);
    }
    return await fs.readFile(target, "utf-8");
  }

  // Remote SSH fetch using execFile with array arguments to prevent shell injection
  const { stdout } = await execFileAsync("ssh", [target, `cat ${remotePath}`]);
  return stdout;
}

function parseRawAccounts(payloadStr: string): AccountMetadataV3[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadStr);
  } catch (err) {
    throw new Error(`Failed to parse JSON payload: ${String(err)}`);
  }

  let rawList: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { accounts?: unknown[] }).accounts)
  ) {
    rawList = (parsed as { accounts: unknown[] }).accounts;
  } else {
    throw new Error("Invalid storage structure: JSON is neither an array nor an object with an 'accounts' array.");
  }

  return rawList.filter(
    (item): item is AccountMetadataV3 =>
      !!item &&
      typeof item === "object" &&
      typeof (item as AccountMetadataV3).refreshToken === "string" &&
      (item as AccountMetadataV3).refreshToken.trim().length > 0
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { target, tag, remotePath, dryRun, help } = parseArgs(args);

  if (help) {
    printUsage();
    process.exit(0);
  }

  const payloadStr = await fetchAccountsPayload(target, remotePath);
  const incomingAccounts = parseRawAccounts(payloadStr);

  const existingStorage = (await loadAccounts()) || {
    version: 4,
    accounts: [],
    activeIndex: 0,
  };
  const existingAccounts = existingStorage.accounts || [];

  const existingEmails = new Set<string>();
  const existingTokens = new Set<string>();

  for (const acc of existingAccounts) {
    if (acc.email) {
      existingEmails.add(acc.email.toLowerCase().trim());
    }
    if (acc.refreshToken) {
      existingTokens.add(acc.refreshToken.trim());
    }
  }

  const accountsToImport: AccountMetadataV3[] = [];
  let skippedDuplicatesCount = 0;

  const seenEmailsInImport = new Set<string>();
  const seenTokensInImport = new Set<string>();

  for (const rawAcc of incomingAccounts) {
    const emailNorm = rawAcc.email ? rawAcc.email.toLowerCase().trim() : undefined;
    const tokenNorm = rawAcc.refreshToken.trim();

    const isEmailDuplicate = emailNorm
      ? existingEmails.has(emailNorm) || seenEmailsInImport.has(emailNorm)
      : false;
    const isTokenDuplicate =
      existingTokens.has(tokenNorm) || seenTokensInImport.has(tokenNorm);

    if (isEmailDuplicate || isTokenDuplicate) {
      skippedDuplicatesCount++;
      continue;
    }

    if (emailNorm) {
      seenEmailsInImport.add(emailNorm);
    }
    seenTokensInImport.add(tokenNorm);

    const importedAcc: AccountMetadataV3 = {
      ...rawAcc,
      tag,
      refreshToken: tokenNorm,
      addedAt: rawAcc.addedAt || Date.now(),
      lastUsed: rawAcc.lastUsed || 0,
      enabled: rawAcc.enabled !== false,
    };

    accountsToImport.push(importedAcc);
  }

  const storagePath = getStoragePath();

  if (dryRun) {
    console.log(`[DRY RUN] Target: ${target}`);
    console.log(`[DRY RUN] Remote Path: ${remotePath}`);
    console.log(`[DRY RUN] Tag: "${tag}"`);
    if (existsSync(storagePath)) {
      console.log(`[DRY RUN] Local storage exists at: ${storagePath}`);
      console.log(`[DRY RUN] Would create timestamped backup: ${storagePath}.bak.<timestamp>`);
    } else {
      console.log(`[DRY RUN] Local storage does not exist yet. Would create new storage file.`);
    }
    console.log(
      `[DRY RUN] Would import ${accountsToImport.length} account(s) with tag "${tag}" (skipped ${skippedDuplicatesCount} duplicate(s)).`
    );
    if (accountsToImport.length > 0) {
      console.log(`[DRY RUN] Accounts preview:`);
      for (const acc of accountsToImport) {
        const emailStr = acc.email ? acc.email : "(no email)";
        const tokenSnippet = acc.refreshToken.slice(0, 10) + "...";
        console.log(`  - ${emailStr} [tag: ${acc.tag}] (refreshToken: ${tokenSnippet})`);
      }
    }
    return;
  }

  let backupPath: string | null = null;
  if (existsSync(storagePath)) {
    const timestamp = Date.now();
    backupPath = `${storagePath}.bak.${timestamp}`;
    copyFileSync(storagePath, backupPath);
    console.log(`✓ Backup created: ${backupPath}`);
  }

  if (accountsToImport.length > 0) {
    const newAccounts = [...existingAccounts, ...accountsToImport];
    const updatedStorage: AccountStorageV4 = {
      ...existingStorage,
      version: 4,
      accounts: newAccounts,
    };

    await saveAccountsReplace(updatedStorage);
    console.log(
      `✓ Imported ${accountsToImport.length} account(s) with tag "${tag}" (skipped ${skippedDuplicatesCount} duplicate(s))`
    );
  } else {
    console.log(
      `✓ No new accounts imported (skipped ${skippedDuplicatesCount} duplicate(s))`
    );
  }
}

main().catch((err) => {
  console.error("Execution failed:", (err as Error).message || err);
  process.exit(1);
});
