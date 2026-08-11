import fs from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const rootDir = process.cwd();
const publicDir = join(rootDir, "public");

// Execute build before copying
execSync("npm run build", { stdio: "inherit" });

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Read root package.json
const pkgPath = join(rootDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

// Ensure package name is @mrsib/opencode-antigravity-auth
pkg.name = "@mrsib/opencode-antigravity-auth";

// Delete scripts and devDependencies entirely
delete pkg.scripts;
delete pkg.devDependencies;

// Write public/package.json
const publicPkgPath = join(publicDir, "package.json");
fs.writeFileSync(publicPkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

// Copy required build output & assets
const itemsToCopy = ["dist", "src", "README.md", "LICENSE", "assets"];

for (const item of itemsToCopy) {
  const srcPath = join(rootDir, item);
  const destPath = join(publicDir, item);
  if (fs.existsSync(srcPath)) {
    fs.cpSync(srcPath, destPath, { recursive: true, force: true });
  }
}

console.log("Successfully exported public package to ./public with name @mrsib/opencode-antigravity-auth");
