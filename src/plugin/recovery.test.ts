import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectErrorType, isRecoverableError } from "./recovery";
import {
  readMessages,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
} from "./recovery/storage";
import { MESSAGE_STORAGE, PART_STORAGE } from "./recovery/constants";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("detectErrorType", () => {
  describe("tool_result_missing detection", () => {
    it("detects tool_use without tool_result error", () => {
      const error = {
        type: "invalid_request_error",
        message: "messages.105: `tool_use` ids were found without `tool_result` blocks immediately after: tool-call-59"
      };
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });

    it("detects tool_use/tool_result mismatch error", () => {
      const error = "Each `tool_use` block must have a corresponding `tool_result` block in the next message.";
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });

    it("detects error from string message", () => {
      const error = "tool_use without matching tool_result";
      expect(detectErrorType(error)).toBe("tool_result_missing");
    });
  });

  describe("thinking_block_order detection", () => {
    it("detects thinking first block error", () => {
      const error = "thinking must be the first block in the message";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking must start with error", () => {
      const error = "Response must start with thinking block";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking preceeding error", () => {
      const error = "thinking block preceeding tool use is required";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });

    it("detects thinking expected/found error", () => {
      const error = "Expected thinking block but found text";
      expect(detectErrorType(error)).toBe("thinking_block_order");
    });
  });

  describe("thinking_disabled_violation detection", () => {
    it("detects thinking disabled error", () => {
      const error = "thinking is disabled for this model and cannot contain thinking blocks";
      expect(detectErrorType(error)).toBe("thinking_disabled_violation");
    });
  });

  describe("non-recoverable errors", () => {
    it("returns null for prompt too long error", () => {
      // This is handled separately, not as a recoverable error
      const error = { message: "Prompt is too long" };
      expect(detectErrorType(error)).toBeNull();
    });

    it("returns null for context length exceeded error", () => {
      const error = "context length exceeded";
      expect(detectErrorType(error)).toBeNull();
    });

    it("returns null for generic errors", () => {
      expect(detectErrorType("Something went wrong")).toBeNull();
      expect(detectErrorType({ message: "Unknown error" })).toBeNull();
      expect(detectErrorType(null)).toBeNull();
      expect(detectErrorType(undefined)).toBeNull();
    });

    it("returns null for rate limit errors", () => {
      const error = { message: "Rate limit exceeded. Retry after 5s" };
      expect(detectErrorType(error)).toBeNull();
    });

    it("returns null for generic INVALID_ARGUMENT with debug expected/found metadata", () => {
      const error = {
        message:
          "Request contains an invalid argument. [Debug Info] Requested Model: antigravity-claude-opus-4-6-thinking Tool Debug Summary: expected=1 found=0",
      };
      expect(detectErrorType(error)).toBeNull();
    });
  });
});

describe("isRecoverableError", () => {
  it("returns true for tool_result_missing", () => {
    const error = "tool_use without tool_result";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns true for thinking_block_order", () => {
    const error = "thinking must be the first block";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns true for thinking_disabled_violation", () => {
    const error = "thinking is disabled and cannot contain thinking";
    expect(isRecoverableError(error)).toBe(true);
  });

  it("returns false for non-recoverable errors", () => {
    expect(isRecoverableError("Prompt is too long")).toBe(false);
    expect(isRecoverableError("context length exceeded")).toBe(false);
    expect(isRecoverableError("Generic error")).toBe(false);
    expect(isRecoverableError(null)).toBe(false);
  });
});

// =============================================================================
// CONTEXT ERROR MESSAGES
// These test that error messages from the API can be properly categorized
// =============================================================================

describe("context error message patterns", () => {
  describe("prompt too long patterns", () => {
    const promptTooLongPatterns = [
      "Prompt is too long",
      "prompt is too long for this model",
      "The prompt is too long",
    ];

    it.each(promptTooLongPatterns)("'%s' is not a recoverable error", (msg) => {
      expect(isRecoverableError(msg)).toBe(false);
      expect(detectErrorType(msg)).toBeNull();
    });
  });

  describe("context length exceeded patterns", () => {
    const contextLengthPatterns = [
      "context length exceeded",
      "context_length_exceeded",
      "maximum context length",
      "exceeds the maximum context window",
    ];

    it.each(contextLengthPatterns)("'%s' is not a recoverable error", (msg) => {
      expect(isRecoverableError(msg)).toBe(false);
      expect(detectErrorType(msg)).toBeNull();
    });
  });

  describe("tool pairing error patterns", () => {
    const toolPairingPatterns = [
      "tool_use ids were found without tool_result blocks immediately after",
      "Each tool_use block must have a corresponding tool_result",
      "tool_use without matching tool_result",
    ];

    it.each(toolPairingPatterns)("'%s' is detected as tool_result_missing", (msg) => {
      expect(detectErrorType(msg)).toBe("tool_result_missing");
      expect(isRecoverableError(msg)).toBe(true);
    });
  });
});

describe("session recovery storage id sorting resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readMessages", () => {
    it("sorts messages without throwing when message id is undefined", () => {
      const sessionID = "ses_test_null_id";
      const sessionDir = join(MESSAGE_STORAGE, sessionID);

      const msgFiles = ["msg1.json", "msg2.json", "msg3.json"];
      const messagesOnDisk: Record<string, string> = {
        [join(sessionDir, "msg1.json")]: JSON.stringify({
          id: "msg_beta",
          time: { created: 1000 },
          role: "assistant",
        }),
        [join(sessionDir, "msg2.json")]: JSON.stringify({
          time: { created: 1000 },
          role: "assistant",
        }), // missing id
        [join(sessionDir, "msg3.json")]: JSON.stringify({
          id: "msg_alpha",
          time: { created: 1000 },
          role: "assistant",
        }),
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p === MESSAGE_STORAGE || p === sessionDir || p in messagesOnDisk;
      });

      vi.mocked(readdirSync).mockImplementation((path) => {
        const p = String(path);
        if (p === sessionDir) return msgFiles as any;
        return [] as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = String(path);
        if (p in messagesOnDisk) {
          return messagesOnDisk[p] as any;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      expect(() => {
        const sorted = readMessages(sessionID);
        expect(sorted).toHaveLength(3);
        expect(sorted[0]?.id).toBeUndefined();
        expect(sorted[1]?.id).toBe("msg_alpha");
        expect(sorted[2]?.id).toBe("msg_beta");
      }).not.toThrow();
    });
  });

  describe("findMessagesWithOrphanThinking", () => {
    it("sorts parts without throwing when part id is undefined", () => {
      const sessionID = "ses_test_orphan";
      const sessionDir = join(MESSAGE_STORAGE, sessionID);
      const msgId = "msg_asst_1";
      const partDir = join(PART_STORAGE, msgId);

      const msgFiles = ["msg1.json"];
      const partFiles = ["part1.json", "part2.json", "part3.json"];

      const storageFiles: Record<string, string> = {
        [join(sessionDir, "msg1.json")]: JSON.stringify({
          id: msgId,
          role: "assistant",
          time: { created: 1000 },
        }),
        [join(partDir, "part1.json")]: JSON.stringify({
          id: "prt_beta",
          type: "text",
          text: "beta text",
        }),
        [join(partDir, "part2.json")]: JSON.stringify({
          type: "text",
          text: "output text",
        }), // missing id
        [join(partDir, "part3.json")]: JSON.stringify({
          id: "prt_alpha",
          type: "thinking",
          text: "thought",
        }),
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p === MESSAGE_STORAGE || p === sessionDir || p === PART_STORAGE || p === partDir || p in storageFiles;
      });

      vi.mocked(readdirSync).mockImplementation((path) => {
        const p = String(path);
        if (p === sessionDir) return msgFiles as any;
        if (p === partDir) return partFiles as any;
        return [] as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = String(path);
        if (p in storageFiles) {
          return storageFiles[p] as any;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      let result: string[] = [];
      expect(() => {
        result = findMessagesWithOrphanThinking(sessionID);
      }).not.toThrow();
      expect(result).toEqual([msgId]);
    });
  });

  describe("findMessageByIndexNeedingThinking", () => {
    it("sorts parts without throwing when target message part id is undefined", () => {
      const sessionID = "ses_test_index";
      const sessionDir = join(MESSAGE_STORAGE, sessionID);
      const msgId = "msg_target";
      const partDir = join(PART_STORAGE, msgId);

      const msgFiles = ["msg1.json"];
      const partFiles = ["part1.json", "part2.json", "part3.json"];

      const storageFiles: Record<string, string> = {
        [join(sessionDir, "msg1.json")]: JSON.stringify({
          id: msgId,
          role: "assistant",
          time: { created: 1000 },
        }),
        [join(partDir, "part1.json")]: JSON.stringify({
          id: "prt_beta",
          type: "text",
          text: "beta text",
        }),
        [join(partDir, "part2.json")]: JSON.stringify({
          type: "text",
          text: "direct text",
        }), // missing id
        [join(partDir, "part3.json")]: JSON.stringify({
          id: "prt_alpha",
          type: "thinking",
          text: "thought",
        }),
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p === MESSAGE_STORAGE || p === sessionDir || p === PART_STORAGE || p === partDir || p in storageFiles;
      });

      vi.mocked(readdirSync).mockImplementation((path) => {
        const p = String(path);
        if (p === sessionDir) return msgFiles as any;
        if (p === partDir) return partFiles as any;
        return [] as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = String(path);
        if (p in storageFiles) {
          return storageFiles[p] as any;
        }
        throw new Error(`ENOENT: ${p}`);
      });

      let result: string | null = null;
      expect(() => {
        result = findMessageByIndexNeedingThinking(sessionID, 0);
      }).not.toThrow();
      expect(result).toBe(msgId);
    });
  });
});
