import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const patchPath = path.join(pkgRoot, "node_modules/@opencode-ai/plugin/dist/index.js");
if (fs.existsSync(patchPath)) {
  const content = fs.readFileSync(patchPath, "utf8");
  if (content.includes('export * from "./tool";')) {
    fs.writeFileSync(patchPath, content.replace('export * from "./tool";', 'export * from "./tool.js";'));
  }
}

const updaterPath = path.join(pkgRoot, "dist/plugin/config/updater.js");
if (fs.existsSync(updaterPath)) {
  import(updaterPath).then((module) => {
    if (typeof module.updateOpencodeConfig === "function") {
      module.updateOpencodeConfig().catch(() => {});
    }
  }).catch(() => {});
}
