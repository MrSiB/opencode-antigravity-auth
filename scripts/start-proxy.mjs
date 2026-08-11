import { startEmbeddedProxyServer } from "../dist/plugin.js";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 51128;
console.log(`Starting Antigravity OAuth Proxy on port ${port}...`);
startEmbeddedProxyServer(port);
