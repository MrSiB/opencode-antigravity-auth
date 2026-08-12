# Executive Analytics & Dashboard Guide (Analytics Paradise Suite v1.6.0)

This document provides a comprehensive guide to the **Analytics & Status Dashboard** architecture for `@mrsib/opencode-antigravity-auth` and the `llm-api` gateway.

---

## 1. Overview

The Analytics & Status Dashboard suite provides real-time monitoring, multi-account token telemetry, quota accounting, and predictive capacity forecasting for Google Antigravity multi-account pools.

### Features
- **Executive KPI Dashboard**: Glassmorphism dark UI with 5 primary KPI cards.
- **Accurate Token Accounting**: Total consumed tokens (5h / 7d) are guaranteed to equal the sum of tokens across all active accounts ($\sum \text{Tokens}_i$).
- **Theoretical Pool Remaining Capacity**: Exact pool capacity calculation ($C_{\text{capacity}} \times R_{\text{remaining}}$) displayed separately for 5-hour and 7-day windows.
- **Live Per-Bucket Reset Timers**: Real-time countdowns (`HH:MM:SS` for 5h, `Dd, HHh, MMm` for 7d) showing when each quota bucket resets.
- **Predictive Analytics**: Exponential Moving Average (EMA) burn rate (TPM/TPH), Time-to-Exhaustion (TTE countdown), and 30-day budget projections.
- **Visual Analytics**: Interactive 14-day model usage breakdown bar chart and 24-hour burn rate line chart powered by Chart.js.

---

## 2. Dashboard Endpoints

| Environment | URL | Purpose |
| :--- | :--- | :--- |
| **Local Plugin Embedded UI** | `http://127.0.0.1:51128/status` | Embedded local status page served directly by the plugin's local proxy server (`port 51128`). |
| **Remote Executive Dashboard** | `https://llm.wdsa.ru/status/` | Remote web dashboard hosted on the gateway (`llm-api`). |
| **JSON Analytics API** | `https://llm.wdsa.ru/v1/status/data` | Public / authenticated JSON status & telemetry data endpoint. |
| **Telemetry Ingestion API** | `https://llm.wdsa.ru/v1/status/record_usage` | Client usage telemetry receiver endpoint. |
| **Dashboard Authentication** | `https://llm.wdsa.ru/v1/status/auth` | Session authentication endpoint (`STATUS_ADMIN_PASSWORD`). |

---

## 3. Telemetry & Data Flow Architecture

```
+-------------------------------------------------------+
|              OpenCode Antigravity Plugin              |
|   (Non-Blocking Telemetry Queue - MAX_SIZE=1000)      |
+-------------------------------------------------------+
                           |
            POST /v1/status/record_usage
            (Bearer Authorization)
                           |
                           v
+-------------------------------------------------------+
|                    FastAPI Gateway                    |
|                      (`llm-api`)                      |
+-------------------------------------------------------+
                           |
         +-----------------+-----------------+
         |                                   |
         v                                   v
+-----------------------+         +-----------------------+
|  SQLite Time-Series   |         | Google Cloud Code API |
| (`antigravity-        |         | (Quota Refresh Sync   |
|  analytics.db` WAL)   |         |  Once per 60 mins)    |
+-----------------------+         +-----------------------+
         |                                   |
         +-----------------+-----------------+
                           |
                           v
+-------------------------------------------------------+
|              Status & Predictive Engine               |
| (`status_service.py` & `analytics_service.py`)         |
+-------------------------------------------------------+
                           |
                           v
+-------------------------------------------------------+
|              Executive KPI Dashboard                  |
|                (`https://llm.wdsa.ru/status/`)        |
+-------------------------------------------------------+
```

### Telemetry Pipeline
1. **Client Telemetry Buffer**: The plugin (`src/plugin/request.ts`) queues token usage records asynchronously (`reportTokenUsageTelemetry()`) with a 3-second fetch timeout and silent fallback to prevent blocking model responses.
2. **Atomic Persistence**: Records are saved into SQLite database `antigravity-analytics.db` running in WAL mode (`PRAGMA journal_mode=WAL;`).
3. **Quota Synchronization**: Google account quota snapshots are refreshed from Google Cloud Code API no more than once per hour (`quota_refresh_interval_minutes: 60`) to stay within rate limits.

---

## 4. Deploying & Server Configuration

### Prerequisites
- Docker & Docker Compose
- Nginx (for SSL termination & reverse proxying)

### Docker Volume Setup (`docker-compose.yml`)
Ensure the analytics database and accounts config are mounted as persistent volumes:

```yaml
version: '3.8'

services:
  llm-api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: llm-api
    ports:
      - "8009:8009"
    environment:
      - STATUS_ADMIN_PASSWORD=your-secure-password
    volumes:
      - /root/.config/opencode/antigravity-accounts.json:/root/.config/opencode/antigravity-accounts.json:rw
      - /root/.config/opencode/antigravity-usage-stats.json:/root/.config/opencode/antigravity-usage-stats.json:rw
      - /root/.config/opencode/antigravity-analytics.db:/root/.config/opencode/antigravity-analytics.db:rw
      - /usr/local/bin/ag-status:/usr/local/bin/ag-status:ro
    restart: unless-stopped
```

### Nginx Proxy Configuration
To enable no-cache real-time updates and secure SSL access:

```nginx
server {
    server_name llm.wdsa.ru;

    location /status/ {
        proxy_pass http://192.168.55.117:8009/status/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0";
    }

    location /v1/ {
        proxy_pass http://192.168.55.117:8009/v1/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0";
    }
}
```

---

## 5. Verification & Testing

To verify data integrity and service health:

1. **Run Unit & Integration Tests**:
   ```bash
   npm test
   ```
2. **Verify Public Package Build**:
   ```bash
   npm run export:public
   ```
3. **Verify API Endpoint Output**:
   ```bash
   curl -s -X POST https://llm.wdsa.ru/v1/status/auth -H "Content-Type: application/json" -d '{"password":"your-password"}' -c cookies.txt
   curl -s https://llm.wdsa.ru/v1/status/data -b cookies.txt | jq '.total_tokens_5h, .total_tokens_7d'
   ```
