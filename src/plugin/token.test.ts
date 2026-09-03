import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { AntigravityTokenRefreshError, clearInFlightRefreshes, refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: vi.fn(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof vi.fn> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearInFlightRefreshes();
  });

  it("updates the caller when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("handles Google refresh token rotation", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("next-access");
    expect(result?.refresh).toContain("rotated-token");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("throws a typed error on invalid_grant", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
        { status: 400, statusText: "Bad Request" },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID)).rejects.toMatchObject({
      name: "AntigravityTokenRefreshError",
      code: "invalid_grant",
    });
  });

  it("deduplicates 5 concurrent refresh requests for the same refresh token", async () => {
    const client = createClient();
    let resolveResponse: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });

    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          access_token: "concurrent-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const p1 = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const p2 = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const p3 = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const p4 = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const p5 = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(p4).toBe(p1);
    expect(p5).toBe(p1);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse!();

    const [res1, res2, res3, res4, res5] = await Promise.all([p1, p2, p3, p4, p5]);

    expect(res1?.access).toBe("concurrent-access");
    expect(res2?.access).toBe("concurrent-access");
    expect(res3?.access).toBe("concurrent-access");
    expect(res4?.access).toBe("concurrent-access");
    expect(res5?.access).toBe("concurrent-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const p6 = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(p6?.access).toBe("concurrent-access");
  });

  it("propagates rejection to all concurrent callers and cleans up in-flight entry", async () => {
    const client = createClient();
    let rejectResponse: (res: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      rejectResponse = resolve;
    });

    const fetchMock = vi.fn().mockImplementationOnce(async () => pendingResponse);
    global.fetch = fetchMock as unknown as typeof fetch;

    const promises = Array.from({ length: 5 }, () =>
      refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    rejectResponse!(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token revoked",
        }),
        { status: 400, statusText: "Bad Request" },
      ),
    );

    const results = await Promise.allSettled(promises);
    for (const res of results) {
      expect(res.status).toBe("rejected");
      if (res.status === "rejected") {
        expect(res.reason).toBeInstanceOf(AntigravityTokenRefreshError);
        expect(res.reason).toMatchObject({
          name: "AntigravityTokenRefreshError",
          code: "invalid_grant",
        });
      }
    }

    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          access_token: "recovered-access",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const recovered = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    expect(recovered?.access).toBe("recovered-access");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows concurrent refreshes for different accounts without collision", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "separate-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const authA: OAuthAuthDetails = {
      ...baseAuth,
      refresh: "token-a|project-1",
    };
    const authB: OAuthAuthDetails = {
      ...baseAuth,
      refresh: "token-b|project-2",
    };

    const [resA, resB] = await Promise.all([
      refreshAccessToken(authA, client, ANTIGRAVITY_PROVIDER_ID),
      refreshAccessToken(authB, client, ANTIGRAVITY_PROVIDER_ID),
    ]);

    expect(resA?.access).toBe("separate-access");
    expect(resB?.access).toBe("separate-access");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
