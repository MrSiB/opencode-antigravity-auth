import { isGenerativeLanguageRequest } from "../request";
const MANAGED_AGENT_ID = "antigravity-preview-05-2026";
const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
function readJsonBody(init) {
    if (typeof init?.body !== "string")
        return {};
    try {
        const parsed = JSON.parse(init.body);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function extractInput(body) {
    if (typeof body["input"] === "string")
        return body["input"];
    if (typeof body["prompt"] === "string")
        return body["prompt"];
    const contents = body["contents"];
    if (Array.isArray(contents)) {
        return contents
            .flatMap((content) => {
            if (!content || typeof content !== "object")
                return [];
            const parts = content["parts"];
            if (!Array.isArray(parts))
                return [];
            return parts
                .map((part) => {
                if (!part || typeof part !== "object")
                    return "";
                const text = part["text"];
                return typeof text === "string" ? text : "";
            })
                .filter(Boolean);
        })
            .join("\n\n");
    }
    return "";
}
function extractPreviousInteractionId(body) {
    const value = body["previous_interaction_id"]
        ?? body["previousInteractionId"]
        ?? body["metadata"]?.["previous_interaction_id"];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function toGeminiTextResponse(text, interactionId) {
    return Response.json({
        candidates: [
            {
                content: {
                    role: "model",
                    parts: [{ text }],
                },
                finishReason: "STOP",
            },
        ],
        interactionId,
    });
}
function extractManagedAgentText(payload) {
    if (!payload || typeof payload !== "object") {
        return { text: "" };
    }
    const obj = payload;
    const interactionId = typeof obj["interaction_id"] === "string"
        ? obj["interaction_id"]
        : typeof obj["id"] === "string"
            ? obj["id"]
            : undefined;
    if (typeof obj["output"] === "string") {
        return { text: obj["output"], interactionId };
    }
    if (typeof obj["text"] === "string") {
        return { text: obj["text"], interactionId };
    }
    const candidates = obj["candidates"];
    if (Array.isArray(candidates)) {
        const first = candidates[0];
        if (first && typeof first === "object") {
            const content = first["content"];
            if (content && typeof content === "object") {
                const parts = content["parts"];
                if (Array.isArray(parts)) {
                    const text = parts
                        .map((part) => {
                        if (!part || typeof part !== "object")
                            return "";
                        const value = part["text"];
                        return typeof value === "string" ? value : "";
                    })
                        .filter(Boolean)
                        .join("");
                    return { text, interactionId };
                }
            }
        }
    }
    return {
        text: JSON.stringify(payload),
        interactionId,
    };
}
export function createManagedAgentTransport(config) {
    return {
        id: "managed-agent",
        label: "Managed Agent",
        matches(input) {
            return config.enabled && isGenerativeLanguageRequest(input);
        },
        getRequestMetadata() {
            return {
                family: "agent",
                model: MANAGED_AGENT_ID,
            };
        },
        auth: {
            requiresOAuth: false,
            requiresProjectContext: false,
            supportsMultiAccount: false,
            supportsHeaderStyle: false,
        },
        prepareRequest(ctx) {
            if (!config.api_key.trim()) {
                throw new Error("ManagedAgentTransport requires transport.managed_agent.api_key.");
            }
            const body = readJsonBody(ctx.init);
            const input = extractInput(body);
            if (!input.trim()) {
                throw new Error("ManagedAgentTransport could not extract input text from the request body.");
            }
            const requestBody = {
                agent: MANAGED_AGENT_ID,
                input,
            };
            const previousInteractionId = extractPreviousInteractionId(body);
            if (previousInteractionId) {
                requestBody["previous_interaction_id"] = previousInteractionId;
            }
            if (config.system_instruction) {
                requestBody["system_instruction"] = config.system_instruction;
            }
            if (config.environment) {
                requestBody["environment"] = config.environment;
            }
            return {
                request: INTERACTIONS_ENDPOINT,
                init: {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Api-Revision": API_REVISION,
                        "x-goog-api-key": config.api_key.trim(),
                    },
                    body: JSON.stringify(requestBody),
                },
                streaming: config.stream,
                action: "managed-agent-interaction",
                requestedModel: MANAGED_AGENT_ID,
                effectiveModel: MANAGED_AGENT_ID,
                endpoint: INTERACTIONS_ENDPOINT,
                headerStyle: "antigravity",
            };
        },
        async transformResponse(ctx) {
            if (!ctx.response.ok) {
                let message = `Managed Agents API returned HTTP ${ctx.response.status}.`;
                try {
                    const err = await ctx.response.json();
                    if (err.error?.message)
                        message = err.error.message;
                }
                catch {
                    // Keep generic message
                }
                return Response.json({
                    error: {
                        code: ctx.response.status,
                        status: "MANAGED_AGENT_ERROR",
                        message,
                    },
                }, { status: ctx.response.status });
            }
            // Non-streaming: parse and normalize
            if (!ctx.prepared.streaming) {
                const payload = await ctx.response.json();
                const { text, interactionId } = extractManagedAgentText(payload);
                return toGeminiTextResponse(text, interactionId);
            }
            // Streaming: conservative — return SSE as-is for now.
            // Add event-shape-specific normalization only after observing real payloads.
            return ctx.response;
        },
    };
}
//# sourceMappingURL=managed-agent-transport.js.map