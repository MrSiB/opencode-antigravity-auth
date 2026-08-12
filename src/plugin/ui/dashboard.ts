import type { AccountManager } from "../accounts.js";
import { getRollingTokenUsage } from "../storage.js";

/**
 * Mask an email address for privacy display.
 * e.g., user@domain.com -> u***r@d***m
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== "string") {
    return "";
  }

  const atIndex = email.indexOf("@");
  if (atIndex === -1) {
    return maskPart(email);
  }

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  return `${maskPart(local)}@${maskPart(domain)}`;
}

function maskPart(part: string): string {
  if (!part) return "";
  if (part.length === 1) return `${part}***`;
  if (part.length === 2) return `${part[0]}***${part[1]}`;
  return `${part[0]}***${part[part.length - 1]}`;
}

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
    "5h": { claude: number; gemini: number };
    "7d": { claude: number; gemini: number };
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
    "5h": { claude: number; gemini: number };
    "7d": { claude: number; gemini: number };
  };
  empiricalCapacities: {
    claude: Record<number, number | undefined>;
    gemini: Record<number, number | undefined>;
  };
}

/**
 * Build status data object from AccountManager instance.
 */
export function buildLocalStatusData(accountManager: AccountManager | null): LocalStatusData {
  if (!accountManager) {
    return {
      accountCount: 0,
      activeIndices: { claude: null, gemini: null },
      accounts: [],
      quotaSummaries: {},
      tokenUsage: {
        "5h": { claude: 0, gemini: 0 },
        "7d": { claude: 0, gemini: 0 },
      },
      empiricalCapacities: { claude: {}, gemini: {} },
    };
  }

  const rawAccounts = accountManager.getAccounts();
  const claudeAccount = accountManager.getCurrentAccountForFamily("claude");
  const geminiAccount = accountManager.getCurrentAccountForFamily("gemini");

  const activeIndices = {
    claude: claudeAccount ? claudeAccount.index : null,
    gemini: geminiAccount ? geminiAccount.index : null,
  };

  let total5hClaude = 0;
  let total5hGemini = 0;
  let total7dClaude = 0;
  let total7dGemini = 0;

  const empiricalCapacitiesClaude: Record<number, number | undefined> = {};
  const empiricalCapacitiesGemini: Record<number, number | undefined> = {};

  const accounts: AccountStatusItem[] = rawAccounts.map((acc) => {
    const masked = maskEmail(acc.email || `account-${acc.index}`);

    const u5hClaude = accountManager.get5HourRollingTokenUsage(acc, "claude");
    const u5hGemini = accountManager.get5HourRollingTokenUsage(acc, "gemini");
    const u7dClaude = getRollingTokenUsage(acc.tokenUsage, "claude", 7 * 24 * 3600 * 1000);
    const u7dGemini = getRollingTokenUsage(acc.tokenUsage, "gemini", 7 * 24 * 3600 * 1000);

    total5hClaude += u5hClaude;
    total5hGemini += u5hGemini;
    total7dClaude += u7dClaude;
    total7dGemini += u7dGemini;

    const capClaude = accountManager.getEmpiricalCapacity(acc, "claude");
    const capGemini = accountManager.getEmpiricalCapacity(acc, "gemini");

    if (capClaude !== undefined) empiricalCapacitiesClaude[acc.index] = capClaude;
    if (capGemini !== undefined) empiricalCapacitiesGemini[acc.index] = capGemini;

    return {
      index: acc.index,
      email: masked,
      enabled: acc.enabled !== false,
      tag: acc.tag,
      coolingDownUntil: acc.coolingDownUntil,
      cooldownReason: acc.cooldownReason,
      verificationRequired: acc.verificationRequired,
      lastUsed: acc.lastUsed,
      rateLimitResetTimes: acc.rateLimitResetTimes as Record<string, number>,
      cachedQuota: acc.cachedQuota as Record<string, unknown> | undefined,
      cachedGeminiCliQuota: acc.cachedGeminiCliQuota as Record<string, unknown> | undefined,
      tokenUsage: {
        "5h": { claude: u5hClaude, gemini: u5hGemini },
        "7d": { claude: u7dClaude, gemini: u7dGemini },
      },
      empiricalCapacities: {
        claude: capClaude,
        gemini: capGemini,
      },
    };
  });

  const quotaSummaries: Record<string, unknown> = {};
  for (const acc of rawAccounts) {
    if (acc.cachedQuota) {
      quotaSummaries[`account_${acc.index}`] = {
        email: maskEmail(acc.email || `account-${acc.index}`),
        quota: acc.cachedQuota,
        updatedAt: acc.cachedQuotaUpdatedAt,
      };
    }
  }

  return {
    accountCount: rawAccounts.length,
    activeIndices,
    accounts,
    quotaSummaries,
    tokenUsage: {
      "5h": { claude: total5hClaude, gemini: total5hGemini },
      "7d": { claude: total7dClaude, gemini: total7dGemini },
    },
    empiricalCapacities: {
      claude: empiricalCapacitiesClaude,
      gemini: empiricalCapacitiesGemini,
    },
  };
}

/**
 * Render single-page HTML application dashboard.
 */
export function renderDashboardHtml(statusData: LocalStatusData): string {
  const jsonStr = JSON.stringify(statusData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --success: #4ade80;
      --warning: #fbbf24;
      --danger: #f87171;
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent);
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.875rem;
      color: var(--text-muted);
      background: rgba(56, 189, 248, 0.1);
      padding: 4px 12px;
      border-radius: 9999px;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--success);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
    }
    .card-title {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text);
    }
    .card-subtext {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text);
    }
    .accounts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }
    .account-card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .account-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .account-email {
      font-weight: 600;
      font-size: 1rem;
    }
    .badge {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
    }
    .badge-success { background: rgba(74, 222, 128, 0.15); color: var(--success); }
    .badge-warning { background: rgba(251, 191, 36, 0.15); color: var(--warning); }
    .badge-danger { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
    .progress-bar-container {
      background: var(--border);
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
      margin-top: 6px;
      margin-bottom: 12px;
    }
    .progress-bar {
      height: 100%;
      background-color: var(--accent);
      border-radius: 4px;
    }
    .meta-item {
      display: flex;
      justify-content: space-between;
      font-size: 0.875rem;
      margin-bottom: 4px;
    }
    .meta-label { color: var(--text-muted); }
    .meta-val { font-weight: 500; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Antigravity Status Dashboard</h1>
    <div class="live-badge">
      <span class="pulse"></span> Live (auto-refresh 10s)
    </div>
  </div>

  <div class="grid" id="summary-cards">
    <!-- Populated by JS -->
  </div>

  <h2 class="section-title">Managed Accounts</h2>
  <div class="accounts-grid" id="accounts-container">
    <!-- Populated by JS -->
  </div>

  <script>
    let statusData = ${jsonStr};

    function render(data) {
      const summaryCards = document.getElementById('summary-cards');
      const accountsContainer = document.getElementById('accounts-container');

      const activeClaude = data.activeIndices.claude !== null ? \`#\${data.activeIndices.claude + 1}\` : 'None';
      const activeGemini = data.activeIndices.gemini !== null ? \`#\${data.activeIndices.gemini + 1}\` : 'None';

      summaryCards.innerHTML = \`
        <div class="card">
          <div class="card-title">Total Accounts</div>
          <div class="card-value">\${data.accountCount}</div>
          <div class="card-subtext">\${data.accounts.filter(a => a.enabled).length} enabled</div>
        </div>
        <div class="card">
          <div class="card-title">Active Accounts</div>
          <div class="card-value">\${activeClaude} / \${activeGemini}</div>
          <div class="card-subtext">Claude / Gemini</div>
        </div>
        <div class="card">
          <div class="card-title">5-Hour Token Usage</div>
          <div class="card-value">\${(data.tokenUsage['5h'].claude + data.tokenUsage['5h'].gemini).toLocaleString()}</div>
          <div class="card-subtext">Claude: \${data.tokenUsage['5h'].claude.toLocaleString()} | Gemini: \${data.tokenUsage['5h'].gemini.toLocaleString()}</div>
        </div>
        <div class="card">
          <div class="card-title">7-Day Token Usage</div>
          <div class="card-value">\${(data.tokenUsage['7d'].claude + data.tokenUsage['7d'].gemini).toLocaleString()}</div>
          <div class="card-subtext">Claude: \${data.tokenUsage['7d'].claude.toLocaleString()} | Gemini: \${data.tokenUsage['7d'].gemini.toLocaleString()}</div>
        </div>
      \`;

      if (!data.accounts || data.accounts.length === 0) {
        accountsContainer.innerHTML = '<div class="card"><div class="card-subtext">No accounts registered.</div></div>';
        return;
      }

      accountsContainer.innerHTML = data.accounts.map(acc => {
        let statusBadge = '<span class="badge badge-success">Active</span>';
        if (!acc.enabled) {
          statusBadge = '<span class="badge badge-danger">Disabled</span>';
        } else if (acc.verificationRequired) {
          statusBadge = '<span class="badge badge-danger">Verification Req</span>';
        } else if (acc.coolingDownUntil && acc.coolingDownUntil > Date.now()) {
          statusBadge = '<span class="badge badge-warning">Cooldown</span>';
        }

        const c5h = acc.tokenUsage['5h'].claude;
        const g5h = acc.tokenUsage['5h'].gemini;

        return \`
          <div class="account-card">
            <div class="account-header">
              <div class="account-email">#\${acc.index + 1} \${acc.email}</div>
              \${statusBadge}
            </div>
            <div class="meta-item">
              <span class="meta-label">5h Usage (Claude/Gemini)</span>
              <span class="meta-val">\${c5h.toLocaleString()} / \${g5h.toLocaleString()}</span>
            </div>
            <div class="progress-bar-container">
              <div class="progress-bar" style="width: \${Math.min(100, Math.max(5, ((c5h + g5h) / 1000000) * 100))}%;"></div>
            </div>
            <div class="meta-item">
              <span class="meta-label">7d Usage (Claude/Gemini)</span>
              <span class="meta-val">\${acc.tokenUsage['7d'].claude.toLocaleString()} / \${acc.tokenUsage['7d'].gemini.toLocaleString()}</span>
            </div>
            \${acc.tag ? \`<div class="meta-item"><span class="meta-label">Tag</span><span class="meta-val">\${acc.tag}</span></div>\` : ''}
          </div>
        \`;
      }).join('');
    }

    render(statusData);

    async function refreshData() {
      try {
        const res = await fetch('/status/data');
        if (res.ok) {
          statusData = await res.json();
          render(statusData);
        }
      } catch (err) {
        console.error('Failed to update status dashboard data:', err);
      }
    }

    setInterval(refreshData, 10000);
  </script>
</body>
</html>`;
}
