import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Message } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
  type AgentStoreSnapshot,
  buildStuffPrefix,
  CURSOR_STATE_ENTRY_TYPE,
  countUncoveredHistoryEntries,
  findLatestStateSnapshot,
  planCheckpointContinuity,
  prefixTrailingUserMessages,
  resolveCoveredBranchIndex,
  selectGapMessagesFromContext,
  splitTrailingUserMessages,
} from "../../../src/bridge/pi-to-cursor/checkpoint-sync.js";

const ASSISTANT_DEFAULTS = {
  api: "cursor-agent",
  provider: "cursor-agent",
  model: "default",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
};

function userMsg(text: string, timestamp: number): Message {
  return { role: "user", content: text, timestamp };
}

function assistantMsg(text: string, timestamp: number): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    ...ASSISTANT_DEFAULTS,
  };
}

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  parentId: string | null = null,
): SessionEntry {
  if (role === "user") {
    return {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text, timestamp: Date.now() },
    };
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      ...ASSISTANT_DEFAULTS,
    },
  };
}

function stateEntry(
  id: string,
  snapshot: AgentStoreSnapshot,
  parentId: string | null = null,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: CURSOR_STATE_ENTRY_TYPE,
    data: snapshot,
  };
}

test("splitTrailingUserMessages keeps only trailing users", () => {
  const messages = [
    userMsg("a", 1),
    assistantMsg("b", 2),
    userMsg("c", 3),
    userMsg("d", 4),
  ];
  const { history, trailingUser } = splitTrailingUserMessages(messages);
  assert.equal(history.length, 2);
  assert.equal(trailingUser.length, 2);
  assert.equal((trailingUser[0] as { content: string }).content, "c");
});

test("countUncoveredHistoryEntries excludes trailing users", () => {
  const entries: SessionEntry[] = [
    messageEntry("u1", "user", "hi"),
    messageEntry("a1", "assistant", "hello", "u1"),
    stateEntry(
      "s1",
      {
        version: 1,
        agentId: "ag",
        latestRootBlobId: "ab",
        coveredEntryId: "a1",
      },
      "a1",
    ),
    messageEntry("u2", "user", "openai turn", "s1"),
    messageEntry("a2", "assistant", "openai reply", "u2"),
    messageEntry("u3", "user", "back to cursor", "a2"),
  ];

  const covered = resolveCoveredBranchIndex(
    entries,
    { version: 1, agentId: "ag", latestRootBlobId: "ab", coveredEntryId: "a1" },
    2,
  );
  assert.equal(covered, 1); // index of a1
  assert.equal(countUncoveredHistoryEntries(entries, covered), 2); // u2, a2
});

test("positional fallback covers assistant after mid-stream state flush", () => {
  const entries: SessionEntry[] = [
    messageEntry("u1", "user", "hi"),
    stateEntry(
      "s1",
      { version: 1, agentId: "ag", latestRootBlobId: "ab" },
      "u1",
    ),
    // Assistant lands after state flush (common stream ordering).
    messageEntry("a1", "assistant", "hello", "s1"),
    messageEntry("u2", "user", "foreign", "a1"),
    messageEntry("a2", "assistant", "reply", "u2"),
    messageEntry("u3", "user", "next", "a2"),
  ];
  const found = findLatestStateSnapshot(entries);
  assert.ok(found);
  const covered = resolveCoveredBranchIndex(
    entries,
    found.snapshot,
    found.index,
  );
  assert.equal(covered, 2); // a1
  assert.equal(countUncoveredHistoryEntries(entries, covered), 2); // u2, a2
});

test("fresh branch with only trailing user is not stale", () => {
  const entries: SessionEntry[] = [
    messageEntry("u1", "user", "hi"),
    messageEntry("a1", "assistant", "ok", "u1"),
    stateEntry(
      "s1",
      {
        version: 1,
        agentId: "ag",
        latestRootBlobId: "ab",
        coveredEntryId: "a1",
      },
      "a1",
    ),
    messageEntry("u2", "user", "next cursor question", "s1"),
  ];
  const context = {
    systemPrompt: "sys",
    messages: [
      userMsg("hi", 1),
      assistantMsg("ok", 2),
      userMsg("next cursor question", 3),
    ],
  } satisfies Context;

  const plan = planCheckpointContinuity({ branch: entries, context });
  assert.equal(plan.stale, false);
  assert.equal(plan.uncoveredCount, 0);
  assert.equal(plan.stuffPrefix, "");
});

test("stale after foreign messages plans stuff + uncovered count", () => {
  const entries: SessionEntry[] = [
    messageEntry("u1", "user", "hi"),
    messageEntry("a1", "assistant", "ok", "u1"),
    stateEntry(
      "s1",
      {
        version: 1,
        agentId: "ag",
        latestRootBlobId: "ab",
        coveredEntryId: "a1",
      },
      "a1",
    ),
    messageEntry("u2", "user", "Remember MAGIC=424242", "s1"),
    messageEntry("a2", "assistant", "OK", "u2"),
    messageEntry("u3", "user", "what is MAGIC?", "a2"),
  ];
  const context = {
    systemPrompt: "sys",
    messages: [
      userMsg("hi", 1),
      assistantMsg("ok", 2),
      userMsg("Remember MAGIC=424242", 3),
      assistantMsg("OK", 4),
      userMsg("what is MAGIC?", 5),
    ],
  } satisfies Context;

  const plan = planCheckpointContinuity({ branch: entries, context });
  assert.equal(plan.stale, true);
  assert.equal(plan.uncoveredCount, 2);
  assert.match(plan.stuffPrefix, /424242/);
  assert.match(plan.stuffPrefix, /Pi conversation context/);
  assert.match(plan.stuffPrefix, /End context/);
  assert.doesNotMatch(plan.stuffPrefix, /what is MAGIC/);
});

test("selectGapMessagesFromContext takes last N history messages", () => {
  const messages = [
    userMsg("old", 1),
    assistantMsg("old-a", 2),
    userMsg("gap-u", 3),
    assistantMsg("gap-a", 4),
    userMsg("ask", 5),
  ];
  const gap = selectGapMessagesFromContext(messages, 2);
  assert.equal(gap.length, 2);
  assert.equal((gap[0] as { content: string }).content, "gap-u");
  assert.equal(
    ((gap[1] as AssistantLike).content[0] as { text: string }).text,
    "gap-a",
  );
});

type AssistantLike = { content: Array<{ text: string }> };

test("prefixTrailingUserMessages prefixes first trailing user only", () => {
  const messages = [
    userMsg("hist", 1),
    assistantMsg("ok", 2),
    userMsg("a", 3),
    userMsg("b", 4),
  ];
  const out = prefixTrailingUserMessages(messages, "PREFIX\n");
  assert.equal(out.length, 4);
  assert.equal((out[2] as { content: string }).content, "PREFIX\na");
  assert.equal((out[3] as { content: string }).content, "b");
});

test("buildStuffPrefix truncates oversized gap from the head", () => {
  const big = "x".repeat(50_000);
  const messages = [
    userMsg(`first ${big}`, 1),
    assistantMsg(`second ${big}`, 2),
    userMsg(`third ${big}`, 3),
  ];
  const prefix = buildStuffPrefix(messages, 10_000);
  assert.ok(prefix.length < 12_000);
  assert.match(prefix, /truncated/i);
  assert.match(prefix, /End context/);
});

test("stuff formatting omits assistant thinking blocks", () => {
  const messages: Message[] = [
    userMsg("hi", 1),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret internal monologue XYZ" },
        { type: "text", text: "Hello" },
      ],
      timestamp: 2,
      ...ASSISTANT_DEFAULTS,
    },
  ];
  const prefix = buildStuffPrefix(messages);
  assert.match(prefix, /Hello/);
  assert.doesNotMatch(prefix, /internal monologue/);
  assert.doesNotMatch(prefix, /XYZ/);
});
