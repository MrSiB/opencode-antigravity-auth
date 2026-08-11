import { beforeEach, describe, expect, it, vi } from "vitest";

import { isOAuthAuth, parseRefreshParts, formatRefreshParts, accessTokenExpired, fetchProjectID } from "./auth.js";
import { exchangeAntigravity } from "../antigravity/oauth.js";
import type { OAuthAuthDetails, ApiKeyAuthDetails } from "./types.js";

describe("isOAuthAuth", () => {
  it("returns true for oauth auth type", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token|project",
      access: "access-token",
      expires: Date.now() + 3600000,
    };
    expect(isOAuthAuth(auth)).toBe(true);
  });

  it("returns false for api_key auth type", () => {
    const auth: ApiKeyAuthDetails = {
      type: "api_key",
      key: "some-api-key",
    };
    expect(isOAuthAuth(auth)).toBe(false);
  });
});

describe("parseRefreshParts", () => {
  it("parses refresh token with all parts", () => {
    const result = parseRefreshParts("refreshToken|projectId|managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
    });
  });

  it("parses refresh token with only refresh and project", () => {
    const result = parseRefreshParts("refreshToken|projectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "projectId",
    });
  });

  it("parses refresh token with trailing pipe and sets managedProjectId to projectId", () => {
    const result = parseRefreshParts("refreshToken|projectId|");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "projectId",
    });
  });

  it("parses refresh token with only refresh token", () => {
    const result = parseRefreshParts("refreshToken");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });

  it("handles empty string", () => {
    const result = parseRefreshParts("");
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });

  it("handles empty parts", () => {
    const result = parseRefreshParts("refreshToken||managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: "managedProjectId",
    });
  });

  it("handles undefined/null-like input", () => {
    // @ts-expect-error - testing edge case
    const result = parseRefreshParts(undefined);
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });
});

describe("formatRefreshParts", () => {
  it("formats all parts", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken|projectId|managedProjectId");
  });

  it("formats without managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
    });
    expect(result).toBe("refreshToken|projectId");
  });

  it("formats without project id but with managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken||managedProjectId");
  });

  it("formats with only refresh token", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
    });
    expect(result).toBe("refreshToken|");
  });

  it("round-trips correctly with parseRefreshParts", () => {
    const original = {
      refreshToken: "rt123",
      projectId: "proj456",
      managedProjectId: "managed789",
    };
    const formatted = formatRefreshParts(original);
    const parsed = parseRefreshParts(formatted);
    expect(parsed).toEqual(original);
  });
});

describe("accessTokenExpired", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true when access token is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: undefined,
      expires: Date.now() + 3600000,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when expires is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: undefined,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token is expired", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() - 1000, // expired 1 second ago
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token expires within buffer period (60 seconds)", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 30000, // expires in 30 seconds (within 60s buffer)
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns false when token is valid and outside buffer period", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 120000, // expires in 2 minutes
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });

  it("returns false when token expires exactly at buffer boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: 60001, // expires 60001ms from now, just outside 60s buffer
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });
});

describe("fetchProjectID and onboardUser integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns project ID when loadCodeAssist has cloudaicompanionProject", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cloudaicompanionProject: { id: "existing-proj-123" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const projectId = await fetchProjectID("test-access-token");
    expect(projectId).toBe("existing-proj-123");
  });

  it("calls onboardUser when cloudaicompanionProject is missing and returns provisioned project ID", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
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
              cloudaicompanionProject: { id: "onboarded-proj-456" },
            },
          }),
        };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const projectId = await fetchProjectID("test-access-token");
    expect(projectId).toBe("onboarded-proj-456");
  });

  it("exchangeAntigravity provisions project ID via fetchProjectID during OAuth login", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "mock-access-token",
            expires_in: 3600,
            refresh_token: "mock-refresh-token",
          }),
        };
      }
      if (url.includes("userinfo")) {
        return {
          ok: true,
          json: async () => ({ email: "test@example.com" }),
        };
      }
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
              cloudaicompanionProject: { id: "login-onboarded-proj-789" },
            },
          }),
        };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const statePayload = Buffer.from(
      JSON.stringify({ verifier: "test-verifier", projectId: "" }),
    ).toString("base64url");

    const result = await exchangeAntigravity("mock-code", statePayload);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.projectId).toBe("login-onboarded-proj-789");
      expect(result.refresh).toBe("mock-refresh-token|login-onboarded-proj-789");
      const parts = parseRefreshParts(result.refresh);
      expect(parts.projectId).toBe("login-onboarded-proj-789");
    }
  });
});
