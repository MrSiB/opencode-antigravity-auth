import { readFileSync } from "fs";

const FILE = "/root/.config/opencode/antigravity-accounts.json";

function fmtDuration(ms) {
  if (ms <= 0) return "0m (expired)";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `~${totalMin} мин`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `~${h}ч ${m}м`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `~${d}д ${rh}ч ${m}м`;
}

function fmtISODate(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function main() {
  const data = JSON.parse(readFileSync(FILE, "utf8"));
  const now = Date.now();

  console.log(`\nТекущее время: ${fmtISODate(now)}\n`);

  for (let i = 0; i < data.accounts.length; i++) {
    const acc = data.accounts[i];
    const email = acc.email || `Account ${i + 1}`;
    const rl = acc.rateLimitResetTimes;

    console.log(`${i + 1}. ${email}`);

    if (!rl || Object.keys(rl).length === 0) {
      console.log("   rate limits: none\n");
      continue;
    }

    const entries = Object.entries(rl)
      .filter(([_, ts]) => ts > now)
      .sort((a, b) => a[1] - b[1]);

    if (entries.length === 0) {
      console.log("   rate limits: all expired\n");
      continue;
    }

    for (const [key, ts] of entries) {
      const remaining = ts - now;
      console.log(`   ${key}: ${fmtDuration(remaining)} (until ${fmtISODate(ts)})`);
    }
    console.log();
  }
}

main();
