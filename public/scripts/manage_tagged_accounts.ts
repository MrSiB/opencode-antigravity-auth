#!/usr/bin/env tsx

import { existsSync, copyFileSync } from "node:fs";
import { getStoragePath } from "../src/plugin/storage";
import { AccountManager } from "../src/plugin/accounts";

function printUsage(): void {
  console.log(`Emergency Killswitch & Bulk Tag Management CLI

Usage:
  npx tsx scripts/manage_tagged_accounts.ts <command> [options]

Commands:
  disable --tag <name>  Disable all accounts matching the specified tag
  enable --tag <name>   Enable all accounts matching the specified tag
  delete --tag <name>   Permanently delete all accounts matching the specified tag
  list [--tag <name>]   List all accounts or accounts matching the specified tag

Options:
  --tag <name>          Tag name to match accounts
  -h, --help            Show this help message
`);
}

function parseArgs(args: string[]): {
  command?: string;
  tag?: string;
  help: boolean;
} {
  let command: string | undefined;
  let tag: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg.startsWith("--tag=")) {
      tag = arg.slice(6).trim();
    } else if (arg === "--tag") {
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        tag = args[i + 1]!.trim();
        i++;
      } else {
        tag = "";
      }
    } else if (!arg.startsWith("-") && !command) {
      command = arg.toLowerCase();
    }
  }

  return { command, tag, help };
}

function backupStorage(): string | null {
  const storagePath = getStoragePath();
  if (existsSync(storagePath)) {
    const timestamp = Date.now();
    const backupPath = `${storagePath}.bak.${timestamp}`;
    copyFileSync(storagePath, backupPath);
    console.log(`✓ Created backup: ${backupPath}`);
    return backupPath;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, tag, help } = parseArgs(args);

  if (help || !command) {
    printUsage();
    if (!help && !command) {
      process.exit(1);
    }
    process.exit(0);
  }

  switch (command) {
    case "list": {
      const manager = await AccountManager.loadFromDisk();
      const allAccounts = manager.getAccounts();
      const targetAccounts = tag
        ? allAccounts.filter((a) => a.tag === tag)
        : allAccounts;

      if (targetAccounts.length === 0) {
        if (tag) {
          console.log(`No accounts found matching tag "${tag}".`);
        } else {
          console.log("No accounts found.");
        }
      } else {
        const header = tag
          ? `Accounts matching tag "${tag}" (${targetAccounts.length}):`
          : `Accounts (${targetAccounts.length}):`;
        console.log(header);
        for (const account of targetAccounts) {
          const emailStr = account.email ? account.email : "(no email)";
          const statusStr = account.enabled !== false ? "enabled" : "disabled";
          const tagStr = account.tag ? `[tag: ${account.tag}]` : "[untagged]";
          console.log(`  [${account.index}] ${emailStr} (${statusStr}) ${tagStr}`);
        }
      }
      break;
    }

    case "disable": {
      if (!tag) {
        console.error('Error: --tag <name> is required for "disable"');
        printUsage();
        process.exit(1);
      }
      backupStorage();
      const manager = await AccountManager.loadFromDisk();
      const matchingAccounts = manager.getAccountsByTag(tag);
      const count = matchingAccounts.length;
      manager.setTagEnabled(tag, false);
      await manager.saveToDisk();
      console.log(`✓ Disabled ${count} accounts matching tag "${tag}"`);
      break;
    }

    case "enable": {
      if (!tag) {
        console.error('Error: --tag <name> is required for "enable"');
        printUsage();
        process.exit(1);
      }
      backupStorage();
      const manager = await AccountManager.loadFromDisk();
      const matchingAccounts = manager.getAccountsByTag(tag);
      const count = matchingAccounts.length;
      manager.setTagEnabled(tag, true);
      await manager.saveToDisk();
      console.log(`✓ Enabled ${count} accounts matching tag "${tag}"`);
      break;
    }

    case "delete": {
      if (!tag) {
        console.error('Error: --tag <name> is required for "delete"');
        printUsage();
        process.exit(1);
      }
      backupStorage();
      const manager = await AccountManager.loadFromDisk();
      const removedCount = manager.removeAccountsByTag(tag);
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log(`✓ Deleted ${removedCount} accounts matching tag "${tag}"`);
      break;
    }

    default: {
      console.error(`Error: Unknown command "${command}"`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
