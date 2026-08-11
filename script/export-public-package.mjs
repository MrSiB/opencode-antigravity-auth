import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const rootDir = process.cwd();
const publicDir = join(rootDir, "public");

// Execute build before copying
execSync("npm run build", { stdio: "inherit" });

if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

// Read root package.json
const pkgPath = join(rootDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

// Ensure package name is @MrSiB/opencode-antigravity-auth
pkg.name = "@MrSiB/opencode-antigravity-auth";

// Delete postinstall script if present
if (pkg.scripts?.postinstall) {
  delete pkg.scripts.postinstall;
}

// Write public/package.json
const publicPkgPath = join(publicDir, "package.json");
writeFileSync(publicPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// Copy required build output & assets
const itemsToCopy = ["dist", "src", "README.md", "LICENSE", "assets"];

for (const item of itemsToCopy) {
  const srcPath = join(rootDir, item);
  const destPath = join(publicDir, item);
  if (existsSync(srcPath)) {
    cpSync(srcPath, destPath, { recursive: true, force: true });
  }
}

console.log("Successfully exported public package to ./public with name @MrSiB/opencode-antigravity-auth");
