import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
const testConfigDir = mkdtempSync(join(tmpdir(), "opencode-test-config-"));
process.env.XDG_CONFIG_HOME = testConfigDir;
delete process.env.OPENCODE_CONFIG_DIR;
mkdirSync(join(testConfigDir, "opencode"), { recursive: true });
afterAll(() => {
    try {
        rmSync(testConfigDir, { recursive: true, force: true });
    }
    catch {
        // Ignore cleanup errors
    }
});
//# sourceMappingURL=test-setup.js.map