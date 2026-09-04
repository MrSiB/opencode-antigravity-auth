/**
 * Storage utilities for reading OpenCode's session data.
 * 
 * Based on oh-my-opencode/src/hooks/session-recovery/storage.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_STORAGE, PART_STORAGE, THINKING_TYPES, META_TYPES } from "./constants";
import type { StoredMessageMeta, StoredPart, StoredTextPart } from "./types";

// =============================================================================
// ID Generation
// =============================================================================

export function generatePartId(): string {
  const timestamp = Date.now().toString(16);
  const random = Math.random().toString(36).substring(2, 10);
  return `prt_${timestamp}${random}`;
}

// =============================================================================
// Directory Helpers
// =============================================================================

export function getMessageDir(sessionID: string): string {
  if (!existsSync(MESSAGE_STORAGE)) return "";

  const directPath = join(MESSAGE_STORAGE, sessionID);
  if (existsSync(directPath)) {
    return directPath;
  }

  // Search in subdirectories
  try {
    for (const dir of readdirSync(MESSAGE_STORAGE)) {
      const sessionPath = join(MESSAGE_STORAGE, dir, sessionID);
      if (existsSync(sessionPath)) {
        return sessionPath;
      }
    }
  } catch {
    // Ignore read errors
  }

  return "";
}

// =============================================================================
// Message Reading
// =============================================================================

export function readMessages(sessionID: string): StoredMessageMeta[] {
  const messageDir = getMessageDir(sessionID);
  if (!messageDir || !existsSync(messageDir)) return [];

  const messages: StoredMessageMeta[] = [];
  try {
    for (const file of readdirSync(messageDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(messageDir, file), "utf-8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object") {
          messages.push(parsed as StoredMessageMeta);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return messages.sort((a, b) => {
    const aTime = a?.time?.created ?? 0;
    const bTime = b?.time?.created ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return (a?.id ?? "").localeCompare(b?.id ?? "");
  });
}

// =============================================================================
// Part Reading
// =============================================================================

export function readParts(messageID: string): StoredPart[] {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) return [];

  const parts: StoredPart[] = [];
  try {
    for (const file of readdirSync(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(partDir, file), "utf-8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object") {
          parts.push(parsed as StoredPart);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return parts;
}

// =============================================================================
// Content Helpers
// =============================================================================

export function hasContent(part: StoredPart): boolean {
  if (!part || typeof part !== "object") return false;
  if (THINKING_TYPES.has(part.type)) return false;
  if (META_TYPES.has(part.type)) return false;

  if (part.type === "text") {
    const textPart = part as StoredTextPart;
    return !!(textPart.text?.trim());
  }

  if (part.type === "tool" || part.type === "tool_use") {
    return true;
  }

  if (part.type === "tool_result") {
    return true;
  }

  return false;
}

export function messageHasContent(messageID: string): boolean;
export function messageHasContent(sessionID: string, messageID: string): boolean;
export function messageHasContent(arg1: string, arg2?: string): boolean {
  const messageID = arg2 !== undefined ? arg2 : arg1;
  const parts = readParts(messageID);
  return parts.some(hasContent);
}

// =============================================================================
// Part Injection (for recovery)
// =============================================================================

export function injectTextPart(sessionID: string, messageID: string, text: string): boolean {
  const partDir = join(PART_STORAGE, messageID);

  try {
    if (!existsSync(partDir)) {
      mkdirSync(partDir, { recursive: true });
    }

    const partId = generatePartId();
    const part: StoredTextPart = {
      id: partId,
      sessionID,
      messageID,
      type: "text",
      text,
      synthetic: true,
    };

    writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Thinking Block Recovery
// =============================================================================

export function findMessagesWithThinkingBlocks(sessionID: string): string[] {
  const messages = readMessages(sessionID);
  const result: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !msg.id) continue;

    const parts = readParts(msg.id);
    const hasThinking = parts.some((p) => p && typeof p === "object" && THINKING_TYPES.has(p.type));
    if (hasThinking) {
      result.push(msg.id);
    }
  }

  return result;
}

export function findMessagesWithThinkingOnly(sessionID: string): string[] {
  const messages = readMessages(sessionID);
  const result: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !msg.id) continue;

    const parts = readParts(msg.id);
    if (parts.length === 0) continue;

    const hasThinking = parts.some((p) => p && typeof p === "object" && THINKING_TYPES.has(p.type));
    const hasTextContent = parts.some(hasContent);

    // Has thinking but no text content = orphan thinking
    if (hasThinking && !hasTextContent) {
      result.push(msg.id);
    }
  }

  return result;
}

export function findMessagesWithOrphanThinking(sessionID: string): string[] {
  const messages = readMessages(sessionID);
  const result: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !msg.id) continue;

    const parts = readParts(msg.id);
    if (parts.length === 0) continue;

    const hasThinking = parts.some((p) => p && typeof p === "object" && THINKING_TYPES.has(p.type));
    if (!hasThinking) continue;

    const contentParts = parts.filter(
      (p) => p && typeof p === "object" && !META_TYPES.has(p.type)
    );
    if (contentParts.length === 0) continue;

    const sortedParts = [...contentParts].sort((a, b) => (a?.id ?? "").localeCompare(b?.id ?? ""));
    const firstPart = sortedParts[0];
    if (!firstPart) continue;

    const firstIsThinking = THINKING_TYPES.has(firstPart.type);

    if (!firstIsThinking) {
      result.push(msg.id);
    }
  }

  return result;
}

export function prependThinkingPart(sessionID: string, messageID: string): boolean {
  const partDir = join(PART_STORAGE, messageID);

  try {
    if (!existsSync(partDir)) {
      mkdirSync(partDir, { recursive: true });
    }

    const partId = "prt_0000000000_thinking";
    const part = {
      id: partId,
      sessionID,
      messageID,
      type: "thinking",
      thinking: "",
      synthetic: true,
    };

    writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function stripThinkingParts(messageID: string, sessionID?: string): boolean {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) return false;

  let anyRemoved = false;
  let discoveredSessionID = sessionID;

  try {
    for (const file of readdirSync(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = join(partDir, file);
        const content = readFileSync(filePath, "utf-8");
        const part = JSON.parse(content) as StoredPart;
        if (!part || typeof part !== "object") continue;

        if (part.sessionID && !discoveredSessionID) {
          discoveredSessionID = part.sessionID;
        }

        if (THINKING_TYPES.has(part.type)) {
          unlinkSync(filePath);
          anyRemoved = true;
        }
      } catch {
        continue;
      }
    }

    if (anyRemoved) {
      const sID = discoveredSessionID || "";
      if (!messageHasContent(sID, messageID)) {
        injectTextPart(sID, messageID, "[Thinking stripped]");
      }
    }
  } catch {
    return false;
  }

  return anyRemoved;
}

// =============================================================================
// Empty Message Recovery
// =============================================================================

export function findEmptyMessages(sessionID: string): string[] {
  const messages = readMessages(sessionID);
  const emptyIds: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !msg.id) continue;
    if (!messageHasContent(sessionID, msg.id)) {
      emptyIds.push(msg.id);
    }
  }

  return emptyIds;
}

export function findEmptyMessageByIndex(sessionID: string, targetIndex: number): string | null {
  const messages = readMessages(sessionID);

  // API index may differ from storage index due to system messages
  const indicesToTry = [targetIndex, targetIndex - 1, targetIndex - 2];

  for (const idx of indicesToTry) {
    if (idx < 0 || idx >= messages.length) continue;

    const targetMsg = messages[idx];
    if (!targetMsg || typeof targetMsg !== "object" || !targetMsg.id) continue;

    if (!messageHasContent(sessionID, targetMsg.id)) {
      return targetMsg.id;
    }
  }

  return null;
}

export function findMessageByIndexNeedingThinking(sessionID: string, targetIndex: number): string | null {
  const messages = readMessages(sessionID);

  if (targetIndex < 0 || targetIndex >= messages.length) return null;

  const targetMsg = messages[targetIndex];
  if (!targetMsg || typeof targetMsg !== "object" || targetMsg.role !== "assistant" || !targetMsg.id) return null;

  const parts = readParts(targetMsg.id);
  if (parts.length === 0) return null;

  const contentParts = parts.filter(
    (p) => p && typeof p === "object" && !META_TYPES.has(p.type)
  );
  if (contentParts.length === 0) return null;

  const sortedParts = [...contentParts].sort((a, b) => (a?.id ?? "").localeCompare(b?.id ?? ""));
  const firstPart = sortedParts[0];
  if (!firstPart) return null;

  const firstIsThinking = THINKING_TYPES.has(firstPart.type);

  if (!firstIsThinking) {
    return targetMsg.id;
  }

  return null;
}

export function replaceEmptyTextParts(messageID: string, replacementText: string): boolean {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) return false;

  let anyReplaced = false;
  try {
    for (const file of readdirSync(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = join(partDir, file);
        const content = readFileSync(filePath, "utf-8");
        const part = JSON.parse(content) as StoredPart;
        if (!part || typeof part !== "object") continue;

        if (part.type === "text") {
          const textPart = part as StoredTextPart;
          if (!textPart.text?.trim()) {
            textPart.text = replacementText;
            textPart.synthetic = true;
            writeFileSync(filePath, JSON.stringify(textPart, null, 2));
            anyReplaced = true;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }

  return anyReplaced;
}

export function findMessagesWithEmptyTextParts(sessionID: string): string[] {
  const messages = readMessages(sessionID);
  const result: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || !msg.id) continue;
    const parts = readParts(msg.id);
    const hasEmptyTextPart = parts.some((p) => {
      if (!p || typeof p !== "object") return false;
      if (p.type !== "text") return false;
      const textPart = p as StoredTextPart;
      return !textPart.text?.trim();
    });

    if (hasEmptyTextPart) {
      result.push(msg.id);
    }
  }

  return result;
}
