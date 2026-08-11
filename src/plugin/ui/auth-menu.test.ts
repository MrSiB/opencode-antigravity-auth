import { describe, it, expect } from 'vitest';
import { ANSI } from './ansi.js';
import {
  formatProgressBar,
  formatAccountQuota,
  buildAccountMenuChoices,
  getStatusBadge,
  resetAccountCooldowns,
  toggleAccountState,
  clearAccountVerification,
  type AccountInfo,
  type AccountManagerLike,
} from './auth-menu.js';

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return 'unknown';
  return new Date(timestamp).toLocaleDateString();
}

describe('auth-menu helpers', () => {
  describe('formatRelativeTime', () => {
    it('returns "never" for undefined', () => {
      expect(formatRelativeTime(undefined)).toBe('never');
    });

    it('returns "today" for same day', () => {
      expect(formatRelativeTime(Date.now())).toBe('today');
      expect(formatRelativeTime(Date.now() - 1000)).toBe('today');
    });

    it('returns "yesterday" for 1 day ago', () => {
      const yesterday = Date.now() - 86400000;
      expect(formatRelativeTime(yesterday)).toBe('yesterday');
    });

    it('returns "Xd ago" for 2-6 days', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d ago');
      expect(formatRelativeTime(Date.now() - 6 * 86400000)).toBe('6d ago');
    });

    it('returns "Xw ago" for 7-29 days', () => {
      expect(formatRelativeTime(Date.now() - 7 * 86400000)).toBe('1w ago');
      expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w ago');
      expect(formatRelativeTime(Date.now() - 28 * 86400000)).toBe('4w ago');
    });

    it('returns formatted date for 30+ days', () => {
      const oldDate = Date.now() - 60 * 86400000;
      const result = formatRelativeTime(oldDate);
      expect(result).not.toBe('never');
      expect(result).not.toContain('ago');
    });
  });

  describe('formatDate', () => {
    it('returns "unknown" for undefined', () => {
      expect(formatDate(undefined)).toBe('unknown');
    });

    it('returns formatted date for valid timestamp', () => {
      const result = formatDate(Date.now());
      expect(result).not.toBe('unknown');
      expect(typeof result).toBe('string');
    });
  });

  describe('getStatusBadge', () => {
    it('returns green badge for active status', () => {
      const badge = getStatusBadge('active');
      expect(badge).toContain('🟢 [active]');
      expect(badge).toContain(ANSI.green);
    });

    it('returns yellow badge for cooldown status with minutes', () => {
      const badge = getStatusBadge({ index: 0, status: 'cooldown', cooldownMinutes: 5 });
      expect(badge).toContain('🟡 [cooldown 5m]');
      expect(badge).toContain(ANSI.yellow);
    });

    it('returns yellow badge for rate-limited status', () => {
      const badge = getStatusBadge('rate-limited');
      expect(badge).toContain('🟡 [cooldown]');
      expect(badge).toContain(ANSI.yellow);
    });

    it('returns orange badge for verification-required status', () => {
      const badge = getStatusBadge('verification-required');
      expect(badge).toContain('🟠 [needs verification]');
      expect(badge).toContain(ANSI.orange);
    });

    it('returns red badge for disabled status', () => {
      const badge = getStatusBadge('disabled');
      expect(badge).toContain('🔴 [disabled]');
      expect(badge).toContain(ANSI.red);
    });

    it('returns red badge for expired status', () => {
      const badge = getStatusBadge('expired');
      expect(badge).toContain('🔴 [expired]');
      expect(badge).toContain(ANSI.red);
    });

    it('returns empty string for unknown status', () => {
      expect(getStatusBadge('unknown')).toBe('');
      expect(getStatusBadge(undefined)).toBe('');
    });
  });

  describe('formatProgressBar', () => {
    it('formats 100% as 8 filled blocks', () => {
      expect(formatProgressBar(100)).toBe('████████');
    });

    it('formats 50% as 4 filled blocks and 4 empty blocks', () => {
      expect(formatProgressBar(50)).toBe('████░░░░');
    });

    it('formats 0% as 8 empty blocks', () => {
      expect(formatProgressBar(0)).toBe('░░░░░░░░');
    });

    it('formats 75% as 6 filled blocks and 2 empty blocks', () => {
      expect(formatProgressBar(75)).toBe('██████░░');
    });

    it('supports custom width', () => {
      expect(formatProgressBar(50, 4)).toBe('██░░');
    });

    it('clamps values out of range', () => {
      expect(formatProgressBar(150)).toBe('████████');
      expect(formatProgressBar(-20)).toBe('░░░░░░░░');
    });
  });

  describe('formatAccountQuota', () => {
    it('formats Claude and Gemini progress bars when both are provided', () => {
      const account: AccountInfo = {
        index: 0,
        claudeQuota: 100,
        geminiQuota: 50,
      };
      expect(formatAccountQuota(account)).toBe('Claude: ████████ 100% | Gemini: ████░░░░ 50%');
    });

    it('formats single quota when only one is provided', () => {
      const account: AccountInfo = {
        index: 0,
        claudeQuota: 100,
      };
      expect(formatAccountQuota(account)).toBe('Claude: ████████ 100%');
    });

    it('returns empty string when no quota is provided', () => {
      const account: AccountInfo = { index: 0 };
      expect(formatAccountQuota(account)).toBe('');
    });

    it('handles nested quota object', () => {
      const account: AccountInfo = {
        index: 0,
        quota: {
          claude: 75,
          gemini: 25,
        },
      };
      expect(formatAccountQuota(account)).toBe('Claude: ██████░░ 75% | Gemini: ██░░░░░░ 25%');
    });
  });

  describe('buildAccountMenuChoices', () => {
    it('builds account choice labels with quota progress bars', () => {
      const accounts: AccountInfo[] = [
        {
          index: 0,
          email: 'user@example.com',
          claudeQuota: 100,
          geminiQuota: 50,
        },
      ];

      const choices = buildAccountMenuChoices(accounts);
      expect(choices).toHaveLength(1);
      expect(choices[0]!.label).toContain('1. user@example.com');
      expect(choices[0]!.label).toContain('Claude: ████████ 100% | Gemini: ████░░░░ 50%');
    });

    it('builds account choices with ANSI color status badges', () => {
      const accounts: AccountInfo[] = [
        { index: 0, email: 'acc1@example.com', status: 'active' },
        { index: 1, email: 'acc2@example.com', status: 'cooldown', cooldownMinutes: 15 },
        { index: 2, email: 'acc3@example.com', status: 'verification-required' },
        { index: 3, email: 'acc4@example.com', enabled: false },
      ];

      const choices = buildAccountMenuChoices(accounts);
      expect(choices).toHaveLength(4);
      expect(choices[0]!.label).toContain(`${ANSI.green}🟢 [active]${ANSI.reset}`);
      expect(choices[1]!.label).toContain(`${ANSI.yellow}🟡 [cooldown 15m]${ANSI.reset}`);
      expect(choices[2]!.label).toContain(`${ANSI.orange}🟠 [needs verification]${ANSI.reset}`);
      expect(choices[3]!.label).toContain(`${ANSI.red}🔴 [disabled]${ANSI.reset}`);
    });
  });

  describe('quick action shortcuts and account manager wiring', () => {
    it('resetAccountCooldowns clears rate limits, cooldowns, verification, and saves to disk', () => {
      const clearedFamilies: string[] = [];
      const clearedCooldownAccounts: unknown[] = [];
      const clearedVerificationCalls: Array<{ index: unknown; enable: boolean | undefined }> = [];
      let saveRequested = false;

      const mockAccountManager: AccountManagerLike = {
        clearAllRateLimitsForFamily(family) {
          clearedFamilies.push(family);
        },
        getAccounts() {
          return [
            { enabled: true, coolingDownUntil: Date.now() + 10000 },
            { enabled: false, verificationRequired: true },
          ];
        },
        clearAccountCooldown(account) {
          clearedCooldownAccounts.push(account);
        },
        clearAccountVerificationRequired(accountOrIndex, enableAccount) {
          clearedVerificationCalls.push({ index: accountOrIndex, enable: enableAccount });
          return true;
        },
        setAccountEnabled() {
          return true;
        },
        requestSaveToDisk() {
          saveRequested = true;
        },
      };

      resetAccountCooldowns(mockAccountManager);

      expect(clearedFamilies).toEqual(['claude', 'gemini']);
      expect(clearedCooldownAccounts).toHaveLength(2);
      expect(clearedVerificationCalls).toEqual([
        { index: 0, enable: true },
        { index: 1, enable: true },
      ]);
      expect(saveRequested).toBe(true);
    });

    it('toggleAccountState enables disabled accounts and disables enabled accounts', () => {
      const enabledCalls: Array<{ index: number; enabled: boolean }> = [];

      const mockAccountManager: AccountManagerLike = {
        clearAllRateLimitsForFamily() {},
        getAccounts() {
          return [
            { enabled: true },
            { enabled: false },
          ];
        },
        clearAccountCooldown() {},
        clearAccountVerificationRequired() { return true; },
        setAccountEnabled(index, enabled) {
          enabledCalls.push({ index, enabled });
          return true;
        },
        requestSaveToDisk() {},
      };

      const res0 = toggleAccountState(mockAccountManager, 0);
      expect(res0).toBe(true);
      expect(enabledCalls[0]).toEqual({ index: 0, enabled: false });

      const res1 = toggleAccountState(mockAccountManager, 1);
      expect(res1).toBe(true);
      expect(enabledCalls[1]).toEqual({ index: 1, enabled: true });

      const res2 = toggleAccountState(mockAccountManager, 99);
      expect(res2).toBe(false);
    });

    it('clearAccountVerification calls clearAccountVerificationRequired with enableAccount=true', () => {
      const calls: Array<{ index: unknown; enable: boolean | undefined }> = [];

      const mockAccountManager: AccountManagerLike = {
        clearAllRateLimitsForFamily() {},
        getAccounts() { return []; },
        clearAccountCooldown() {},
        clearAccountVerificationRequired(accountOrIndex, enableAccount) {
          calls.push({ index: accountOrIndex, enable: enableAccount });
          return true;
        },
        setAccountEnabled() { return true; },
        requestSaveToDisk() {},
      };

      const res = clearAccountVerification(mockAccountManager, 2);
      expect(res).toBe(true);
      expect(calls).toEqual([{ index: 2, enable: true }]);
    });
  });
});
