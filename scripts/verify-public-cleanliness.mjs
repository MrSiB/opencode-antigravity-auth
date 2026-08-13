import { execSync } from "node:child_process";

const FORBIDDEN_PATTERNS = [
  /\.backup\//i,
  /\.codegraph/i,
  /^AGENTS\.md$/i,
  /AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /INCIDENT_/i,
  /RESTORE_/i,
  /fix_opencode_auth_incident\.py/i,
  /scripts\/import_friend_accounts\.ts/i,
  /scripts\/setup-.*\.sh/i,
  /scripts\/auth-pi-tools\.sh/i,
  /scripts\/restore\.sh/i,
];

function checkFiles(files, contextName) {
  const violations = [];
  for (const file of files) {
    if (!file.trim()) continue;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(file)) {
        violations.push({ file, pattern: pattern.toString() });
        break;
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ [GUARDRAIL ERROR] Forbidden internal/system files detected in ${contextName}:`);
    for (const v of violations) {
      console.error(`  - ${v.file} (matched: ${v.pattern})`);
    }
    console.error("\n🚫 Commit/Push BLOCKED. Only public release files are permitted.\n");
    process.exit(1);
  }
}

try {
  const stagedOutput = execSync("git diff --cached --name-only", { encoding: "utf8" });
  const stagedFiles = stagedOutput.split("\n").filter(Boolean);
  checkFiles(stagedFiles, "Git Staged Index");

  console.log("✅ [GUARDRAIL CHECK PASSED] No internal/system files in git index.");
} catch (err) {
  if (err.status !== undefined && err.status !== 0) {
    process.exit(err.status);
  }
  console.error("Failed to execute git check:", err);
  process.exit(1);
}
