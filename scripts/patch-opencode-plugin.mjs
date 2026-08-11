import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const packageRoot = path.resolve(__dirname, "..");

  const possiblePatchPaths = [
    path.resolve(packageRoot, "node_modules/@opencode-ai/plugin/dist/index.js"),
    path.resolve(packageRoot, "../@opencode-ai/plugin/dist/index.js"),
    path.resolve(packageRoot, "../../@opencode-ai/plugin/dist/index.js"),
    path.resolve(packageRoot, "../../../node_modules/@opencode-ai/plugin/dist/index.js"),
  ];

  for (const patchPath of possiblePatchPaths) {
    if (fs.existsSync(patchPath)) {
      try {
        const content = fs.readFileSync(patchPath, "utf8");
        if (content.includes('export * from "./tool";')) {
          fs.writeFileSync(patchPath, content.replace('export * from "./tool";', 'export * from "./tool.js";'));
        }
      } catch {}
    }
  }

  const updaterPathSrc = path.resolve(packageRoot, "dist/src/plugin/config/updater.js");
  const updaterPathRoot = path.resolve(packageRoot, "dist/plugin/config/updater.js");
  const updaterPath = fs.existsSync(updaterPathSrc) ? updaterPathSrc : (fs.existsSync(updaterPathRoot) ? updaterPathRoot : null);

  if (updaterPath) {
    import(updaterPath).then((module) => {
      if (typeof module.updateOpencodeConfig === "function") {
        module.updateOpencodeConfig().catch(() => {});
      }
    }).catch(() => {});
  }
} catch (e) {
  // Ignore error during postinstall to allow git dep preparation to succeed cleanly
}
