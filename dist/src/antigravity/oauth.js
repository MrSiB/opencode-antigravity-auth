import { generatePKCE } from "@openauthjs/openauth/pkce";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_REDIRECT_URI, ANTIGRAVITY_SCOPES, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_LOAD_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID, getAntigravityHeaders, GEMINI_CLI_HEADERS, } from "../constants.js";
import { createLogger } from "../plugin/logger.js";
import { calculateTokenExpiry } from "../plugin/auth.js";
const log = createLogger("oauth");
/**
 * Encode an object into a URL-safe base64 string.
 */
function encodeState(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
/**
 * Decode an OAuth state parameter back into its structured representation.
 */
function decodeState(state) {
    const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed.verifier !== "string") {
        throw new Error("Missing PKCE verifier in state");
    }
    return {
        verifier: parsed.verifier,
        projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
    };
}
/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export async function authorizeAntigravity(projectId = "") {
    const pkce = (await generatePKCE());
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
    url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", encodeState({ verifier: pkce.verifier, projectId: projectId || "" }));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return {
        url: url.toString(),
        verifier: pkce.verifier,
        projectId: projectId || "",
    };
}
const FETCH_TIMEOUT_MS = 10000;
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function fetchProjectID(accessToken) {
    const errors = [];
    const loadHeaders = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
        "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
    };
    const loadEndpoints = Array.from(new Set([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]));
    for (const baseEndpoint of loadEndpoints) {
        try {
            const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
            const response = await fetchWithTimeout(url, {
                method: "POST",
                headers: loadHeaders,
                body: JSON.stringify({
                    metadata: {
                        ideType: "ANTIGRAVITY",
                        platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
                        pluginType: "GEMINI",
                    },
                }),
            });
            if (!response.ok) {
                const message = await response.text().catch(() => "");
                errors.push(`loadCodeAssist ${response.status} at ${baseEndpoint}${message ? `: ${message}` : ""}`);
                continue;
            }
            const data = await response.json();
            if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject &&
                typeof data.cloudaicompanionProject.id === "string" &&
                data.cloudaicompanionProject.id) {
                return data.cloudaicompanionProject.id;
            }
            const allowedTiers = data.allowedTiers;
            const tierId = allowedTiers?.find((t) => t?.isDefault)?.id || allowedTiers?.[0]?.id || "FREE";
            try {
                const onboardUrl = `${baseEndpoint}/v1internal:onboardUser`;
                const onboardResponse = await fetchWithTimeout(onboardUrl, {
                    method: "POST",
                    headers: loadHeaders,
                    body: JSON.stringify({
                        tierId,
                        metadata: {
                            ideType: "ANTIGRAVITY",
                            platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
                            pluginType: "GEMINI",
                        },
                    }),
                });
                if (onboardResponse.ok) {
                    const onboardData = await onboardResponse.json();
                    const onboardProj = onboardData.response?.cloudaicompanionProject ?? onboardData.cloudaicompanionProject;
                    const onboardProjectId = typeof onboardProj === "string" ? onboardProj : onboardProj?.id;
                    if (onboardProjectId) {
                        return onboardProjectId;
                    }
                    const recheckResponse = await fetchWithTimeout(url, {
                        method: "POST",
                        headers: loadHeaders,
                        body: JSON.stringify({
                            metadata: {
                                ideType: "ANTIGRAVITY",
                                platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
                                pluginType: "GEMINI",
                            },
                        }),
                    });
                    if (recheckResponse.ok) {
                        const recheckData = await recheckResponse.json();
                        if (typeof recheckData.cloudaicompanionProject === "string" && recheckData.cloudaicompanionProject) {
                            return recheckData.cloudaicompanionProject;
                        }
                        if (recheckData.cloudaicompanionProject &&
                            typeof recheckData.cloudaicompanionProject.id === "string" &&
                            recheckData.cloudaicompanionProject.id) {
                            return recheckData.cloudaicompanionProject.id;
                        }
                    }
                }
            }
            catch (onboardErr) {
                errors.push(`onboardUser error at ${baseEndpoint}: ${onboardErr instanceof Error ? onboardErr.message : String(onboardErr)}`);
            }
            errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
        }
        catch (e) {
            errors.push(`loadCodeAssist error at ${baseEndpoint}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (errors.length) {
        log.warn("Failed to resolve Antigravity project via loadCodeAssist", { errors: errors.join("; ") });
    }
    return "";
}
/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export async function exchangeAntigravity(code, state) {
    try {
        const { verifier, projectId } = decodeState(state);
        const startTime = Date.now();
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "Accept": "*/*",
                "Accept-Encoding": "gzip, deflate, br",
                "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
            },
            body: new URLSearchParams({
                client_id: ANTIGRAVITY_CLIENT_ID,
                client_secret: ANTIGRAVITY_CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: ANTIGRAVITY_REDIRECT_URI,
                code_verifier: verifier,
            }),
        });
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            return { type: "failed", error: errorText };
        }
        const tokenPayload = (await tokenResponse.json());
        const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
            headers: {
                Authorization: `Bearer ${tokenPayload.access_token}`,
                "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
            },
        });
        const userInfo = userInfoResponse.ok
            ? (await userInfoResponse.json())
            : {};
        const refreshToken = tokenPayload.refresh_token;
        if (!refreshToken) {
            return { type: "failed", error: "Missing refresh token in response" };
        }
        let effectiveProjectId = projectId;
        if (!effectiveProjectId) {
            effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
        }
        if (!effectiveProjectId) {
            effectiveProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
        }
        const storedRefresh = `${refreshToken}|${effectiveProjectId || ""}`;
        return {
            type: "success",
            refresh: storedRefresh,
            access: tokenPayload.access_token,
            expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
            email: userInfo.email,
            projectId: effectiveProjectId || "",
        };
    }
    catch (error) {
        return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
//# sourceMappingURL=oauth.js.map