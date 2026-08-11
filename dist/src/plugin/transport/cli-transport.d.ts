import type { Transport } from "./types";
export interface CliTransportConfig {
    enabled: boolean;
    binary?: string;
    print_timeout_seconds: number;
    process_timeout_seconds: number;
    log_file?: string;
    sandbox?: boolean;
    dangerously_skip_permissions: boolean;
}
export declare function createCliTransport(config: CliTransportConfig): Transport;
//# sourceMappingURL=cli-transport.d.ts.map