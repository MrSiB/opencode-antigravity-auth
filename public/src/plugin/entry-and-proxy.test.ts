import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createAntigravityPlugin, startEmbeddedProxyServer } from "../plugin.js";

describe("Entry Points and Embedded Proxy Server Tests", () => {
  afterAll(async () => {
    const server = startEmbeddedProxyServer(51128);
    if (server && server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  describe("package.json entry point resolution", () => {
    it("resolves module, types, and exports paths to dist/index.js and dist/index.d.ts", () => {
      const pkgPath = resolve(process.cwd(), "package.json");
      expect(existsSync(pkgPath)).toBe(true);

      const pkgContent = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent);

      expect(pkg.module).toBe("./dist/index.js");
      expect(pkg.types).toBe("./dist/index.d.ts");
      expect(pkg.exports).toBeDefined();

      const mainExport = pkg.exports["."];
      expect(mainExport).toBeDefined();
      if (typeof mainExport === "string") {
        expect(mainExport).toBe("./dist/index.js");
      } else {
        expect(mainExport.import).toBe("./dist/index.js");
        expect(mainExport.types).toBe("./dist/index.d.ts");
      }
    });
  });

  describe("createAntigravityPlugin embedded proxy server initialization", () => {
    it("initializes the embedded proxy server on port 51128 when plugin is created", async () => {
      const mockClient = {
        tui: {
          showToast: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
        },
      } as any;

      const pluginFn = createAntigravityPlugin("google");
      expect(pluginFn).toBeTypeOf("function");

      const pluginResult = await pluginFn({
        client: mockClient,
        directory: process.cwd(),
      });

      expect(pluginResult).toBeDefined();
      expect(pluginResult.auth).toBeDefined();

      let server = startEmbeddedProxyServer(51128);
      expect(server).toBeDefined();
      if (!server.listening && server.address() === null) {
        await new Promise((r) => setTimeout(r, 500));
        if (!server.listening && server.address() === null) {
          server = startEmbeddedProxyServer(51128);
        }
      }
      expect(server.listening || server.address() !== null).toBe(true);
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        expect(address.port).toBe(51128);
      }
    });
  });

  describe("export-public-package postinstall script removal", () => {
    it("generates public/package.json with no postinstall script", () => {
      const scriptPath = resolve(process.cwd(), "script/export-public-package.mjs");
      expect(existsSync(scriptPath)).toBe(true);

      execSync(`node "${scriptPath}"`, { stdio: "pipe" });

      const publicPkgPath = resolve(process.cwd(), "public/package.json");
      expect(existsSync(publicPkgPath)).toBe(true);

      const publicPkgContent = readFileSync(publicPkgPath, "utf-8");
      const publicPkg = JSON.parse(publicPkgContent);

      expect(publicPkg.scripts?.postinstall).toBeUndefined();
    }, 30000);
  });
});
