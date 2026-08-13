import fs from "node:fs";
import path from "node:path";

function fixImportsInFile(filePath) {
  let code = fs.readFileSync(filePath, "utf8");
  const fileDir = path.dirname(filePath);

  // Replace relative imports without extensions: from "./foo" or from "../foo/bar"
  code = code.replace(/((?:from|import)\s+["'])(\.[^"'\r\n]+)(["'])/g, (match, p1, p2, p3) => {
    if (p2.endsWith(".js") || p2.endsWith(".json")) return match;

    const targetJs = path.resolve(fileDir, `${p2}.js`);
    if (fs.existsSync(targetJs) && fs.statSync(targetJs).isFile()) {
      return `${p1}${p2}.js${p3}`;
    }

    const resolvedPath = path.resolve(fileDir, p2);
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      if (fs.existsSync(path.join(resolvedPath, "index.js"))) {
        return `${p1}${p2}/index.js${p3}`;
      }
    }

    return `${p1}${p2}.js${p3}`;
  });

  fs.writeFileSync(filePath, code, "utf8");
}

function processDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(full);
    } else if (entry.name.endsWith(".js")) {
      fixImportsInFile(full);
    }
  }
}

processDir("./dist");
console.log("Fixed all relative import extensions in dist/");
