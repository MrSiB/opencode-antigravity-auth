import { isGenerativeLanguageRequest } from "../request";
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
function extractPrompt(body) {
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
    const messages = body["messages"];
    if (Array.isArray(messages)) {
        return messages
            .map((message) => {
            if (!message || typeof message !== "object")
                return "";
            const content = message["content"];
            if (typeof content === "string")
                return content;
            if (!Array.isArray(content))
                return "";
            return content
                .map((part) => {
                if (!part || typeof part !== "object")
                    return "";
                const text = part["text"];
                return typeof text === "string" ? text : "";
            })
                .filter(Boolean)
                .join("\n");
        })
            .filter(Boolean)
            .join("\n\n");
    }
    return "";
}
function geminiTextResponse(text) {
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
    });
}
export function createCliTransport(config) {
    return {
        id: "cli",
        label: "Antigravity CLI",
        matches(input) {
            return config.enabled && isGenerativeLanguageRequest(input);
        },
        getRequestMetadata() {
            return {
                family: "agent",
                model: "agy",
            };
        },
        auth: {
            requiresOAuth: false,
            requiresProjectContext: false,
            supportsMultiAccount: false,
            supportsHeaderStyle: false,
        },
        prepareRequest(ctx) {
            const body = readJsonBody(ctx.init);
            const prompt = extractPrompt(body);
            if (!prompt.trim()) {
                throw new Error("CliTransport could not extract a text prompt from the request body.");
            }
            const args = [
                "--print",
                prompt,
                "--print-timeout",
                `${config.print_timeout_seconds}s`,
            ];
            if (config.log_file) {
                args.push("--log-file", config.log_file);
            }
            if (config.sandbox) {
                args.push("--sandbox");
            }
            if (config.dangerously_skip_permissions) {
                args.push("--dangerously-skip-permissions");
            }
            const command = {
                binary: config.binary ?? "agy",
                args,
                timeoutMs: config.process_timeout_seconds * 1000,
            };
            return {
                request: "opencode-antigravity://cli/agy-print",
                init: { method: "POST" },
                streaming: false,
                action: "agy-print",
                requestedModel: "agy",
                effectiveModel: "agy",
                headerStyle: "antigravity",
                transportPayload: command,
            };
        },
        async transformResponse(ctx) {
            if (!ctx.response.ok)
                return ctx.response;
            const payload = await ctx.response.json();
            const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
            return geminiTextResponse(stdout.trim());
        },
    };
}
//# sourceMappingURL=cli-transport.js.map