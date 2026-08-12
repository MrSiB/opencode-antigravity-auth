import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { Server as HttpServer } from "node:http";
import { maskEmail, buildLocalStatusData, renderDashboardHtml } from "./dashboard.js";
import { startEmbeddedProxyServer } from "../../plugin.js";

describe("Dashboard Module Tests", () => {
  describe("maskEmail()", () => {
    it("correctly masks standard email addresses", () => {
      expect(maskEmail("user@domain.com")).toBe("u***r@d***m");
      expect(maskEmail("john.doe@example.org")).toBe("j***e@e***g");
    });

    it("handles short username and domain parts", () => {
      expect(maskEmail("a@b.com")).toBe("a***@b***m");
      expect(maskEmail("ab@cd.com")).toBe("a***b@c***m");
    });

    it("handles empty or malformed inputs gracefully", () => {
      expect(maskEmail("")).toBe("");
      expect(maskEmail(null as any)).toBe("");
      expect(maskEmail("no-at-sign")).toBe("n***n");
    });
  });

  describe("buildLocalStatusData()", () => {
    it("returns empty default status when accountManager is null", () => {
      const data = buildLocalStatusData(null);
      expect(data).toEqual({
        accountCount: 0,
        activeIndices: { claude: null, gemini: null },
        accounts: [],
        quotaSummaries: {},
        tokenUsage: {
          "5h": { claude: 0, gemini: 0 },
          "7d": { claude: 0, gemini: 0 },
        },
        empiricalCapacities: { claude: {}, gemini: {} },
      });
    });

    it("builds correct status data from mock AccountManager", () => {
      const mockAccounts = [
        {
          index: 0,
          email: "user1@example.com",
          enabled: true,
          tag: "prod",
          lastUsed: 1000,
          tokenUsage: {},
          rateLimitResetTimes: {},
          cachedQuota: { group: "a" },
          cachedQuotaUpdatedAt: 5000,
        },
        {
          index: 1,
          email: "user2@test.com",
          enabled: false,
          tokenUsage: {},
          rateLimitResetTimes: {},
        },
      ];

      const mockAccountManager: any = {
        getAccounts: () => mockAccounts,
        getCurrentAccountForFamily: (family: string) => (family === "claude" ? mockAccounts[0] : null),
        get5HourRollingTokenUsage: (_acc: any, family: string) => (family === "claude" ? 500 : 200),
        getEmpiricalCapacity: (acc: any, family: string) => (acc.index === 0 && family === "claude" ? 100000 : undefined),
      };

      const data = buildLocalStatusData(mockAccountManager);

      expect(data.accountCount).toBe(2);
      expect(data.activeIndices).toEqual({ claude: 0, gemini: null });
      expect(data.accounts.length).toBe(2);
      expect(data.accounts[0]?.email).toBe("u***1@e***m");
      expect(data.accounts[0]?.tag).toBe("prod");
      expect(data.accounts[1]?.email).toBe("u***2@t***m");
      expect(data.accounts[1]?.enabled).toBe(false);
      expect(data.tokenUsage["5h"]).toEqual({ claude: 1000, gemini: 400 });
      expect(data.empiricalCapacities.claude).toEqual({ 0: 100000 });
      expect(data.quotaSummaries.account_0).toBeDefined();
    });
  });

  describe("renderDashboardHtml()", () => {
    it("renders valid HTML with dark theme styling and auto-refresh script", () => {
      const mockData = buildLocalStatusData(null);
      const html = renderDashboardHtml(mockData);

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Antigravity Status Dashboard");
      expect(html).toContain("/status/data");
      expect(html).toContain("setInterval(refreshData, 10000)");
      expect(html).toContain("Managed Accounts");
    });
  });

  describe("Embedded Server Route Interception", () => {
    const TEST_PORT = 51139;
    let server: HttpServer;

    beforeAll(() => {
      server = startEmbeddedProxyServer(TEST_PORT);
    });

    afterAll(async () => {
      if (server && server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    it("serves HTML dashboard on /status, /status/, /ui, /ui/", async () => {
      const paths = ["/status", "/status/", "/ui", "/ui/"];
      for (const p of paths) {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}${p}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const body = await res.text();
        expect(body).toContain("<!DOCTYPE html>");
        expect(body).toContain("Antigravity Status Dashboard");
      }
    });

    it("serves JSON status data on /status/data and /v1/status/data", async () => {
      const paths = ["/status/data", "/v1/status/data"];
      for (const p of paths) {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}${p}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        const json = await res.json();
        expect(json).toHaveProperty("accountCount");
        expect(json).toHaveProperty("activeIndices");
        expect(json).toHaveProperty("accounts");
        expect(json).toHaveProperty("tokenUsage");
      }
    });
  });
});
