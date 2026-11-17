import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { toolResultToText } from "../shared/tool-result";

export const STUFF_GAP_CHAR_CAP = 100_000;

export const CURSOR_STATE_ENTRY_TYPE = "pi-cursor-agent:state";

export interface AgentStoreSnapshot {
  version: 1;
  agentId: string;
  latestRootBlobId: string;
  conversationState?: string;
  coveredEntryId?: string;
}

const STUFF_HEADER =
  "[Pi conversation context — messages not in Cursor checkpoint]";
const STUFF_FOOTER = "[End context]";

export function isAgentStoreSnapshot(
  value: unknown,
): value is AgentStoreSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshot = value as Partial<AgentStoreSnapshot>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.agentId === "string" &&
    typeof snapshot.latestRootBlobId === "string"
  );
}

export function findLatestStateSnapshot(
  entries: SessionEntry[],
): { snapshot: AgentStoreSnapshot; index: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "custom" || e.customType !== CURSOR_STATE_ENTRY_TYPE) {
      continue;
    }
    if (isAgentStoreSnapshot(e.data)) {
      return { snapshot: e.data, index: i };
    }
  }
  return null;
}

function isContextMessageEntry(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const role = entry.message.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function isUserMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

/** Indices of trailing user message entries (ignore non-message entries after them). */
export function findTrailingUserEntryIndices(
  entries: SessionEntry[],
): number[] {
  const indices: number[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type !== "message") continue;
    if (!isUserMessageEntry(entry)) break;
    indices.unshift(i);
  }
  return indices;
}

/**
 * Resolve the branch index that is covered (inclusive). Messages after this
 * index may be part of the gap. Returns -1 when nothing is covered yet.
 */
export function resolveCoveredBranchIndex(
  entries: SessionEntry[],
  snapshot: AgentStoreSnapshot | null,
  stateEntryIndex: number | null,
): number {
  if (snapshot?.coveredEntryId) {
    const idx = entries.findIndex((e) => e?.id === snapshot.coveredEntryId);
    if (idx >= 0) return idx;
  }
  if (stateEntryIndex !== null && stateEntryIndex >= 0) {
    // Positional fallback: state is often flushed mid-stream *before* the
    // assistant message is appended. Treat following assistant/toolResult
    // entries (until the next user) as still covered by that Cursor turn.
    let covered = stateEntryIndex;
    for (let i = stateEntryIndex + 1; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.type !== "message") continue;
      const role = entry.message.role;
      if (role === "assistant" || role === "toolResult") {
        covered = i;
        continue;
      }
      break;
    }
    return covered;
  }
  return -1;
}

/** Count of uncovered history message entries (excludes trailing user action). */
export function countUncoveredHistoryEntries(
  entries: SessionEntry[],
  coveredIndex: number,
): number {
  const trailing = new Set(findTrailingUserEntryIndices(entries));
  let count = 0;
  for (let i = coveredIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !isContextMessageEntry(entry)) continue;
    if (trailing.has(i)) continue;
    count++;
  }
  return count;
}

export function splitTrailingUserMessages(messages: Message[]): {
  history: Message[];
  trailingUser: Message[];
} {
  const trailingUser: Message[] = [];
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") break;
    trailingUser.unshift(message);
  }
  return {
    history: messages.slice(0, i + 1),
    trailingUser,
  };
}

export function selectGapMessagesFromContext(
  messages: Message[],
  uncoveredCount: number,
): Message[] {
  if (uncoveredCount <= 0) return [];
  const { history } = splitTrailingUserMessages(messages);
  if (history.length === 0) return [];
  if (uncoveredCount >= history.length) return history;
  return history.slice(history.length - uncoveredCount);
}

function formatAssistantMessage(msg: AssistantMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as unknown as Record<string, unknown>;
    switch (b["type"]) {
      case "text":
        if (b["text"]) parts.push(String(b["text"]));
        break;
      case "toolCall":
        parts.push(`[Tool: ${String(b["name"] || "unknown")}]`);
        break;
      case "thinking":
        // Never stuff chain-of-thought into Cursor user messages.
        break;
      default:
        break;
    }
  }
  return parts.join("\n\n");
}

function formatUserContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push((block as TextContent).text);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

export function formatMessageForStuff(message: Message): string | null {
  switch (message.role) {
    case "user": {
      const text = formatUserContent(message.content).trim();
      return text ? `User: ${text}` : null;
    }
    case "assistant": {
      const text = formatAssistantMessage(message as AssistantMessage).trim();
      return text ? `Assistant: ${text}` : null;
    }
    case "toolResult": {
      const text = toolResultToText(message as ToolResultMessage).trim();
      const label = (message as ToolResultMessage).isError
        ? "Tool error"
        : "Tool result";
      return text ? `${label}: ${text}` : null;
    }
    default:
      // Skip bare system / unknown roles
      return null;
  }
}

export function buildStuffPrefix(
  gapMessages: Message[],
  charCap = STUFF_GAP_CHAR_CAP,
): string {
  const lines: string[] = [];
  for (const message of gapMessages) {
    const line = formatMessageForStuff(message);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return "";

  let body = lines.join("\n\n");
  let truncated = false;
  if (body.length > charCap) {
    body = body.slice(body.length - charCap);
    truncated = true;
  }

  const parts = [STUFF_HEADER];
  if (truncated) {
    parts.push("[... earlier gap messages truncated ...]");
  }
  parts.push(body, "", STUFF_FOOTER, "");
  return parts.join("\n");
}

export function prefixTrailingUserMessages(
  messages: Message[],
  prefix: string,
): Message[] {
  if (!prefix) return messages;
  const { history, trailingUser } = splitTrailingUserMessages(messages);
  if (trailingUser.length === 0) return messages;

  const [first, ...rest] = trailingUser;
  if (!first || first.role !== "user") return messages;

  let nextFirst: Message;
  if (typeof first.content === "string") {
    nextFirst = { ...first, content: `${prefix}${first.content}` };
  } else {
    const blocks = [...first.content];
    const firstTextIdx = blocks.findIndex((b) => b.type === "text");
    if (firstTextIdx >= 0) {
      const textBlock = blocks[firstTextIdx] as TextContent;
      blocks[firstTextIdx] = {
        ...textBlock,
        text: `${prefix}${textBlock.text}`,
      };
    } else {
      blocks.unshift({ type: "text", text: prefix });
    }
    nextFirst = { ...first, content: blocks };
  }

  return [...history, nextFirst, ...rest];
}

export function contextWithStuffedUserMessage(
  context: Context,
  prefix: string,
): Context {
  if (!prefix) return context;
  return {
    ...context,
    messages: prefixTrailingUserMessages(context.messages, prefix),
  };
}

export interface ContinuityPlan {
  /** Whether to mint a new conversation/agent id and stuff the gap. */
  stale: boolean;
  uncoveredCount: number;
  gapMessages: Message[];
  stuffPrefix: string;
  snapshot: AgentStoreSnapshot | null;
}

/**
 * Decide continuity for the next Cursor run from the Pi branch + context.
 */
export function planCheckpointContinuity(options: {
  branch: SessionEntry[];
  context: Context;
}): ContinuityPlan {
  const found = findLatestStateSnapshot(options.branch);
  const snapshot = found?.snapshot ?? null;
  const coveredIndex = resolveCoveredBranchIndex(
    options.branch,
    snapshot,
    found?.index ?? null,
  );
  const uncoveredCount = countUncoveredHistoryEntries(
    options.branch,
    coveredIndex,
  );
  const gapMessages = selectGapMessagesFromContext(
    options.context.messages,
    uncoveredCount,
  );
  const stuffPrefix = buildStuffPrefix(gapMessages);
  // Any uncovered history is stale even if formatting produced no text
  // (still mint id; native checkpoint is kept separately).
  const stale = uncoveredCount > 0;

  return {
    stale,
    uncoveredCount,
    gapMessages,
    stuffPrefix: stale ? stuffPrefix : "",
    snapshot,
  };
}
