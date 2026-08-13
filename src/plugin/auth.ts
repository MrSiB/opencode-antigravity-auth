import type { AuthDetails, OAuthAuthDetails, RefreshParts } from "./types";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Splits a packed refresh string into its constituent refresh token and project IDs.
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", rawProjectId = "", rawManagedProjectId = ""] = (refresh ?? "").split("|");
  const projectId = rawProjectId === "infinite-provider-f7c1c" || rawProjectId === "rising-fact-p41fc" ? "" : rawProjectId;
  const managedProjectId = rawManagedProjectId === "infinite-provider-f7c1c" || rawManagedProjectId === "rising-fact-p41fc" ? "" : rawManagedProjectId;
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

/**
 * Serializes refresh token parts into the stored string format.
 */
export function formatRefreshParts(parts: RefreshParts): string {
  const cleanProj = (parts.projectId === "infinite-provider-f7c1c" || parts.projectId === "rising-fact-p41fc") ? undefined : parts.projectId;
  const cleanManaged = (parts.managedProjectId === "infinite-provider-f7c1c" || parts.managedProjectId === "rising-fact-p41fc") ? undefined : parts.managedProjectId;
  const projectSegment = cleanProj ?? "";
  const base = `${parts.refreshToken}|${projectSegment}`;
  return cleanManaged ? `${base}|${cleanManaged}` : base;
}

/**
 * Determines whether an access token is expired or missing, with buffer for clock skew.
 */
export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Calculates absolute expiry timestamp based on a duration.
 * @param requestTimeMs The local time when the request was initiated
 * @param expiresInSeconds The duration returned by the server
 */
export function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown): number {
  const seconds = typeof expiresInSeconds === "number" ? expiresInSeconds : 3600;
  // Safety check for bad data - if it's not a positive number, treat as immediately expired
  if (isNaN(seconds) || seconds <= 0) {
    return requestTimeMs;
  }
  return requestTimeMs + seconds * 1000;
}
