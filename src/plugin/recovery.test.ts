import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectErrorType,
  isRecoverableError,
  extractToolUseIds,
  recoverToolResultMissing,
} from "./recovery";
import {
  readMessages,
  readParts,
  hasContent,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
  stripThinkingParts,
} from "./recovery/storage";
import { MESSAGE_STORAGE, PART_STORAGE } from "./recovery/constants";
import { join } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    mkdirSync: vi.fn(actual.mkdirSync),
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

describe("corrupted storage and null tolerance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readMessages null tolerance", () => {
    it("safely ignores null or 'null' files on disk without throwing TypeError", () => {
      const sessionID = "ses_null_messages";
      const sessionDir = join(MESSAGE_STORAGE, sessionID);
      const msgFiles = ["msg1.json", "msg2.json", "msg3.json", "msg4.json"];
      const messagesOnDisk: Record<string, string> = {
        [join(sessionDir, "msg1.json")]: "null",
        [join(sessionDir, "msg2.json")]: JSON.stringify(null),
        [join(sessionDir, "msg3.json")]: "123",
        [join(sessionDir, "msg4.json")]: JSON.stringify({
          id: "msg_valid",
          role: "assistant",
          time: { created: 1000 },
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
        if (p in messagesOnDisk) return messagesOnDisk[p] as any;
        throw new Error(`ENOENT: ${p}`);
      });

      const messages = readMessages(sessionID);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe("msg_valid");
    });
  });

  describe("readParts null tolerance", () => {
    it("safely ignores null or 'null' files on disk without throwing TypeError", () => {
      const msgId = "msg_parts_null";
      const partDir = join(PART_STORAGE, msgId);
      const partFiles = ["part1.json", "part2.json", "part3.json", "part4.json"];
      const partsOnDisk: Record<string, string> = {
        [join(partDir, "part1.json")]: "null",
        [join(partDir, "part2.json")]: JSON.stringify(null),
        [join(partDir, "part3.json")]: "false",
        [join(partDir, "part4.json")]: JSON.stringify({
          id: "prt_valid",
          type: "text",
          text: "hello world",
        }),
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p === PART_STORAGE || p === partDir || p in partsOnDisk;
      });

      vi.mocked(readdirSync).mockImplementation((path) => {
        const p = String(path);
        if (p === partDir) return partFiles as any;
        return [] as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = String(path);
        if (p in partsOnDisk) return partsOnDisk[p] as any;
        throw new Error(`ENOENT: ${p}`);
      });

      const parts = readParts(msgId);
      expect(parts).toHaveLength(1);
      expect(parts[0]?.id).toBe("prt_valid");
    });
  });

  describe("hasContent null tolerance", () => {
    it("returns false for null or undefined or non-object part without throwing", () => {
      expect(hasContent(null as any)).toBe(false);
      expect(hasContent(undefined as any)).toBe(false);
      expect(hasContent("string" as any)).toBe(false);
      expect(hasContent(123 as any)).toBe(false);
    });
  });
});

describe("findMessagesWithOrphanThinking accuracy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT flag normal text assistant messages as orphans", () => {
    const sessionID = "ses_text_only";
    const sessionDir = join(MESSAGE_STORAGE, sessionID);
    const msgId = "msg_asst_text";
    const partDir = join(PART_STORAGE, msgId);

    const storageFiles: Record<string, string> = {
      [join(sessionDir, "msg1.json")]: JSON.stringify({
        id: msgId,
        role: "assistant",
        time: { created: 1000 },
      }),
      [join(partDir, "part1.json")]: JSON.stringify({
        id: "prt_1",
        type: "text",
        text: "Just normal assistant text",
      }),
    };

    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === MESSAGE_STORAGE || p === sessionDir || p === PART_STORAGE || p === partDir || p in storageFiles;
    });

    vi.mocked(readdirSync).mockImplementation((path) => {
      const p = String(path);
      if (p === sessionDir) return ["msg1.json"] as any;
      if (p === partDir) return ["part1.json"] as any;
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p in storageFiles) return storageFiles[p] as any;
      throw new Error(`ENOENT: ${p}`);
    });

    const result = findMessagesWithOrphanThinking(sessionID);
    expect(result).toEqual([]);
  });

  it("correctly ignores step-start meta parts preceding thinking", () => {
    const sessionID = "ses_meta_and_thinking";
    const sessionDir = join(MESSAGE_STORAGE, sessionID);
    const msgId = "msg_asst_meta";
    const partDir = join(PART_STORAGE, msgId);

    const storageFiles: Record<string, string> = {
      [join(sessionDir, "msg1.json")]: JSON.stringify({
        id: msgId,
        role: "assistant",
        time: { created: 1000 },
      }),
      [join(partDir, "part0.json")]: JSON.stringify({
        id: "prt_00_step",
        type: "step-start",
      }),
      [join(partDir, "part1.json")]: JSON.stringify({
        id: "prt_01_thinking",
        type: "thinking",
        text: "thought process",
      }),
      [join(partDir, "part2.json")]: JSON.stringify({
        id: "prt_02_text",
        type: "text",
        text: "assistant reply",
      }),
    };

    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === MESSAGE_STORAGE || p === sessionDir || p === PART_STORAGE || p === partDir || p in storageFiles;
    });

    vi.mocked(readdirSync).mockImplementation((path) => {
      const p = String(path);
      if (p === sessionDir) return ["msg1.json"] as any;
      if (p === partDir) return ["part0.json", "part1.json", "part2.json"] as any;
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p in storageFiles) return storageFiles[p] as any;
      throw new Error(`ENOENT: ${p}`);
    });

    const result = findMessagesWithOrphanThinking(sessionID);
    expect(result).toEqual([]);
  });

  it("flags assistant messages where thinking is out of order", () => {
    const sessionID = "ses_out_of_order";
    const sessionDir = join(MESSAGE_STORAGE, sessionID);
    const msgId = "msg_asst_out_of_order";
    const partDir = join(PART_STORAGE, msgId);

    const storageFiles: Record<string, string> = {
      [join(sessionDir, "msg1.json")]: JSON.stringify({
        id: msgId,
        role: "assistant",
        time: { created: 1000 },
      }),
      [join(partDir, "part0.json")]: JSON.stringify({
        id: "prt_00_step",
        type: "step-start",
      }),
      [join(partDir, "part1.json")]: JSON.stringify({
        id: "prt_01_text",
        type: "text",
        text: "text before thinking",
      }),
      [join(partDir, "part2.json")]: JSON.stringify({
        id: "prt_02_thinking",
        type: "thinking",
        text: "thinking block",
      }),
    };

    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === MESSAGE_STORAGE || p === sessionDir || p === PART_STORAGE || p === partDir || p in storageFiles;
    });

    vi.mocked(readdirSync).mockImplementation((path) => {
      const p = String(path);
      if (p === sessionDir) return ["msg1.json"] as any;
      if (p === partDir) return ["part0.json", "part1.json", "part2.json"] as any;
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p in storageFiles) return storageFiles[p] as any;
      throw new Error(`ENOENT: ${p}`);
    });

    const result = findMessagesWithOrphanThinking(sessionID);
    expect(result).toEqual([msgId]);
  });
});

describe("stripThinkingParts placeholder injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects placeholder text part when only thinking parts were present", () => {
    const msgId = "msg_only_thinking";
    const partDir = join(PART_STORAGE, msgId);
    let diskFiles: Record<string, string> = {
      [join(partDir, "part1.json")]: JSON.stringify({
        id: "prt_1",
        sessionID: "ses_strip_1",
        messageID: msgId,
        type: "thinking",
        text: "thinking only",
      }),
    };

    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === PART_STORAGE || p === partDir || p in diskFiles;
    });

    vi.mocked(readdirSync).mockImplementation((path) => {
      const p = String(path);
      if (p === partDir) {
        return Object.keys(diskFiles).map((k) => k.replace(partDir + "/", "")) as any;
      }
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p in diskFiles) return diskFiles[p] as any;
      throw new Error(`ENOENT: ${p}`);
    });

    vi.mocked(unlinkSync).mockImplementation((path) => {
      const p = String(path);
      delete diskFiles[p];
    });

    let writtenPayload: any = null;
    vi.mocked(writeFileSync).mockImplementation((path, data) => {
      const p = String(path);
      diskFiles[p] = String(data);
      writtenPayload = JSON.parse(String(data));
    });

    const removed = stripThinkingParts(msgId, "ses_strip_1");
    expect(removed).toBe(true);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(writtenPayload).toMatchObject({
      messageID: msgId,
      sessionID: "ses_strip_1",
      type: "text",
      text: "[Thinking stripped]",
      synthetic: true,
    });
  });

  it("does NOT inject placeholder when valid text content remains after stripping", () => {
    const msgId = "msg_thinking_and_text";
    const partDir = join(PART_STORAGE, msgId);
    let diskFiles: Record<string, string> = {
      [join(partDir, "part1.json")]: JSON.stringify({
        id: "prt_1",
        sessionID: "ses_strip_2",
        messageID: msgId,
        type: "thinking",
        text: "thinking",
      }),
      [join(partDir, "part2.json")]: JSON.stringify({
        id: "prt_2",
        sessionID: "ses_strip_2",
        messageID: msgId,
        type: "text",
        text: "valid assistant text",
      }),
    };

    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === PART_STORAGE || p === partDir || p in diskFiles;
    });

    vi.mocked(readdirSync).mockImplementation((path) => {
      const p = String(path);
      if (p === partDir) {
        return Object.keys(diskFiles).map((k) => k.replace(partDir + "/", "")) as any;
      }
      return [] as any;
    });

    vi.mocked(readFileSync).mockImplementation((path) => {
      const p = String(path);
      if (p in diskFiles) return diskFiles[p] as any;
      throw new Error(`ENOENT: ${p}`);
    });

    vi.mocked(unlinkSync).mockImplementation((path) => {
      const p = String(path);
      delete diskFiles[p];
    });

    vi.mocked(writeFileSync).mockClear();

    const removed = stripThinkingParts(msgId);
    expect(removed).toBe(true);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("extractToolUseIds and recoverToolResultMissing null tolerance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("extractToolUseIds", () => {
    it("handles arrays containing nulls or non-objects without throwing", () => {
      const parts = [
        null as any,
        undefined as any,
        "not an object" as any,
        { type: "text", text: "hi" },
        { type: "tool_use", id: "call_1" },
        null as any,
        { type: "tool_use", id: "call_2" },
        { type: "tool_use" },
      ];
      expect(extractToolUseIds(parts)).toEqual(["call_1", "call_2"]);
    });
  });

  describe("recoverToolResultMissing", () => {
    it("handles failedMsg.parts containing nulls without throwing", async () => {
      const mockClient: any = {
        session: {
          prompt: vi.fn().mockResolvedValue({}),
        },
      };

      const failedMsg: any = {
        parts: [
          null,
          undefined,
          { type: "tool_use", id: "tool_call_abc" },
          null,
        ],
      };

      const result = await recoverToolResultMissing(mockClient, "ses_test", failedMsg);
      expect(result).toBe(true);
      expect(mockClient.session.prompt).toHaveBeenCalledWith({
        path: { id: "ses_test" },
        body: {
          parts: [
            {
              type: "tool_result",
              tool_use_id: "tool_call_abc",
              content: "Operation cancelled by user (ESC pressed)",
            },
          ],
        },
      });
    });

    it("handles storedParts containing nulls without 'Cannot use in operator' error", async () => {
      const msgId = "msg_with_null_stored_parts";
      const partDir = join(PART_STORAGE, msgId);
      const partFiles = ["p1.json", "p2.json", "p3.json"];
      const partsOnDisk: Record<string, string> = {
        [join(partDir, "p1.json")]: "null",
        [join(partDir, "p2.json")]: JSON.stringify({
          id: "prt_tool",
          type: "tool",
          callID: "tool_call_from_storage",
          tool: "bash",
          state: { status: "running", input: {} },
        }),
        [join(partDir, "p3.json")]: JSON.stringify(null),
      };

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p === PART_STORAGE || p === partDir || p in partsOnDisk;
      });

      vi.mocked(readdirSync).mockImplementation((path) => {
        const p = String(path);
        if (p === partDir) return partFiles as any;
        return [] as any;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = String(path);
        if (p in partsOnDisk) return partsOnDisk[p] as any;
        throw new Error(`ENOENT: ${p}`);
      });

      const mockClient: any = {
        session: {
          prompt: vi.fn().mockResolvedValue({}),
        },
      };

      const failedMsg: any = {
        parts: [],
        info: { id: msgId },
      };

      const result = await recoverToolResultMissing(mockClient, "ses_test_storage", failedMsg);
      expect(result).toBe(true);
      expect(mockClient.session.prompt).toHaveBeenCalledWith({
        path: { id: "ses_test_storage" },
        body: {
          parts: [
            {
              type: "tool_result",
              tool_use_id: "tool_call_from_storage",
              content: "Operation cancelled by user (ESC pressed)",
            },
          ],
        },
      });
    });
  });
});
