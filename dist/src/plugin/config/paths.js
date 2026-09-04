import { join } from "path";
import { homedir } from "os";
export function getCanonicalConfigDir() {
    if (process.env.OPENCODE_CONFIG_DIR) {
        return process.env.OPENCODE_CONFIG_DIR;
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}
//# sourceMappingURL=paths.js.map