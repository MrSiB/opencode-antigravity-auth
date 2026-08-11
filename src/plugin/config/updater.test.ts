import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { updateOpencodeConfig, getOpencodeAuthPath } from "./updater.js";
import { OPENCODE_MODEL_DEFINITIONS } from "./models.js";

describe("updateOpencodeConfig", () => {
  let tempDir: string;
  let configPath: string;
  let originalXdgConfigHome: string | undefined;
  let originalXdgDataHome: string | undefined;

  beforeEach(() => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
    configPath = path.join(tempDir, "opencode.json");
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates new config with default structure when file does not exist", async () => {
    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(fs.existsSync(configPath)).toBe(true);

    // Verify written config has correct structure
    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(writtenConfig.plugin).toContain("@mrsib/opencode-antigravity-auth@latest");
    expect(writtenConfig.provider?.google?.models).toBeDefined();
  });

  test("replaces existing antigravity models with plugin models", async () => {
    const existingConfig = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["@mrsib/opencode-antigravity-auth@latest"],
      provider: {
        google: {
          models: {
            "old-model": { name: "Old Model" },
          },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Old model should be replaced
    expect(writtenConfig.provider.google.models["old-model"]).toBeUndefined();
    // New models should be present
    expect(writtenConfig.provider.google.models["antigravity-gemini-3.1-pro"]).toBeDefined();
    expect(writtenConfig.provider.google.models["antigravity-claude-sonnet-4-6"]).toBeDefined();
  });

  test("preserves non-antigravity provider sections", async () => {
    const existingConfig = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["@mrsib/opencode-antigravity-auth@latest"],
      provider: {
        google: {
          models: { "old-model": {} },
        },
        anthropic: {
          apiKey: "secret-key",
          models: { "claude-3": {} },
        },
        openai: {
          models: { "gpt-4": {} },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Non-antigravity providers should be preserved
    expect(writtenConfig.provider.anthropic).toEqual(existingConfig.provider.anthropic);
    expect(writtenConfig.provider.openai).toEqual(existingConfig.provider.openai);
  });

  test("preserves $schema and other top-level config keys", async () => {
    const existingConfig = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["@mrsib/opencode-antigravity-auth@latest", "other-plugin"],
      theme: "dark",
      customSetting: { nested: true },
      provider: {
        google: { models: {} },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(writtenConfig.plugin).toContain("other-plugin");
    expect(writtenConfig.theme).toBe("dark");
    expect(writtenConfig.customSetting).toEqual({ nested: true });
  });

  test("adds plugin to existing plugin array if not present", async () => {
    const existingConfig = {
      plugin: ["other-plugin"],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.plugin).toContain("@mrsib/opencode-antigravity-auth@latest");
    expect(writtenConfig.plugin).toContain("other-plugin");
  });

  test("does not duplicate plugin if already present", async () => {
    const existingConfig = {
      plugin: ["@mrsib/opencode-antigravity-auth@latest", "other-plugin"],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const pluginCount = writtenConfig.plugin.filter(
      (p: string) => p.includes("@mrsib/opencode-antigravity-auth")
    ).length;
    expect(pluginCount).toBe(1);
  });

  test("does not duplicate plugin if different version present", async () => {
    const existingConfig = {
      plugin: ["@mrsib/opencode-antigravity-auth@beta", "other-plugin"],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const pluginCount = writtenConfig.plugin.filter(
      (p: string) => p.includes("@mrsib/opencode-antigravity-auth")
    ).length;
    // Should not add another version if one exists
    expect(pluginCount).toBe(1);
    // Should preserve the existing version
    expect(writtenConfig.plugin).toContain("@mrsib/opencode-antigravity-auth@beta");
  });

  test("migrates legacy package entry to scoped package name", async () => {
    const existingConfig = {
      plugin: ["opencode-antigravity-auth@latest", "other-plugin"],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.plugin).toContain("@mrsib/opencode-antigravity-auth@latest");
    expect(writtenConfig.plugin).toContain("other-plugin");
    expect(writtenConfig.plugin).not.toContain("opencode-antigravity-auth@latest");
  });

  test("writes config with proper JSON formatting (2-space indent)", async () => {
    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenContent = fs.readFileSync(configPath, "utf-8");
    // Should have newlines and 2-space indentation
    expect(writtenContent).toContain("\n");
    expect(writtenContent).toMatch(/^\{\n {2}/);
  });

  test("returns error result on invalid JSON in existing config", async () => {
    fs.writeFileSync(configPath, "{ invalid json }");

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("includes all model definitions from OPENCODE_MODEL_DEFINITIONS", async () => {
    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const models = writtenConfig.provider.google.models;

    // Verify all models from OPENCODE_MODEL_DEFINITIONS are included
    for (const modelKey of Object.keys(OPENCODE_MODEL_DEFINITIONS)) {
      expect(models[modelKey]).toBeDefined();
    }
  });

  test("parses existing jsonc config files with comments and trailing commas", async () => {
    const jsoncPath = path.join(tempDir, "opencode.jsonc");
    const existingJsoncConfig = `{
  // Keep existing plugin
  "plugin": [
    "other-plugin",
  ],
  "provider": {
    "google": {
      "region": "us-central1",
    },
  },
}`;
    fs.writeFileSync(jsoncPath, existingJsoncConfig);

    const result = await updateOpencodeConfig({ configPath: jsoncPath });

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(jsoncPath);

    const writtenConfig = JSON.parse(fs.readFileSync(jsoncPath, "utf-8"));
    expect(writtenConfig.plugin).toContain("other-plugin");
    expect(writtenConfig.plugin).toContain("@mrsib/opencode-antigravity-auth@latest");
    expect(writtenConfig.provider.google.region).toBe("us-central1");
    expect(writtenConfig.provider.google.models["antigravity-gemini-3.1-pro"]).toBeDefined();
  });

  test("prefers existing config.json when using default config path", async () => {
    const opencodeDir = path.join(tempDir, "opencode");
    const configJsonPath = path.join(opencodeDir, "config.json");
    const jsonPath = path.join(opencodeDir, "opencode.json");
    const jsoncPath = path.join(opencodeDir, "opencode.jsonc");

    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(configJsonPath, JSON.stringify({ plugin: ["other-plugin"], provider: {} }, null, 2));
    fs.writeFileSync(jsoncPath, JSON.stringify({ plugin: ["other-plugin"], provider: {} }, null, 2));
    process.env.XDG_CONFIG_HOME = tempDir;

    const result = await updateOpencodeConfig();

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(configJsonPath);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(configJsonPath)).toBe(true);
    expect(fs.existsSync(jsoncPath)).toBe(true);
  });

  test("creates parent directory if it does not exist", async () => {
    const nestedPath = path.join(tempDir, "nested", "dir", "opencode.json");

    const result = await updateOpencodeConfig({ configPath: nestedPath });

    expect(result.success).toBe(true);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  test("adds $schema if missing from existing config", async () => {
    const existingConfig = {
      plugin: ["@mrsib/opencode-antigravity-auth@latest"],
      provider: { google: {} },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.$schema).toBe("https://opencode.ai/config.json");
  });

  test("preserves other antigravity provider settings besides models", async () => {
    const existingConfig = {
      plugin: ["@mrsib/opencode-antigravity-auth@latest"],
      provider: {
        google: {
          apiKey: "test-key",
          models: { "old-model": {} },
          customSetting: true,
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.provider.google.apiKey).toBe("test-key");
    expect(writtenConfig.provider.google.customSetting).toBe(true);
    // But models should be replaced
    expect(writtenConfig.provider.google.models["old-model"]).toBeUndefined();
  });

  test("skips writing to disk if content is identical on subsequent run", async () => {
    const result1 = await updateOpencodeConfig({ configPath });
    expect(result1.success).toBe(true);

    const initialStat = fs.statSync(configPath);

    // Sleep briefly to ensure mtime timestamp resolution difference if written
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result2 = await updateOpencodeConfig({ configPath });
    expect(result2.success).toBe(true);

    const subsequentStat = fs.statSync(configPath);
    expect(subsequentStat.mtimeMs).toBe(initialStat.mtimeMs);
  });

  test("sets port 51128 baseURL and dummy apiKey in provider options", async () => {
    const existingConfig = {
      plugin: ["@mrsib/opencode-antigravity-auth@latest"],
      provider: {
        google: {
          options: {
            customOption: "value",
          },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.provider.google.options.baseURL).toBe("http://127.0.0.1:51128/v1beta");
    expect(writtenConfig.provider.google.options.apiKey).toBe("antigravity-dummy-key");
    expect(writtenConfig.provider.google.options.customOption).toBe("value");
  });

  test("deduplicates package plugin entries if file: plugin sandbox exists", async () => {
    const existingConfig = {
      plugin: [
        "oh-my-openagent",
        "file:/root/plugin-sandbox",
        "@mrsib/opencode-antigravity-auth@latest",
      ],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.plugin).toEqual(["oh-my-openagent", "file:/root/plugin-sandbox"]);
  });

  test("deduplicates duplicate package plugin entries keeping only one when no file: plugin exists", async () => {
    const existingConfig = {
      plugin: [
        "oh-my-openagent",
        "@mrsib/opencode-antigravity-auth@latest",
        "opencode-antigravity-auth",
      ],
      provider: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);

    const writtenConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(writtenConfig.plugin).toEqual(["oh-my-openagent", "@mrsib/opencode-antigravity-auth@latest"]);
  });

  test("getOpencodeAuthPath respects XDG_DATA_HOME when defined", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    expect(getOpencodeAuthPath()).toBe(path.join("/custom/data", "opencode", "auth.json"));
  });

  test("getOpencodeAuthPath defaults to ~/.local/share/opencode/auth.json when XDG_DATA_HOME is un-set", () => {
    delete process.env.XDG_DATA_HOME;
    const expected = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    expect(getOpencodeAuthPath()).toBe(expected);
  });

  test("automatically populates auth.json with active account credentials when auth.json is missing", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const accountsPath = path.join(tempDir, "antigravity-accounts.json");
    const mockAccounts = {
      version: 4,
      activeIndex: 1,
      accounts: [
        { refreshToken: "token_0", projectId: "proj_0" },
        { refreshToken: "token_1", projectId: "proj_1" },
      ],
    };
    fs.writeFileSync(accountsPath, JSON.stringify(mockAccounts));

    const result = await updateOpencodeConfig({ configPath, authPath, accountsPath });
    expect(result.success).toBe(true);
    expect(fs.existsSync(authPath)).toBe(true);

    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(authData.google).toEqual({
      type: "oauth",
      refresh: "token_1|proj_1",
      access: "",
      expires: 0,
    });
  });

  test("falls back to first account with refreshToken if activeIndex is invalid", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const accountsPath = path.join(tempDir, "antigravity-accounts.json");
    const mockAccounts = {
      version: 4,
      activeIndex: 99,
      accounts: [
        { refreshToken: "token_fallback", projectId: "proj_fallback" },
      ],
    };
    fs.writeFileSync(accountsPath, JSON.stringify(mockAccounts));

    const result = await updateOpencodeConfig({ configPath, authPath, accountsPath });
    expect(result.success).toBe(true);

    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(authData.google).toEqual({
      type: "oauth",
      refresh: "token_fallback|proj_fallback",
      access: "",
      expires: 0,
    });
  });

  test("preserves existing auth.json entries including existing google entry", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const accountsPath = path.join(tempDir, "antigravity-accounts.json");
    const existingAuth = {
      google: {
        type: "oauth",
        refresh: "existing_token|existing_proj",
        access: "active_access",
        expires: 1000,
      },
      github: { type: "token", token: "gh_secret" },
    };
    fs.writeFileSync(authPath, JSON.stringify(existingAuth));
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ refreshToken: "new_token", projectId: "new_proj" }] })
    );

    const result = await updateOpencodeConfig({ configPath, authPath, accountsPath });
    expect(result.success).toBe(true);

    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(authData).toEqual(existingAuth);
  });

  test("preserves other auth providers when populating missing google entry", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const accountsPath = path.join(tempDir, "antigravity-accounts.json");
    const existingAuth = {
      github: { type: "token", token: "gh_secret" },
    };
    fs.writeFileSync(authPath, JSON.stringify(existingAuth));
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ refreshToken: "token_x", projectId: "proj_x" }] })
    );

    const result = await updateOpencodeConfig({ configPath, authPath, accountsPath });
    expect(result.success).toBe(true);

    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(authData.github).toEqual({ type: "token", token: "gh_secret" });
    expect(authData.google).toEqual({
      type: "oauth",
      refresh: "token_x|proj_x",
      access: "",
      expires: 0,
    });
  });

  test("handles unreadable or malformed accounts file gracefully", async () => {
    const authPath = path.join(tempDir, "auth.json");
    const accountsPath = path.join(tempDir, "antigravity-accounts.json");
    fs.writeFileSync(accountsPath, "{ invalid json }");

    const result = await updateOpencodeConfig({ configPath, authPath, accountsPath });
    expect(result.success).toBe(true);
    expect(fs.existsSync(authPath)).toBe(false);
  });
});
