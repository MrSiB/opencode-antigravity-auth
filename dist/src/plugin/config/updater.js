/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json(c) with plugin models.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS } from "./models.js";
import { ANTIGRAVITY_PROVIDER_ID } from "../../constants.js";
// =============================================================================
// Constants
// =============================================================================
const PACKAGE_NAME = "@MrSiB/opencode-antigravity-auth";
const LEGACY_PACKAGE_NAME = "opencode-antigravity-auth";
const PLUGIN_NAME = `${PACKAGE_NAME}@latest`;
const SCHEMA_URL = "https://opencode.ai/config.json";
const CONFIG_JSON_FILENAME = "config.json";
const OPENCODE_JSON_FILENAME = "opencode.json";
const OPENCODE_JSONC_FILENAME = "opencode.jsonc";
function isPluginEntry(entry) {
    return (entry === PACKAGE_NAME ||
        entry.startsWith(`${PACKAGE_NAME}@`) ||
        entry === LEGACY_PACKAGE_NAME ||
        entry.startsWith(`${LEGACY_PACKAGE_NAME}@`) ||
        entry.includes("opencode-antigravity-auth"));
}
function isLegacyPluginEntry(entry) {
    return entry === LEGACY_PACKAGE_NAME || entry.startsWith(`${LEGACY_PACKAGE_NAME}@`);
}
function stripJsonCommentsAndTrailingCommas(json) {
    return json
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, group) => (group ? "" : match))
        .replace(/,(\s*[}\]])/g, "$1");
}
/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir() {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}
/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath() {
    const configDir = getOpencodeConfigDir();
    const configJsonPath = join(configDir, CONFIG_JSON_FILENAME);
    const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
    const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);
    if (existsSync(configJsonPath)) {
        return configJsonPath;
    }
    if (existsSync(jsoncPath)) {
        return jsoncPath;
    }
    if (existsSync(jsonPath)) {
        return jsonPath;
    }
    return jsonPath;
}
/**
 * Get the opencode auth file path.
 */
export function getOpencodeAuthPath() {
    const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(xdgData, "opencode", "auth.json");
}
function syncOpencodeAuth(options = {}) {
    try {
        const authPath = options.authPath ?? getOpencodeAuthPath();
        let authConfig = {};
        if (existsSync(authPath)) {
            try {
                const authContent = readFileSync(authPath, "utf-8");
                authConfig = JSON.parse(stripJsonCommentsAndTrailingCommas(authContent)) ?? {};
            }
            catch {
                authConfig = {};
            }
        }
        if (authConfig.google && typeof authConfig.google === "object") {
            return;
        }
        const defaultAccountsPath = join(getOpencodeConfigDir(), "antigravity-accounts.json");
        const fallbackAccountsPath = options.configPath ? join(dirname(options.configPath), "antigravity-accounts.json") : undefined;
        const accountsPath = options.accountsPath ?? (existsSync(defaultAccountsPath) ? defaultAccountsPath : (fallbackAccountsPath ?? defaultAccountsPath));
        if (!existsSync(accountsPath)) {
            return;
        }
        let accountsData = {};
        try {
            const accountsContent = readFileSync(accountsPath, "utf-8");
            accountsData = JSON.parse(stripJsonCommentsAndTrailingCommas(accountsContent)) ?? {};
        }
        catch {
            return;
        }
        const accounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
        if (accounts.length === 0) {
            return;
        }
        let selectedAccount;
        const activeIndex = typeof accountsData.activeIndex === "number" ? accountsData.activeIndex : -1;
        if (activeIndex >= 0 && activeIndex < accounts.length && accounts[activeIndex]?.refreshToken) {
            selectedAccount = accounts[activeIndex];
        }
        else {
            selectedAccount = accounts.find((acc) => acc && typeof acc.refreshToken === "string" && acc.refreshToken.length > 0);
        }
        if (!selectedAccount || !selectedAccount.refreshToken) {
            return;
        }
        const refreshToken = selectedAccount.refreshToken;
        const projectId = selectedAccount.projectId ?? "";
        const refreshStr = `${refreshToken}|${projectId}`;
        authConfig.google = {
            type: "oauth",
            refresh: refreshStr,
            access: "",
            expires: 0,
        };
        const authDir = dirname(authPath);
        if (!existsSync(authDir)) {
            mkdirSync(authDir, { recursive: true });
        }
        writeFileSync(authPath, JSON.stringify(authConfig, null, 2), "utf-8");
    }
    catch {
        // Ignore error during auth sync to handle unhandled exceptions gracefully
    }
}
// =============================================================================
// Main Function
// =============================================================================
/**
 * Updates the opencode configuration file with plugin models.
 *
 * This function:
 * 1. Reads existing opencode.json/opencode.jsonc (or creates default structure)
 * 2. Replaces `provider.google.models` with plugin models
 * 3. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Non-google provider sections
 * - Other settings within google provider (except models)
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export async function updateOpencodeConfig(options = {}) {
    const configPath = options.configPath ?? getOpencodeConfigPath();
    try {
        syncOpencodeAuth(options);
        let config;
        // Read existing config or create default
        if (existsSync(configPath)) {
            const content = readFileSync(configPath, "utf-8");
            config = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
        }
        else {
            // Create default config structure
            config = {
                $schema: SCHEMA_URL,
                plugin: [],
                provider: {},
            };
        }
        // Ensure $schema is set
        if (!config.$schema) {
            config.$schema = SCHEMA_URL;
        }
        if (!Array.isArray(config.plugin)) {
            config.plugin = [];
        }
        const hasFileSandbox = config.plugin.some((p) => typeof p === "string" && p.startsWith("file:"));
        if (hasFileSandbox) {
            config.plugin = config.plugin.filter((p) => {
                if (typeof p !== "string")
                    return true;
                if (p.startsWith("file:"))
                    return true;
                return !isPluginEntry(p);
            });
        }
        else {
            let foundAntigravity = false;
            config.plugin = config.plugin.filter((p) => {
                if (typeof p !== "string" || !isPluginEntry(p))
                    return true;
                if (!foundAntigravity) {
                    foundAntigravity = true;
                    return true;
                }
                return false;
            });
            const pluginIndex = config.plugin.findIndex(isPluginEntry);
            if (pluginIndex === -1) {
                config.plugin.push(PLUGIN_NAME);
            }
            else {
                const existingPlugin = config.plugin[pluginIndex];
                if (existingPlugin && isLegacyPluginEntry(existingPlugin)) {
                    config.plugin[pluginIndex] = PLUGIN_NAME;
                }
            }
        }
        // Ensure provider.google structure exists
        if (!config.provider) {
            config.provider = {};
        }
        const providerObj = (config.provider[ANTIGRAVITY_PROVIDER_ID] ?? {});
        config.provider[ANTIGRAVITY_PROVIDER_ID] = providerObj;
        providerObj.npm = "@ai-sdk/google";
        providerObj.apiKey = providerObj.apiKey ?? "antigravity-dummy-key";
        const existingOptions = providerObj.options ?? {};
        const sanitizedOptions = { ...existingOptions };
        providerObj.options = {
            ...sanitizedOptions,
            baseURL: "http://127.0.0.1:51128/v1beta",
            apiKey: "antigravity-dummy-key",
        };
        providerObj.options.baseURL = "http://127.0.0.1:51128/v1beta";
        providerObj.models = { ...OPENCODE_MODEL_DEFINITIONS };
        // Ensure config directory exists
        const configDir = dirname(configPath);
        if (!existsSync(configDir)) {
            mkdirSync(configDir, { recursive: true });
        }
        const formattedJson = JSON.stringify(config, null, 2);
        if (existsSync(configPath)) {
            const existingContent = readFileSync(configPath, "utf-8");
            if (existingContent.trim() === formattedJson.trim()) {
                return {
                    success: true,
                    configPath,
                };
            }
        }
        // Write config with proper formatting (2-space indent)
        writeFileSync(configPath, formattedJson, "utf-8");
        return {
            success: true,
            configPath,
        };
    }
    catch (error) {
        return {
            success: false,
            configPath,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=updater.js.map