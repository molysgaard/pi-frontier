/**
 * Live probe: conversationId reuse vs mint after a full-rebuild state.
 *
 * Usage (from pi-cursor-agent package root):
 *   PI_CURSOR_PROBE_MODEL=default ./node_modules/.bin/tsx ./scripts/conversation-id-probe.ts
 *
 * Reads ~/.pi/agent/auth.json → cursor-agent.access (never prints the token).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Message, Model } from "@mariozechner/pi-ai";
import {
  AgentConversationTurnStructure,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} from "../src/__generated__/agent/v1/agent_pb.js";
import {
  AskQuestionRejected,
  AskQuestionResult,
} from "../src/__generated__/agent/v1/ask_question_tool_pb.js";
import AgentService from "../src/api/agent-service.js";
import { LocalResourceProvider } from "../src/bridge/cursor-to-pi/local-resource-provider/index.js";
import { buildRunRequest } from "../src/bridge/pi-to-cursor/request-builder.js";
import { CURSOR_API_URL, CURSOR_CLIENT_VERSION } from "../src/lib/env.js";
import {
  AgentConnectClient,
  type CheckpointHandler,
  type InteractionListener,
} from "../src/vendor/agent-client/index.js";
import type { CoreInteractionUpdate } from "../src/vendor/agent-core/index.js";
import {
  getBlobId,
  InMemoryBlobStore,
} from "../src/vendor/agent-kv/index.js";

const MODEL_ID = process.env.PI_CURSOR_PROBE_MODEL ?? "default";
const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");

const SECRET_ALPHA = "ALPHA_PROBE_7f3a";
const SECRET_BETA = "BETA_PROBE_9c1e";
const MAGIC_BETA = "424242";

type ProbeResult = {
  name: string;
  conversationId: string;
  ok: boolean;
  text: string;
  error?: string;
  checkpointTurns?: number;
  sawTurnEnded: boolean;
  localTurnTexts?: string[];
};

function formatError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const anyErr = e as Error & {
    code?: unknown;
    details?: unknown;
    rawMessage?: unknown;
    cause?: unknown;
  };
  const parts = [e.name, e.message];
  if (anyErr.code !== undefined) parts.push(`code=${String(anyErr.code)}`);
  if (anyErr.details !== undefined) {
    try {
      const details = anyErr.details as Array<{
        debug?: { error?: string; details?: { title?: string; detail?: string } };
      }>;
      const dbg = details[0]?.debug;
      if (dbg?.error) parts.push(`err=${dbg.error}`);
      if (dbg?.details?.title) parts.push(`title=${dbg.details.title}`);
      if (dbg?.details?.detail) {
        parts.push(`detail=${dbg.details.detail.slice(0, 200)}`);
      }
    } catch {
      parts.push(`details=${String(anyErr.details)}`);
    }
  }
  return parts.join(" | ");
}

function loadAccessToken(): string {
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
    string,
    { access?: string }
  >;
  const token = raw["cursor-agent"]?.access;
  if (!token) throw new Error(`No cursor-agent.access in ${AUTH_PATH}`);
  return token;
}

function createInteractionListener(
  onUpdate: (update: CoreInteractionUpdate) => void,
): InteractionListener {
  return {
    async sendUpdate(_ctx, update) {
      onUpdate(update);
    },
    async query(_ctx, query) {
      if (query.type === "ask-question-request") {
        return {
          result: new AskQuestionResult({
            result: {
              case: "rejected",
              value: new AskQuestionRejected({ reason: "probe" }),
            },
          }),
        };
      }
      return { approved: false, reason: "probe" };
    },
  };
}

function hex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

/** Decode turn user/assistant text from a ConversationStateStructure + blob store. */
function decodeTurnTexts(
  state: ConversationStateStructure,
  blobStore: InMemoryBlobStore,
): string[] {
  const out: string[] = [];
  for (const turnBlobId of state.turns) {
    const turnBytes = blobStore.store.get(hex(turnBlobId));
    if (!turnBytes) {
      out.push("[missing turn blob]");
      continue;
    }
    const turn = ConversationTurnStructure.fromBinary(turnBytes);
    if (turn.turn.case !== "agentConversationTurn") {
      out.push(`[turn case ${turn.turn.case}]`);
      continue;
    }
    const agentTurn = turn.turn.value as AgentConversationTurnStructure;
    const userBytes = blobStore.store.get(hex(agentTurn.userMessage));
    if (userBytes) {
      const user = UserMessage.fromBinary(userBytes);
      out.push(`user:${user.text}`);
    } else {
      out.push("user:[missing]");
    }
    for (const stepId of agentTurn.steps) {
      const stepBytes = blobStore.store.get(hex(stepId));
      if (!stepBytes) {
        out.push("step:[missing]");
        continue;
      }
      const step = ConversationStep.fromBinary(stepBytes);
      if (step.message.case === "assistantMessage") {
        out.push(`assistant:${step.message.value.text}`);
      } else {
        out.push(`step:${step.message.case}`);
      }
    }
  }
  return out;
}

async function runOnce(options: {
  name: string;
  accessToken: string;
  conversationId: string;
  messages: Message[];
  conversationState?: ConversationStateStructure;
  blobStore?: InMemoryBlobStore;
  systemPrompt?: string;
}): Promise<{
  result: ProbeResult;
  checkpoint: ConversationStateStructure | undefined;
  blobStore: InMemoryBlobStore;
  sentState: ConversationStateStructure;
}> {
  const blobStore = options.blobStore ?? new InMemoryBlobStore();
  let latestCheckpoint: ConversationStateStructure | undefined;
  const checkpointHandler: CheckpointHandler = {
    async handleCheckpoint(_ctx, checkpoint) {
      latestCheckpoint = checkpoint;
    },
    getLatestCheckpoint: () => latestCheckpoint,
  };

  const texts: string[] = [];
  let sawTurnEnded = false;
  const listener = createInteractionListener((update) => {
    if (update.type === "text-delta") texts.push(update.text);
    if (update.type === "turn-ended") sawTurnEnded = true;
  });

  const model = {
    id: MODEL_ID,
    name: MODEL_ID,
    provider: "cursor-agent",
    api: "cursor-agent",
  } as Model<"cursor-agent">;

  const context = {
    systemPrompt:
      options.systemPrompt ??
      "You are a probe assistant. Never use tools. Answer with only the requested token/digits.",
    messages: options.messages,
  } satisfies Context;

  const { initialRequest, conversationState: sentState } = buildRunRequest({
    model,
    context,
    conversationId: options.conversationId,
    blobStore,
    conversationState: options.conversationState,
    mcpToolDefinitions: [],
  });

  // Ensure sent-state root blobs exist in the store (buildRunRequest does this).
  void getBlobId;

  const localTurnTexts = decodeTurnTexts(sentState, blobStore);

  const agentService = new AgentService(CURSOR_API_URL, {
    accessToken: options.accessToken,
    clientVersion: CURSOR_CLIENT_VERSION,
    clientType: "cli",
  });
  const client = new AgentConnectClient(agentService.rpcClient);

  const resources = new LocalResourceProvider({
    ctx: {
      cwd: process.cwd(),
      getActiveTools: () => new Set(),
      getCtx: () => null,
    },
    requestContextTools: [],
  });

  let error: string | undefined;
  try {
    await client.run(initialRequest, {
      interactionListener: listener,
      resources,
      blobStore,
      checkpointHandler,
      debugContext: {
        sessionId: "conversation-id-probe",
        conversationId: options.conversationId,
        clientVersion: CURSOR_CLIENT_VERSION,
        modelId: MODEL_ID,
      },
    });
  } catch (e) {
    error = formatError(e);
  }

  const text = texts.join("");
  const result: ProbeResult = {
    name: options.name,
    conversationId: options.conversationId,
    ok: !error && sawTurnEnded,
    text,
    error,
    checkpointTurns: latestCheckpoint?.turns?.length,
    sawTurnEnded,
    localTurnTexts,
  };

  return { result, checkpoint: latestCheckpoint, blobStore, sentState };
}

function assistantText(text: string, timestamp: number): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    api: "cursor-agent",
    provider: "cursor-agent",
    model: MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

function printResult(r: ProbeResult) {
  console.log(`\n=== ${r.name} ===`);
  console.log(`conversationId: ${r.conversationId}`);
  console.log(
    `ok: ${r.ok}  turnEnded: ${r.sawTurnEnded}  checkpointTurns: ${r.checkpointTurns ?? "n/a"}`,
  );
  if (r.localTurnTexts) {
    console.log(`localSentTurns: ${JSON.stringify(r.localTurnTexts)}`);
  }
  if (r.error) console.log(`error: ${r.error}`);
  console.log(`text: ${JSON.stringify(r.text.slice(0, 500))}`);
  console.log(
    `contains ALPHA: ${r.text.includes(SECRET_ALPHA)}  BETA: ${r.text.includes(SECRET_BETA)}  MAGIC: ${r.text.includes(MAGIC_BETA)}`,
  );
}

async function main() {
  const accessToken = loadAccessToken();
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();

  console.log(`model: ${MODEL_ID}`);
  console.log(`clientVersion: ${CURSOR_CLIENT_VERSION}`);
  console.log(`idA: ${idA}`);
  console.log(`idB: ${idB}`);
  console.log(`secrets: ${SECRET_ALPHA} / ${SECRET_BETA} / magic ${MAGIC_BETA}`);

  // P1: native baseline on idA with secret ALPHA
  const p1 = await runOnce({
    name: "P1_native_alpha",
    accessToken,
    conversationId: idA,
    messages: [
      {
        role: "user",
        content: `Your only secret code is ${SECRET_ALPHA}. Reply with exactly: OK`,
        timestamp: 1,
      },
    ],
  });
  printResult(p1.result);

  // P4a: BEFORE mutating idA — resume P1 checkpoint with same blob store
  let p4a: Awaited<ReturnType<typeof runOnce>> | undefined;
  if (p1.checkpoint) {
    p4a = await runOnce({
      name: "P4a_reuse_id_native_checkpoint_before_rebuild",
      accessToken,
      conversationId: idA,
      conversationState: p1.checkpoint,
      blobStore: p1.blobStore,
      messages: [
        {
          role: "user",
          content:
            "What is your only secret code? Reply with only the code, nothing else.",
          timestamp: 10,
        },
      ],
    });
    printResult(p4a.result);
  }

  // P2: reuse idA, full rebuild with only BETA/magic history
  const betaMessages: Message[] = [
    {
      role: "user",
      content: `Remember these two values forever: secret=${SECRET_BETA} magic=${MAGIC_BETA}. Reply OK.`,
      timestamp: 1,
    },
    assistantText(`OK. Stored secret=${SECRET_BETA} magic=${MAGIC_BETA}.`, 2),
    {
      role: "user",
      content:
        "What is the magic value I asked you to remember? Reply with digits only.",
      timestamp: 3,
    },
  ];

  const p2 = await runOnce({
    name: "P2_reuse_id_rebuild_beta",
    accessToken,
    conversationId: idA,
    conversationState: undefined,
    messages: betaMessages,
  });
  printResult(p2.result);

  // P3: new idB, same BETA rebuild
  const p3 = await runOnce({
    name: "P3_mint_id_rebuild_beta",
    accessToken,
    conversationId: idB,
    conversationState: undefined,
    messages: betaMessages,
  });
  printResult(p3.result);

  // P4b: after P2, try P1 native checkpoint + P1 blobs again on idA
  let p4b: Awaited<ReturnType<typeof runOnce>> | undefined;
  if (p1.checkpoint) {
    p4b = await runOnce({
      name: "P4b_reuse_id_old_native_checkpoint_after_rebuild",
      accessToken,
      conversationId: idA,
      conversationState: p1.checkpoint,
      blobStore: p1.blobStore,
      messages: [
        {
          role: "user",
          content:
            "What is your only secret code? Reply with only the code, nothing else.",
          timestamp: 20,
        },
      ],
    });
    printResult(p4b.result);
  }

  // Decode P2/P3 *returned* checkpoints with their blob stores — did server keep BETA?
  if (p2.checkpoint) {
    const returned = decodeTurnTexts(p2.checkpoint, p2.blobStore);
    console.log(`\nP2 returnedCheckpointTurns: ${JSON.stringify(returned)}`);
  }
  if (p3.checkpoint) {
    const returned = decodeTurnTexts(p3.checkpoint, p3.blobStore);
    console.log(`P3 returnedCheckpointTurns: ${JSON.stringify(returned)}`);
  }

  // P5: no synthetic turns — stuff history into the single user message (mint id)
  const idC = crypto.randomUUID();
  const p5 = await runOnce({
    name: "P5_mint_id_stuffed_user_message",
    accessToken,
    conversationId: idC,
    messages: [
      {
        role: "user",
        content:
          `Prior chat transcript (for context only):\n` +
          `User: Remember magic=${MAGIC_BETA}\n` +
          `Assistant: OK\n\n` +
          `What is the magic value from the prior transcript? Digits only.`,
        timestamp: 1,
      },
    ],
  });
  printResult(p5.result);

  console.log("\n=== INTERPRETATION HINTS ===");
  if (p4a) {
    if (p4a.result.error) {
      console.log("P4a: native checkpoint resume failed even with blob store — bad for reuse.");
    } else if (p4a.result.text.includes(SECRET_ALPHA)) {
      console.log("P4a: native checkpoint + same id correctly recalls ALPHA.");
    } else {
      console.log("P4a: ran but did not echo ALPHA; inspect text.");
    }
  }

  const p2t = p2.result.text;
  const p3t = p3.result.text;
  if (p2.result.localTurnTexts?.some((t) => t.includes(SECRET_BETA))) {
    console.log("P2 local rebuild DID encode BETA into sent turns.");
  } else {
    console.log("P2 local rebuild did NOT encode BETA — client builder bug.");
  }

  if (p2.result.error) {
    console.log("P2 errored → reuse+rebuild problematic.");
  } else if (p2t.includes(MAGIC_BETA) || p2t.includes(SECRET_BETA)) {
    if (p2t.includes(SECRET_ALPHA)) {
      console.log("P2 mixed ALPHA+BETA → prefer mint.");
    } else {
      console.log("P2 saw BETA/magic with reused id → reuse-on-rebuild viable.");
    }
  } else if (p2t.includes(SECRET_ALPHA)) {
    console.log("P2 resurrected ALPHA despite BETA-only client state → MUST mint.");
  } else {
    console.log("P2 ran but ignored rebuilt history (neither secret) — rebuild visibility weak.");
  }

  if (p3.result.error) {
    console.log("P3 errored → rebuild path broken independent of id reuse.");
  } else if (p3t.includes(MAGIC_BETA) || p3t.includes(SECRET_BETA)) {
    console.log("P3 mint+rebuild saw BETA/magic → full rebuild works with new id.");
  } else {
    console.log("P3 mint+rebuild also ignored history → synthetic turns may not feed the model.");
  }

  if (p4b) {
    if (p4b.result.error) {
      console.log(
        "P4b: after rebuild on same id, old native checkpoint failed — " +
          (p4b.result.error.includes("missing")
            ? "missing blobs / conversation data."
            : "other error."),
      );
    } else if (p4b.result.text.includes(SECRET_ALPHA)) {
      console.log("P4b: old checkpoint still yields ALPHA after rebuild on same id.");
    } else if (
      p4b.result.text.includes(SECRET_BETA) ||
      p4b.result.text.includes(MAGIC_BETA)
    ) {
      console.log("P4b: got BETA with ALPHA checkpoint → server side-state; mint.");
    } else {
      console.log("P4b inconclusive; inspect text.");
    }
  }

  if (p5.result.text.includes(MAGIC_BETA)) {
    console.log("P5 stuffed user-message history works → fallback for foreign turns.");
  } else {
    console.log("P5 stuffed history also failed; inspect text.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
