import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "./accounts.js";
import type { AccountMetadataV3, AccountStorageV4 } from "./storage.js";
import { generateFingerprint } from "./fingerprint.js";

vi.mock("./storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage")>();
  return {
    ...original,
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    saveAccountsReplace: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Tag Management, Authorization Persistence, and Emergency Killswitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("Full Authorization Metadata Persistence across saveToDisk()", () => {
    it("preserves refreshToken, projectId, managedProjectId, email, fingerprint, and tag without data loss", async () => {
      const { saveAccounts } = await import("./storage");

      const mockFingerprint = generateFingerprint();
      mockFingerprint.deviceId = "device-uuid-1234";

      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "rt_full_payload_secret",
            projectId: "my-cloud-project-1",
            managedProjectId: "managed-proj-abc",
            email: "user.auth@example.com",
            tag: "remote-team-31.76.244.138",
            fingerprint: mockFingerprint,
            addedAt: 1700000000000,
            lastUsed: 1700000500000,
            enabled: true,
            rateLimitResetTimes: { claude: 1700001000000 },
          },
          {
            refreshToken: "rt_untagged_secret",
            projectId: "proj-2",
            email: "untagged@example.com",
            addedAt: 1700000000000,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      await manager.saveToDisk();

      expect(saveAccounts).toHaveBeenCalledTimes(1);
      const savedPayload = vi.mocked(saveAccounts).mock.calls[0]![0] as AccountStorageV4;

      expect(savedPayload.version).toBe(4);
      expect(savedPayload.accounts).toHaveLength(2);

      const acc1 = savedPayload.accounts[0]!;
      expect(acc1.refreshToken).toBe("rt_full_payload_secret");
      expect(acc1.projectId).toBe("my-cloud-project-1");
      expect(acc1.managedProjectId).toBe("managed-proj-abc");
      expect(acc1.email).toBe("user.auth@example.com");
      expect(acc1.tag).toBe("remote-team-31.76.244.138");
      expect(acc1.fingerprint).toEqual(mockFingerprint);
      expect(acc1.rateLimitResetTimes).toEqual({ claude: 1700001000000 });

      const acc2 = savedPayload.accounts[1]!;
      expect(acc2.refreshToken).toBe("rt_untagged_secret");
      expect(acc2.projectId).toBe("proj-2");
      expect(acc2.email).toBe("untagged@example.com");
      expect(acc2.tag).toBeUndefined();
      expect(acc2).not.toHaveProperty("tag");
    });
  });

  describe("removeAccountsByTag and Bulk Deletion", () => {
    it("calls saveAccountsReplace (NOT saveAccounts) and deletes matching tagged accounts", async () => {
      const { saveAccounts, saveAccountsReplace } = await import("./storage");

      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", projectId: "p1", email: "a1@test.com", tag: "kill-me", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", projectId: "p2", email: "a2@test.com", tag: "keep-me", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r3", projectId: "p3", email: "a3@test.com", tag: "kill-me", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const removedCount = manager.removeAccountsByTag("kill-me");

      expect(removedCount).toBe(2);
      expect(manager.getTotalAccountCount()).toBe(1);

      expect(saveAccounts).not.toHaveBeenCalled();
      expect(saveAccountsReplace).toHaveBeenCalledTimes(1);

      const replacedStorage = vi.mocked(saveAccountsReplace).mock.calls[0]![0] as AccountStorageV4;
      expect(replacedStorage.accounts).toHaveLength(1);
      expect(replacedStorage.accounts[0]!.refreshToken).toBe("r2");
      expect(replacedStorage.accounts[0]!.email).toBe("a2@test.com");
      expect(replacedStorage.accounts[0]!.tag).toBe("keep-me");
    });

    it("correctly updates account indices (0..N-1) without orphan references", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r0", tag: "drop", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r1", tag: "keep", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", tag: "drop", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r3", tag: "keep", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r4", tag: "drop", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      manager.removeAccountsByTag("drop");

      const remaining = manager.getAccounts();
      expect(remaining).toHaveLength(2);
      expect(remaining[0]!.parts.refreshToken).toBe("r1");
      expect(remaining[0]!.index).toBe(0);
      expect(remaining[1]!.parts.refreshToken).toBe("r3");
      expect(remaining[1]!.index).toBe(1);
    });

    it("updates family active indices when active account is removed", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r0", tag: "active-tag", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r1", tag: "other-tag", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
        activeIndexByFamily: {
          claude: 0,
          gemini: 0,
        },
      };

      const manager = new AccountManager(undefined, stored);
      expect(manager.getCurrentAccountForFamily("claude")?.parts.refreshToken).toBe("r0");

      manager.removeAccountsByTag("active-tag");

      expect(manager.getTotalAccountCount()).toBe(1);
      const activeClaude = manager.getCurrentAccountForFamily("claude");
      expect(activeClaude?.parts.refreshToken).toBe("r1");
      expect(activeClaude?.index).toBe(0);
    });

    it("handles removing non-existent tag gracefully without triggering disk save", async () => {
      const { saveAccountsReplace } = await import("./storage");

      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", tag: "existing-tag", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const count = manager.removeAccountsByTag("non-existent");

      expect(count).toBe(0);
      expect(manager.getTotalAccountCount()).toBe(1);
      expect(saveAccountsReplace).not.toHaveBeenCalled();
    });

    it("resets cursor and family indices to -1 when all accounts are removed", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", tag: "killswitch", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", tag: "killswitch", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 1,
      };

      const manager = new AccountManager(undefined, stored);
      const count = manager.removeAccountsByTag("killswitch");

      expect(count).toBe(2);
      expect(manager.getTotalAccountCount()).toBe(0);
      expect(manager.getCurrentAccountForFamily("claude")).toBeNull();
      expect(manager.getCurrentAccountForFamily("gemini")).toBeNull();
    });
  });

  describe("CLI Emergency Killswitch and Tag Management", () => {
    it("setTagEnabled(tag, false) disables tagged accounts and shifts family indices", async () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", tag: "bad-host", enabled: true, addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", tag: "good-host", enabled: true, addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      expect(manager.getCurrentAccountForFamily("claude")?.parts.refreshToken).toBe("r1");

      const disabledCount = manager.setTagEnabled("bad-host", false);

      expect(disabledCount).toBe(1);
      const accounts = manager.getAccounts();
      expect(accounts[0]!.enabled).toBe(false);
      expect(accounts[1]!.enabled).toBe(true);

      expect(manager.getCurrentAccountForFamily("claude")?.parts.refreshToken).toBe("r2");
    });

    it("setTagEnabled(tag, true) re-enables disabled accounts", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", tag: "temp-disabled", enabled: false, addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      expect(manager.getEnabledAccounts()).toHaveLength(0);

      const enabledCount = manager.setTagEnabled("temp-disabled", true);

      expect(enabledCount).toBe(1);
      expect(manager.getEnabledAccounts()).toHaveLength(1);
      expect(manager.getAccounts()[0]!.enabled).toBe(true);
    });

    it("getAccountsByTag returns exact match subset", () => {
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          { refreshToken: "r1", tag: "tag-x", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r2", tag: "tag-y", addedAt: 1, lastUsed: 0 },
          { refreshToken: "r3", tag: "tag-x", addedAt: 1, lastUsed: 0 },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const tagXAccounts = manager.getAccountsByTag("tag-x");

      expect(tagXAccounts).toHaveLength(2);
      expect(tagXAccounts.map((a) => a.parts.refreshToken)).toEqual(["r1", "r3"]);
    });
  });

  describe("Remote Account Import Deduplication and Tagging Logic", () => {
    it("deduplicates incoming accounts on email and refreshToken while preserving full authorization payload", () => {
      const existing: AccountMetadataV3[] = [
        {
          refreshToken: "token-exist-1",
          email: "exist@example.com",
          projectId: "proj-1",
          managedProjectId: "mproj-1",
          tag: "local-orig",
          addedAt: 1,
          lastUsed: 0,
        },
      ];

      const fp = generateFingerprint();

      const incoming: AccountMetadataV3[] = [
        {
          refreshToken: "token-exist-1",
          email: "new1@example.com",
          projectId: "proj-incoming-1",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "token-new-2",
          email: "EXIST@EXAMPLE.COM",
          projectId: "proj-incoming-2",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "token-new-3",
          email: "unique@example.com",
          projectId: "proj-incoming-3",
          managedProjectId: "mproj-incoming-3",
          fingerprint: fp,
          addedAt: 1,
          lastUsed: 0,
        },
        {
          refreshToken: "token-new-3",
          email: "dup-token@example.com",
          projectId: "proj-incoming-4",
          addedAt: 1,
          lastUsed: 0,
        },
      ];

      const existingEmails = new Set<string>();
      const existingTokens = new Set<string>();
      for (const acc of existing) {
        if (acc.email) existingEmails.add(acc.email.toLowerCase().trim());
        if (acc.refreshToken) existingTokens.add(acc.refreshToken.trim());
      }

      const imported: AccountMetadataV3[] = [];
      let skippedCount = 0;
      const seenEmails = new Set<string>();
      const seenTokens = new Set<string>();

      for (const rawAcc of incoming) {
        const emailNorm = rawAcc.email ? rawAcc.email.toLowerCase().trim() : undefined;
        const tokenNorm = rawAcc.refreshToken.trim();

        const isEmailDuplicate = emailNorm ? existingEmails.has(emailNorm) || seenEmails.has(emailNorm) : false;
        const isTokenDuplicate = existingTokens.has(tokenNorm) || seenTokens.has(tokenNorm);

        if (isEmailDuplicate || isTokenDuplicate) {
          skippedCount++;
          continue;
        }

        if (emailNorm) seenEmails.add(emailNorm);
        seenTokens.add(tokenNorm);

        imported.push({
          ...rawAcc,
          tag: "remote-team-host",
          refreshToken: tokenNorm,
          addedAt: rawAcc.addedAt || Date.now(),
          lastUsed: rawAcc.lastUsed || 0,
          enabled: rawAcc.enabled !== false,
        });
      }

      expect(skippedCount).toBe(3);
      expect(imported).toHaveLength(1);

      const acc = imported[0]!;
      expect(acc.refreshToken).toBe("token-new-3");
      expect(acc.email).toBe("unique@example.com");
      expect(acc.projectId).toBe("proj-incoming-3");
      expect(acc.managedProjectId).toBe("mproj-incoming-3");
      expect(acc.fingerprint).toEqual(fp);
      expect(acc.tag).toBe("remote-team-host");
    });
  });
});
