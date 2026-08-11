import type { Transport } from "./types";
/**
 * GatewayTransport wraps the existing /v1internal CloudCode gateway shim.
 *
 * This is the default and only transport in Phase 3. It delegates entirely to
 * prepareAntigravityRequest() and transformAntigravityResponse() in request.ts.
 * No logic is moved — this is a thin seam for future transport alternatives.
 *
 * Responsibilities:
 * - Request recognition (generativelanguage.googleapis.com URLs)
 * - Request preparation (auth headers, endpoint routing, body transformation)
 * - Response transformation (SSE streaming, thinking blocks, tool normalization)
 *
 * Non-responsibilities (owned by the fetch interceptor in plugin.ts):
 * - Account selection and rotation
 * - Quota tracking and rate limit backoff
 * - Endpoint fallback loop
 * - Auth token refresh
 * - Toast notifications
 */
export declare const gatewayTransport: Transport;
//# sourceMappingURL=gateway-transport.d.ts.map