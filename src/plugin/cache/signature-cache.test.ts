import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "path";
import { tmpdir } from "node:os";
import {
  SignatureCache,
  createSignatureCache,
  getConfigDir,
  getCacheFilePath,
  RENAME_MAX_RETRIES,
} from "./signature-cache";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

describe("SignatureCache Resilience and Path Hardening", () => {
  let testDir: string;
  let testCacheFile: string;
  const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
  let activeCache: SignatureCache | null = null;
  let actualFs: typeof import("node:fs");

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
    vi.mocked(fs.mkdirSync).mockImplementation(actualFs.mkdirSync);
    vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync);
    vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    vi.mocked(fs.unlinkSync).mockImplementation(actualFs.unlinkSync);

    testDir = actualFs.mkdtempSync(join(tmpdir(), "sig-cache-test-"));
    testCacheFile = join(testDir, "antigravity-signature-cache.json");
    process.env.OPENCODE_CONFIG_DIR = testDir;
    activeCache = null;
  });

  afterEach(() => {
    if (activeCache) {
      activeCache.shutdown();
      activeCache = null;
    }
    vi.restoreAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    }
    if (actualFs.existsSync(testDir)) {
      actualFs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("getConfigDir and getCacheFilePath", () => {
    it("honors OPENCODE_CONFIG_DIR when set", () => {
      process.env.OPENCODE_CONFIG_DIR = "/custom/opencode/config";
      expect(getConfigDir()).toBe("/custom/opencode/config");
      expect(getCacheFilePath()).toBe("/custom/opencode/config/antigravity-signature-cache.json");
    });

    it("falls back to xdg or default path when OPENCODE_CONFIG_DIR is unset", () => {
      delete process.env.OPENCODE_CONFIG_DIR;
      const expectedDir = getConfigDir();
      expect(expectedDir).toContain("opencode");
      expect(getCacheFilePath()).toBe(join(expectedDir, "antigravity-signature-cache.json"));
    });
  });

  describe("saveToDisk temp file placement", () => {
    it("creates temporary files in dirname(cacheFilePath) and not in tmpdir()", async () => {
      const nestedDir = join(testDir, "nested", "cache-dir");
      const cachePath = join(nestedDir, "custom-cache.json");
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        cachePath,
      );

      const capturedTempPaths: string[] = [];
      vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
        const filePath = String(file);
        if (filePath.endsWith(".tmp")) {
          capturedTempPaths.push(filePath);
        }
        return actualFs.writeFileSync(file, data, options as any);
      });

      activeCache.store("session-1:model-a", "sig-value-1");
      const saved = await activeCache.flush();

      expect(saved).toBe(true);
      expect(capturedTempPaths.length).toBeGreaterThan(0);

      for (const tempPath of capturedTempPaths) {
        expect(dirname(tempPath)).toBe(nestedDir);
        expect(dirname(tempPath)).not.toBe(tmpdir());
      }
    });

    it("ensures destination directory exists before writing", async () => {
      const deeplyNestedDir = join(testDir, "a", "b", "c");
      const cachePath = join(deeplyNestedDir, "sig-cache.json");
      expect(actualFs.existsSync(deeplyNestedDir)).toBe(false);

      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        cachePath,
      );

      activeCache.store("s:m", "sig-123");
      const saved = await activeCache.flush();

      expect(saved).toBe(true);
      expect(actualFs.existsSync(deeplyNestedDir)).toBe(true);
      expect(actualFs.existsSync(cachePath)).toBe(true);
    });
  });

  describe("Atomic write and persistence", () => {
    it("persists entries cleanly and allows reloading from disk", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("session-alpha:gemini", "sig-alpha");
      activeCache.storeThinking(
        "session-beta:claude",
        "Thinking deep thoughts about code",
        "sig-beta",
        ["tool-1", "tool-2"],
      );

      const saved = await activeCache.flush();
      expect(saved).toBe(true);
      expect(actualFs.existsSync(testCacheFile)).toBe(true);

      const raw = actualFs.readFileSync(testCacheFile, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe("1.0");
      expect(parsed.entries["session-alpha:gemini"].value).toBe("sig-alpha");
      expect(parsed.entries["session-beta:claude"].thinkingText).toBe(
        "Thinking deep thoughts about code",
      );

      activeCache.shutdown();
      activeCache = null;

      const secondCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );
      activeCache = secondCache;

      expect(secondCache.retrieve("session-alpha:gemini")).toBe("sig-alpha");
      const thinking = secondCache.retrieveThinking("session-beta:claude");
      expect(thinking?.signature).toBe("sig-beta");
      expect(thinking?.text).toBe("Thinking deep thoughts about code");
      expect(thinking?.toolIds).toEqual(["tool-1", "tool-2"]);
    });
  });

  describe("Transient lock retry behavior", () => {
    it("retries on transient EBUSY and succeeds when rename clears", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("k1", "v1");

      let renameAttempts = 0;
      vi.mocked(fs.renameSync).mockImplementation((oldPath, newPath) => {
        renameAttempts++;
        if (renameAttempts < 3) {
          const err = new Error("Resource busy") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return actualFs.renameSync(oldPath, newPath);
      });

      const saved = await activeCache.flush();

      expect(saved).toBe(true);
      expect(renameAttempts).toBe(3);
      expect(actualFs.existsSync(testCacheFile)).toBe(true);
    });

    it("retries on transient EPERM and succeeds when lock clears", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("k2", "v2");

      let renameAttempts = 0;
      vi.mocked(fs.renameSync).mockImplementation((oldPath, newPath) => {
        renameAttempts++;
        if (renameAttempts < 2) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return actualFs.renameSync(oldPath, newPath);
      });

      const saved = await activeCache.flush();

      expect(saved).toBe(true);
      expect(renameAttempts).toBe(2);
      expect(actualFs.existsSync(testCacheFile)).toBe(true);
    });
  });

  describe("Temporary file cleanup on failure", () => {
    it("cleans up temporary file if writeFileSync throws", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("k-write-fail", "v-fail");

      vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
        const filePath = String(file);
        if (filePath.endsWith(".tmp")) {
          actualFs.appendFileSync(file, "partial");
          throw new Error("Disk full simulation");
        }
        return actualFs.writeFileSync(file, data, options as any);
      });

      const saved = await activeCache.flush();

      expect(saved).toBe(false);

      const files = actualFs.readdirSync(testDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("cleans up temporary file if renameSync throws non-retryable error", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("k-rename-fail", "v-fail");

      let renameAttempts = 0;
      vi.mocked(fs.renameSync).mockImplementation(() => {
        renameAttempts++;
        const err = new Error("Access violation") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      const saved = await activeCache.flush();

      expect(saved).toBe(false);
      expect(renameAttempts).toBe(1);

      const files = actualFs.readdirSync(testDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("cleans up temporary file if renameSync exhausts all retries on EBUSY", async () => {
      activeCache = new SignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );

      activeCache.store("k-exhaust-ebusy", "v-exhaust");

      let renameAttempts = 0;
      vi.mocked(fs.renameSync).mockImplementation(() => {
        renameAttempts++;
        const err = new Error("Permanent busy lock") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });

      const saved = await activeCache.flush();

      expect(saved).toBe(false);
      expect(renameAttempts).toBe(RENAME_MAX_RETRIES + 1);

      const files = actualFs.readdirSync(testDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("createSignatureCache factory", () => {
    it("returns null if disabled or undefined config", () => {
      expect(createSignatureCache(undefined)).toBeNull();
      expect(
        createSignatureCache({
          enabled: false,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        }),
      ).toBeNull();
    });

    it("creates instance if enabled", () => {
      const cache = createSignatureCache(
        {
          enabled: true,
          memory_ttl_seconds: 3600,
          disk_ttl_seconds: 86400,
          write_interval_seconds: 60,
        },
        testCacheFile,
      );
      expect(cache).toBeInstanceOf(SignatureCache);
      cache?.shutdown();
    });
  });
});
