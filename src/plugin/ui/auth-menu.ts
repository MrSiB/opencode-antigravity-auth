import { ANSI } from './ansi.js';
import { select, type MenuItem } from './select.js';
import { confirm } from './confirm.js';

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

export type AuthMenuAction =
  | { type: 'add' }
  | { type: 'select-account'; account: AccountInfo }
  | { type: 'delete-all' }
  | { type: 'check' }
  | { type: 'verify' }
  | { type: 'verify-all' }
  | { type: 'configure-models' }
  | { type: 'reset-cooldowns' }
  | { type: 'toggle-active' }
  | { type: 'toggle-account'; account: AccountInfo }
  | { type: 'cancel' };

export type AccountAction = 'back' | 'delete' | 'refresh' | 'toggle' | 'verify' | 'cancel';

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

export function getStatusBadge(input: AccountInfo | AccountStatus | undefined, cooldownMinutes?: number): string {
  let status: AccountStatus | undefined;
  let cooldownMins: number | undefined = cooldownMinutes;

  if (typeof input === 'object' && input !== null) {
    status = input.status;
    if (cooldownMins === undefined) {
      if (input.cooldownMinutes !== undefined) {
        cooldownMins = input.cooldownMinutes;
      } else if (input.cooldownUntil !== undefined) {
        cooldownMins = Math.max(1, Math.ceil((input.cooldownUntil - Date.now()) / 60000));
      }
    }
  } else {
    status = input;
  }

  switch (status) {
    case 'active':
      return `${ANSI.green}🟢 [active]${ANSI.reset}`;
    case 'cooldown':
      return `${ANSI.yellow}🟡 [cooldown${cooldownMins !== undefined ? ` ${cooldownMins}m` : ''}]${ANSI.reset}`;
    case 'rate-limited':
      return `${ANSI.yellow}🟡 [${cooldownMins !== undefined ? `cooldown ${cooldownMins}m` : 'cooldown'}]${ANSI.reset}`;
    case 'expired':
      return `${ANSI.red}🔴 [expired]${ANSI.reset}`;
    case 'verification-required':
      return `${ANSI.orange}🟠 [needs verification]${ANSI.reset}`;
    case 'disabled':
      return `${ANSI.red}🔴 [disabled]${ANSI.reset}`;
    default:
      return '';
  }
}

export function formatProgressBar(percent: number, width: number = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function formatAccountQuota(account: AccountInfo): string {
  const rawClaude = account.claudeQuota ?? account.quota?.claude ?? account.quota?.claudeQuota;
  const rawGemini = account.geminiQuota ?? account.quota?.gemini ?? account.quota?.geminiQuota;

  const parts: string[] = [];
  if (rawClaude !== undefined) {
    const claudePercent = rawClaude <= 1 && rawClaude > 0 ? rawClaude * 100 : rawClaude;
    parts.push(`Claude: ${formatProgressBar(claudePercent)} ${Math.round(claudePercent)}%`);
  }
  if (rawGemini !== undefined) {
    const geminiPercent = rawGemini <= 1 && rawGemini > 0 ? rawGemini * 100 : rawGemini;
    parts.push(`Gemini: ${formatProgressBar(geminiPercent)} ${Math.round(geminiPercent)}%`);
  }
  return parts.join(' | ');
}

export function buildAccountMenuChoices(accounts: AccountInfo[]): MenuItem<AuthMenuAction>[] {
  return accounts.map(account => {
    const statusBadge = getStatusBadge(account);
    const currentBadge = account.isCurrentAccount ? ` ${ANSI.cyan}[current]${ANSI.reset}` : '';
    const tagBadge = account.tag ? ` ${ANSI.cyan}[${account.tag}]${ANSI.reset}` : '';
    const disabledBadge = (account.enabled === false && account.status !== 'disabled') ? ` ${ANSI.red}🔴 [disabled]${ANSI.reset}` : '';
    const baseLabel = account.email || `Account ${account.index + 1}`;
    const numbered = `${account.index + 1}. ${baseLabel}`;
    const quotaStr = formatAccountQuota(account);
    const quotaBadge = quotaStr ? ` ${quotaStr}` : '';
    const fullLabel = `${numbered}${currentBadge}${tagBadge}${statusBadge ? ' ' + statusBadge : ''}${disabledBadge}${quotaBadge}`;

    return {
      label: fullLabel,
      hint: account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : '',
      value: { type: 'select-account' as const, account },
    };
  });
}

export async function showAuthMenu(accounts: AccountInfo[]): Promise<AuthMenuAction> {
  const items: MenuItem<AuthMenuAction>[] = [
    { label: 'Actions', value: { type: 'cancel' }, kind: 'heading' },
    { label: '[+] Add Google Account', value: { type: 'add' }, color: 'cyan' },
    { label: '[R] Reset Rate-Limit Cooldowns', value: { type: 'reset-cooldowns' }, color: 'cyan' },
    { label: '[D] Toggle Account Active State', value: { type: 'toggle-active' }, color: 'cyan' },
    { label: 'Check quotas', value: { type: 'check' }, color: 'cyan' },
    { label: 'Verify one account', value: { type: 'verify' }, color: 'cyan' },
    { label: 'Verify all accounts', value: { type: 'verify-all' }, color: 'cyan' },
    { label: 'Configure models in opencode.json', value: { type: 'configure-models' }, color: 'cyan' },

    { label: '', value: { type: 'cancel' }, separator: true },

    { label: 'Accounts', value: { type: 'cancel' }, kind: 'heading' },

    ...buildAccountMenuChoices(accounts),

    { label: '', value: { type: 'cancel' }, separator: true },

    { label: 'Danger zone', value: { type: 'cancel' }, kind: 'heading' },
    { label: 'Delete all accounts', value: { type: 'delete-all' }, color: 'red' as const },
  ];

  while (true) {
    const result = await select(items, { 
      message: 'Google accounts (Antigravity)',
      subtitle: 'Select an action or account',
      clearScreen: true,
    });

    if (!result) return { type: 'cancel' };

    if (result.type === 'delete-all') {
      const confirmed = await confirm('Delete ALL accounts? This cannot be undone.');
      if (!confirmed) continue;
    }

    if (result.type === 'toggle-active') {
      const selectedAccount = await showToggleAccountMenu(accounts);
      if (!selectedAccount) continue;
      return { type: 'toggle-account', account: selectedAccount };
    }

    return result;
  }
}

export async function showToggleAccountMenu(accounts: AccountInfo[]): Promise<AccountInfo | null> {
  if (accounts.length === 0) return null;

  const items: MenuItem<AccountInfo | null>[] = [
    { label: 'Back', value: null },
    ...accounts.map(account => {
      const isEnabled = account.enabled !== false;
      const statusBadge = isEnabled ? `${ANSI.green}[enabled]${ANSI.reset}` : `${ANSI.red}[disabled]${ANSI.reset}`;
      const baseLabel = account.email || `Account ${account.index + 1}`;
      return {
        label: `${account.index + 1}. ${baseLabel} ${statusBadge}`,
        value: account,
      };
    }),
  ];

  return await select(items, {
    message: 'Toggle Account Active State',
    subtitle: 'Select an account to enable or disable',
    clearScreen: true,
  });
}

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

export function resetAccountCooldowns(accountManager: AccountManagerLike): void {
  accountManager.clearAllRateLimitsForFamily('claude');
  accountManager.clearAllRateLimitsForFamily('gemini');
  const accounts = accountManager.getAccounts();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc) {
      accountManager.clearAccountCooldown(acc);
      accountManager.clearAccountVerificationRequired(i, true);
    }
  }
  accountManager.requestSaveToDisk();
}

export function toggleAccountState(accountManager: AccountManagerLike, accountIndex: number): boolean {
  const accounts = accountManager.getAccounts();
  const acc = accounts[accountIndex];
  if (!acc) return false;
  const newEnabled = acc.enabled === false ? true : false;
  return accountManager.setAccountEnabled(accountIndex, newEnabled);
}

export function clearAccountVerification(accountManager: AccountManagerLike, accountIndex: number): boolean {
  return accountManager.clearAccountVerificationRequired(accountIndex, true);
}

export async function showAccountDetails(account: AccountInfo): Promise<AccountAction> {
  const label = account.email || `Account ${account.index + 1}`;
  const badge = getStatusBadge(account);
  const tagBadge = account.tag ? ` ${ANSI.cyan}[${account.tag}]${ANSI.reset}` : '';
  const disabledBadge = (account.enabled === false && account.status !== 'disabled') ? ` ${ANSI.red}🔴 [disabled]${ANSI.reset}` : '';
  const header = `${label}${tagBadge}${badge ? ' ' + badge : ''}${disabledBadge}`;
  const subtitleParts = [
    `Added: ${formatDate(account.addedAt)}`,
    `Last used: ${formatRelativeTime(account.lastUsed)}`,
  ];

  while (true) {
    const result = await select([
      { label: 'Back', value: 'back' as const },
      { label: 'Verify account access', value: 'verify' as const, color: 'cyan' },
      { label: account.enabled === false ? 'Enable account' : 'Disable account', value: 'toggle' as const, color: account.enabled === false ? 'green' : 'yellow' },
      { label: 'Refresh token', value: 'refresh' as const, color: 'cyan' },
      { label: 'Delete this account', value: 'delete' as const, color: 'red' },
    ], { 
      message: header,
      subtitle: subtitleParts.join(' | '),
      clearScreen: true,
    });

    if (result === 'delete') {
      const confirmed = await confirm(`Delete ${label}?`);
      if (!confirmed) continue;
    }

    if (result === 'refresh') {
      const confirmed = await confirm(`Re-authenticate ${label}?`);
      if (!confirmed) continue;
    }

    return result ?? 'cancel';
  }
}

export { isTTY } from './ansi.js';
