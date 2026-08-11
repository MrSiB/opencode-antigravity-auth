import type { Transport } from "./types";
export interface ManagedAgentTransportConfig {
    enabled: boolean;
    api_key: string;
    stream: boolean;
    system_instruction?: string;
    environment?: Record<string, unknown>;
}
export declare function createManagedAgentTransport(config: ManagedAgentTransportConfig): Transport;
//# sourceMappingURL=managed-agent-transport.d.ts.map