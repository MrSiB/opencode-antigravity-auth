import { type MenuItem } from './select.js';
export type AccountStatus = 'active' | 'rate-limited' | 'cooldown' | 'expired' | 'verification-required' | 'disabled' | 'unknown';
export interface AccountInfo {
    email?: string;
    tag?: string;
    index: number;
    addedAt?: number;
    lastUsed?: number;
    status?: AccountStatus;
    isCurrentAccount?: boolean;
    enabled?: boolean;
    cooldownMinutes?: number;
    cooldownUntil?: number;
    claudeQuota?: number;
    geminiQuota?: number;
    quota?: {
        claude?: number;
        gemini?: number;
        claudeQuota?: number;
        geminiQuota?: number;
    };
}
export type AuthMenuAction = {
    type: 'add';
} | {
    type: 'select-account';
    account: AccountInfo;
} | {
    type: 'delete-all';
} | {
    type: 'check';
} | {
    type: 'verify';
} | {
    type: 'verify-all';
} | {
    type: 'configure-models';
} | {
    type: 'reset-cooldowns';
} | {
    type: 'toggle-active';
} | {
    type: 'toggle-account';
    account: AccountInfo;
} | {
    type: 'cancel';
};
export type AccountAction = 'back' | 'delete' | 'refresh' | 'toggle' | 'verify' | 'cancel';
export declare function getStatusBadge(input: AccountInfo | AccountStatus | undefined, cooldownMinutes?: number): string;
export declare function formatProgressBar(percent: number, width?: number): string;
export declare function formatAccountQuota(account: AccountInfo): string;
export declare function buildAccountMenuChoices(accounts: AccountInfo[]): MenuItem<AuthMenuAction>[];
export declare function showAuthMenu(accounts: AccountInfo[]): Promise<AuthMenuAction>;
export declare function showToggleAccountMenu(accounts: AccountInfo[]): Promise<AccountInfo | null>;
export interface AccountManagerLike {
    clearAllRateLimitsForFamily(family: 'claude' | 'gemini'): void;
    getAccounts(): Array<{
        enabled?: boolean;
        coolingDownUntil?: number;
        cooldownReason?: unknown;
        verificationRequired?: boolean;
        rateLimitResetTimes?: Record<string, number>;
    }>;
    clearAccountCooldown(account: unknown): void;
    clearAccountVerificationRequired(accountOrIndex: unknown, enableAccount?: boolean): boolean;
    setAccountEnabled(accountIndex: number, enabled: boolean): boolean;
    requestSaveToDisk(): void;
}
export declare function resetAccountCooldowns(accountManager: AccountManagerLike): void;
export declare function toggleAccountState(accountManager: AccountManagerLike, accountIndex: number): boolean;
export declare function clearAccountVerification(accountManager: AccountManagerLike, accountIndex: number): boolean;
export declare function showAccountDetails(account: AccountInfo): Promise<AccountAction>;
export { isTTY } from './ansi.js';
//# sourceMappingURL=auth-menu.d.ts.map