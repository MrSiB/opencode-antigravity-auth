/**
 * Account Rotation System
 * 
 * Implements advanced account selection algorithms:
 * - Health Score: Track account wellness based on success/failure
 * - LRU Selection: Prefer accounts with longest rest periods
 * - Jitter: Add random variance to break predictable patterns
 * 
 * Used by 'hybrid' strategy for improved ban prevention and load distribution.
 */

// ============================================================================
// HEALTH SCORE SYSTEM
// ============================================================================

export interface HealthScoreConfig {
  /** Initial score for new accounts (default: 70) */
  initial: number;
  /** Points added on successful request (default: 1) */
  successReward: number;
  /** Points removed on rate limit (default: -10) */
  rateLimitPenalty: number;
  /** Points removed on failure (auth, network, etc.) (default: -20) */
  failurePenalty: number;
  /** Points recovered per hour of rest (default: 2) */
  recoveryRatePerHour: number;
  /** Minimum score to be considered usable (default: 50) */
  minUsable: number;
  /** Maximum score cap (default: 100) */
  maxScore: number;
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  initial: 70,
  successReward: 1,
  rateLimitPenalty: -10,
  failurePenalty: -20,
  recoveryRatePerHour: 2,
  minUsable: 50,
  maxScore: 100,
};

interface HealthScoreState {
  score: number;
  lastUpdated: number;
  lastSuccess: number;
  consecutiveFailures: number;
}

/**
 * Recompute a numeric account index after the account at `removedIndex` has been
 * spliced out and subsequent indices renumbered down by one (see
 * AccountManager.removeAccount). Returns null when the entry belonged to the
 * removed account and should therefore be dropped.
 */
function remapAccountIndexAfterRemoval(index: number, removedIndex: number): number | null {
  if (index === removedIndex) return null;
  return index > removedIndex ? index - 1 : index;
}

/**
 * Rebuild a number-keyed Map in place after an account removal: drop the removed
 * index's entry and shift higher indices down by one, so entries keep referring
 * to the same accounts once the account list is renumbered.
 */
function remapNumberKeyedMap<V>(map: Map<number, V>, removedIndex: number): void {
  const entries = [...map.entries()];
  map.clear();
  for (const [index, value] of entries) {
    const next = remapAccountIndexAfterRemoval(index, removedIndex);
    if (next !== null) {
      map.set(next, value);
    }
  }
}

/**
 * Tracks health scores for accounts.
 * Higher score = healthier account = preferred for selection.
 */
export class HealthScoreTracker {
  private readonly scores = new Map<number, HealthScoreState>();
  private readonly config: HealthScoreConfig;

  constructor(config: Partial<HealthScoreConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config };
  }

  /**
   * Get current health score for an account, applying time-based recovery.
   */
  getScore(accountIndex: number): number {
    const state = this.scores.get(accountIndex);
    if (!state) {
      return this.config.initial;
    }

    // Apply passive recovery based on time since last update
    const now = Date.now();
    const hoursSinceUpdate = Math.max(0, (now - state.lastUpdated) / (1000 * 60 * 60));
    const recoveredPoints = Math.floor(hoursSinceUpdate * this.config.recoveryRatePerHour);
    
    return Math.min(
      this.config.maxScore,
      state.score + recoveredPoints
    );
  }

  /**
   * Record a successful request - improves health score.
   */
  recordSuccess(accountIndex: number): void {
    const now = Date.now();
    const current = this.getScore(accountIndex);
    
    this.scores.set(accountIndex, {
      score: Math.min(this.config.maxScore, current + this.config.successReward),
      lastUpdated: now,
      lastSuccess: now,
      consecutiveFailures: 0,
    });
  }

  /**
   * Record a rate limit hit - moderate penalty.
   */
  recordRateLimit(accountIndex: number): void {
    const now = Date.now();
    const state = this.scores.get(accountIndex);
    const current = this.getScore(accountIndex);
    
    this.scores.set(accountIndex, {
      score: Math.max(0, current + this.config.rateLimitPenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  /**
   * Record a failure (auth, network, etc.) - larger penalty.
   */
  recordFailure(accountIndex: number): void {
    const now = Date.now();
    const state = this.scores.get(accountIndex);
    const current = this.getScore(accountIndex);
    
    this.scores.set(accountIndex, {
      score: Math.max(0, current + this.config.failurePenalty),
      lastUpdated: now,
      lastSuccess: state?.lastSuccess ?? 0,
      consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
    });
  }

  /**
   * Check if account is healthy enough to use.
   */
  isUsable(accountIndex: number): boolean {
    return this.getScore(accountIndex) >= this.config.minUsable;
  }

  /**
   * Get consecutive failure count for an account.
   */
  getConsecutiveFailures(accountIndex: number): number {
    return this.scores.get(accountIndex)?.consecutiveFailures ?? 0;
  }

  /**
   * Reset health state for an account (e.g., after removal).
   */
  reset(accountIndex: number): void {
    this.scores.delete(accountIndex);
  }

  /**
   * Remap health-score state after the account at `removedIndex` is removed from
   * the pool. AccountManager.removeAccount() splices the account out and
   * renumbers every subsequent account's index down by one; without this remap
   * the index-keyed scores silently attach to the wrong accounts.
   */
  remapAfterRemoval(removedIndex: number): void {
    remapNumberKeyedMap(this.scores, removedIndex);
  }

  /**
   * Get all scores for debugging/logging.
   */
  getSnapshot(): Map<number, { score: number; consecutiveFailures: number }> {
    const result = new Map<number, { score: number; consecutiveFailures: number }>();
    for (const [index] of this.scores) {
      result.set(index, {
        score: this.getScore(index),
        consecutiveFailures: this.getConsecutiveFailures(index),
      });
    }
    return result;
  }
}

// ============================================================================
// HYBRID SELECTION
// ============================================================================

export interface AccountQuotaMetrics {
  weeklyRemaining?: number;
  weeklyResetTime?: number;
  fiveHourRemaining?: number;
  fiveHourResetTime?: number;
}

export interface AccountWithMetrics {
  index: number;
  lastUsed: number;
  healthScore: number;
  isRateLimited: boolean;
  isCoolingDown: boolean;
  quota?: AccountQuotaMetrics;
}

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const FIVE_HOUR_MS = 5 * 3600 * 1000;

export function selectHybridAccount(
  accounts: AccountWithMetrics[],
  tokenTracker?: TokenBucketTracker | null,
  currentAccountIndex: number | null = null,
  minHealthScore: number = 50,
): number | null {
  const now = Date.now();
  const candidates = accounts
    .filter(acc => {
      if (acc.isRateLimited || acc.isCoolingDown) return false;
      if (acc.healthScore < minHealthScore) return false;

      if (acc.quota) {
        if (typeof acc.quota.weeklyRemaining === "number" && acc.quota.weeklyRemaining <= 0) {
          const resetTime = acc.quota.weeklyResetTime ?? 0;
          if (resetTime > now) return false;
        }
        if (typeof acc.quota.fiveHourRemaining === "number" && acc.quota.fiveHourRemaining <= 0) {
          const resetTime = acc.quota.fiveHourResetTime ?? 0;
          if (resetTime > now) return false;
        }
      } else if (tokenTracker && accounts.every(a => !a.quota)) {
        if (!tokenTracker.hasTokens(acc.index)) return false;
      }

      return true;
    })
    .map(acc => ({
      ...acc,
      tokens: tokenTracker?.getTokens(acc.index) ?? 50
    }));

  if (candidates.length === 0) {
    return null;
  }

  const maxTokens = tokenTracker?.getMaxTokens() ?? 50;
  const scored = candidates
    .map(acc => {
      const baseScore = calculateHybridScore(acc, maxTokens);
      const stickinessBonus = acc.index === currentAccountIndex ? STICKINESS_BONUS : 0;
      return {
        index: acc.index,
        baseScore,
        score: baseScore + stickinessBonus,
        isCurrent: acc.index === currentAccountIndex
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) {
    return null;
  }

  const currentCandidate = scored.find(s => s.isCurrent);
  if (currentCandidate && !best.isCurrent) {
    const advantage = best.baseScore - currentCandidate.baseScore;
    if (advantage < SWITCH_THRESHOLD) {
      return currentCandidate.index;
    }
  }

  return best.index;
}

export interface AccountWithTokens extends AccountWithMetrics {
  tokens?: number;
}

export function calculateHybridScore(
  account: AccountWithTokens,
  maxTokens: number = 50
): number {
  const safeMaxTokens = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 50;
  const healthScore = Number.isFinite(account?.healthScore) ? account.healthScore : 0;
  const lastUsed = Number.isFinite(account?.lastUsed) ? account.lastUsed : 0;

  const healthComponent = healthScore * 2;
  const secondsSinceUsed = Math.max(0, Date.now() - lastUsed) / 1000;
  const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;

  let quotaComponent = 0;

  if (account.quota) {
    const now = Date.now();
    const wRem = Number.isFinite(account.quota.weeklyRemaining) ? Math.max(0, Math.min(1, account.quota.weeklyRemaining!)) : 1.0;
    const fRem = Number.isFinite(account.quota.fiveHourRemaining) ? Math.max(0, Math.min(1, account.quota.fiveHourRemaining!)) : 1.0;

    const baseQuota = (wRem * 100) + (fRem * 80);

    let weeklyUrgencyBonus = 0;
    if (account.quota.weeklyResetTime && account.quota.weeklyResetTime > now) {
      const weeklyTimeLeft = account.quota.weeklyResetTime - now;
      const progress = Math.max(0, Math.min(1, 1 - weeklyTimeLeft / WEEK_MS));
      const urgencyFactor = Math.pow(progress, 2.5);
      weeklyUrgencyBonus = wRem * urgencyFactor * 350;
    } else if (account.quota.weeklyResetTime && account.quota.weeklyResetTime <= now) {
      weeklyUrgencyBonus = wRem * 350;
    }

    let fiveHourUrgencyBonus = 0;
    if (account.quota.fiveHourResetTime && account.quota.fiveHourResetTime > now) {
      const fiveHourTimeLeft = account.quota.fiveHourResetTime - now;
      const progress5h = Math.max(0, Math.min(1, 1 - fiveHourTimeLeft / FIVE_HOUR_MS));
      const urgencyFactor5h = Math.pow(progress5h, 2.0);
      fiveHourUrgencyBonus = fRem * urgencyFactor5h * 100;
    } else if (account.quota.fiveHourResetTime && account.quota.fiveHourResetTime <= now) {
      fiveHourUrgencyBonus = fRem * 100;
    }

    quotaComponent = baseQuota + weeklyUrgencyBonus + fiveHourUrgencyBonus;
  } else if (typeof account.tokens === "number" && Number.isFinite(account.tokens)) {
    quotaComponent = (account.tokens / safeMaxTokens) * 100 * 5;
  } else {
    quotaComponent = 200;
  }

  const total = healthComponent + quotaComponent + freshnessComponent;
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}

// ============================================================================
// TOKEN BUCKET SYSTEM
// ============================================================================

export interface TokenBucketConfig {
  /** Maximum tokens per account (default: 50) */
  maxTokens: number;
  /** Tokens regenerated per minute (default: 6) */
  regenerationRatePerMinute: number;
  /** Initial tokens for new accounts (default: 50) */
  initialTokens: number;
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
  maxTokens: 50,
  regenerationRatePerMinute: 6,
  initialTokens: 50,
};

interface TokenBucketState {
  tokens: number;
  lastUpdated: number;
}

/**
 * Client-side rate limiting using Token Bucket algorithm.
 * Helps prevent hitting server 429s by tracking "cost" of requests.
 */
export class TokenBucketTracker {
  private readonly buckets = new Map<number, TokenBucketState>();
  private readonly config: TokenBucketConfig;

  constructor(config: Partial<TokenBucketConfig> = {}) {
    this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
  }

  /**
   * Get current token balance for an account, applying regeneration.
   */
  getTokens(accountIndex: number): number {
    const state = this.buckets.get(accountIndex);
    if (!state) {
      return this.config.initialTokens;
    }

    const now = Date.now();
    const minutesSinceUpdate = Math.max(0, (now - state.lastUpdated) / (1000 * 60));
    const recoveredTokens = minutesSinceUpdate * this.config.regenerationRatePerMinute;
    
    return Math.min(
      this.config.maxTokens,
      state.tokens + recoveredTokens
    );
  }

  /**
   * Check if account has enough tokens for a request.
   * @param cost Cost of the request (default: 1)
   */
  hasTokens(accountIndex: number, cost: number = 1): boolean {
    return this.getTokens(accountIndex) >= cost;
  }

  /**
   * Consume tokens for a request.
   * @returns true if tokens were consumed, false if insufficient
   */
  consume(accountIndex: number, cost: number = 1): boolean {
    const current = this.getTokens(accountIndex);
    if (current < cost) {
      return false;
    }

    this.buckets.set(accountIndex, {
      tokens: current - cost,
      lastUpdated: Date.now(),
    });
    return true;
  }

  /**
   * Refund tokens (e.g., if request wasn't actually sent).
   */
  refund(accountIndex: number, amount: number = 1): void {
    const current = this.getTokens(accountIndex);
    this.buckets.set(accountIndex, {
      tokens: Math.min(this.config.maxTokens, current + amount),
      lastUpdated: Date.now(),
    });
  }

  getMaxTokens(): number {
    return this.config.maxTokens;
  }

  /**
   * Remap token-bucket state after the account at `removedIndex` is removed from
   * the pool. Mirrors the renumbering AccountManager.removeAccount() applies, so
   * the index-keyed buckets stay attached to the correct accounts.
   */
  remapAfterRemoval(removedIndex: number): void {
    remapNumberKeyedMap(this.buckets, removedIndex);
  }
}

// ============================================================================
// SINGLETON TRACKERS
// ============================================================================

let globalTokenTracker: TokenBucketTracker | null = null;

export function getTokenTracker(): TokenBucketTracker {
  if (!globalTokenTracker) {
    globalTokenTracker = new TokenBucketTracker();
  }
  return globalTokenTracker;
}

export function initTokenTracker(config: Partial<TokenBucketConfig>): TokenBucketTracker {
  globalTokenTracker = new TokenBucketTracker(config);
  return globalTokenTracker;
}

let globalHealthTracker: HealthScoreTracker | null = null;

/**
 * Get the global health score tracker instance.
 * Creates one with default config if not initialized.
 */
export function getHealthTracker(): HealthScoreTracker {
  if (!globalHealthTracker) {
    globalHealthTracker = new HealthScoreTracker();
  }
  return globalHealthTracker;
}

/**
 * Initialize the global health tracker with custom config.
 * Call this at plugin startup if custom config is needed.
 */
export function initHealthTracker(config: Partial<HealthScoreConfig>): HealthScoreTracker {
  globalHealthTracker = new HealthScoreTracker(config);
  return globalHealthTracker;
}
