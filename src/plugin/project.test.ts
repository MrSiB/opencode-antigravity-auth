import { describe, expect, it, vi, beforeEach } from "vitest";
import { ensureProjectContext, loadManagedProject, onboardManagedProject, invalidateProjectContextCache } from "./project.js";
import type { OAuthAuthDetails } from "./types.js";

describe("Project Management & Onboarding for New Accounts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateProjectContextCache();
  });

  it("extracts existing project ID from loadCodeAssist payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cloudaicompanionProject: { id: "existing-project-123" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const payload = await loadManagedProject("access-token-1");
    expect(payload?.cloudaicompanionProject).toEqual({ id: "existing-project-123" });
  });

  it("onboards new account via onboardUser when no project exists", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        done: true,
        response: {
          cloudaicompanionProject: { id: "newly-provisioned-project-456" },
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const projectId = await onboardManagedProject("access-token-new", "FREE", undefined, 1, 10);
    expect(projectId).toBe("newly-provisioned-project-456");
  });

  it("ensureProjectContext auto-provisions project for brand new account", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("loadCodeAssist")) {
        return {
          ok: true,
          json: async () => ({
            allowedTiers: [{ id: "FREE", isDefault: true }],
          }),
        };
      }
      if (url.includes("onboardUser")) {
        return {
          ok: true,
          json: async () => ({
            done: true,
            response: {
              cloudaicompanionProject: { id: "auto-provisioned-project-789" },
            },
          }),
        };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-token-new-account|",
      access: "access-token-new-account",
    };

    const result = await ensureProjectContext(auth);
    expect(result.effectiveProjectId).toBe("auto-provisioned-project-789");
    expect(result.auth.refresh).toBe("refresh-token-new-account|auto-provisioned-project-789|auto-provisioned-project-789");
  });

  it("dynamically queries Google API when account has 2-part refresh token missing managedProjectId", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cloudaicompanionProject: { id: "dynamically-resolved-gcp-999" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "raw-refresh-token",
      access: "access-token-123",
    };

    const result = await ensureProjectContext(auth);
    expect(mockFetch).toHaveBeenCalled();
    expect(result.effectiveProjectId).toBe("dynamically-resolved-gcp-999");
    expect(result.auth.refresh).toBe("raw-refresh-token|dynamically-resolved-gcp-999|dynamically-resolved-gcp-999");
  });

  it("re-queries Google API after cache invalidation", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          cloudaicompanionProject: { id: `resolved-gcp-${callCount}` },
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-token-requery",
      access: "access-token-123",
    };

    const result1 = await ensureProjectContext(auth);
    expect(result1.effectiveProjectId).toBe("resolved-gcp-1");

    // Invalidate cache
    invalidateProjectContextCache(result1.auth.refresh);

    const authToRequery: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh-token-requery",
      access: "access-token-123",
    };
    const result2 = await ensureProjectContext(authToRequery);
    expect(result2.effectiveProjectId).toBe("resolved-gcp-2");
  });
});
