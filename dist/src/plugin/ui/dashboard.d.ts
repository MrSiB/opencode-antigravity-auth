import type { AccountManager } from "../accounts.js";
/**
 * Mask an email address for privacy display.
 * e.g., user@domain.com -> u***r@d***m
 */
export declare function maskEmail(email: string): string;
export interface AccountStatusItem {
    index: number;
    email: string;
    enabled: boolean;
    tag?: string;
    coolingDownUntil?: number;
    cooldownReason?: string;
    verificationRequired?: boolean;
    lastUsed?: number;
    rateLimitResetTimes?: Record<string, number>;
    cachedQuota?: Record<string, unknown>;
    cachedGeminiCliQuota?: Record<string, unknown>;
    tokenUsage: {
        "5h": {
            claude: number;
            gemini: number;
        };
        "7d": {
            claude: number;
            gemini: number;
        };
    };
    empiricalCapacities: {
        claude?: number;
        gemini?: number;
    };
}
export interface LocalStatusData {
    accountCount: number;
    activeIndices: {
        claude: number | null;
        gemini: number | null;
    };
    accounts: AccountStatusItem[];
    quotaSummaries: Record<string, unknown>;
    tokenUsage: {
        "5h": {
            claude: number;
            gemini: number;
        };
        "7d": {
            claude: number;
            gemini: number;
        };
    };
    empiricalCapacities: {
        claude: Record<number, number | undefined>;
        gemini: Record<number, number | undefined>;
    };
}
/**
 * Build status data object from AccountManager instance.
 */
export declare function buildLocalStatusData(accountManager: AccountManager | null): LocalStatusData;
/**
 * Render single-page HTML application dashboard.
 */
export declare function renderDashboardHtml(statusData: LocalStatusData): string;
//# sourceMappingURL=dashboard.d.ts.map