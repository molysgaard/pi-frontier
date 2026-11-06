import { createWritableIterable } from "@connectrpc/connect/protocol";
import {
  AgentClientMessage,
  AgentRunRequest,
  type AgentServerMessage,
  ClientHeartbeat,
  ConversationAction,
  type ConversationStateStructure,
  type InteractionResponse,
  type ModelDetails,
  ResumeAction,
} from "../../__generated__/agent/v1/agent_pb";
import {
  ExecClientControlMessage,
  ExecClientMessage,
} from "../../__generated__/agent/v1/exec_pb";
import type { KvClientMessage } from "../../__generated__/agent/v1/kv_pb";
import type { McpTools } from "../../__generated__/agent/v1/mcp_pb";
import {
  ActivityTrackingStallDetector,
  debugLogTransport,
  serializeErrorForDebug,
} from "../../lib/transport-debug";
import type { ResourceAccessor } from "../agent-exec/registry-resource-accessor";
import { SimpleControlledExecManager } from "../agent-exec/simple-controlled-exec-manager";
import { type BlobStore, ControlledKvManager } from "../agent-kv";
import { MapWritable } from "../utils";
import {
  CheckpointController,
  type CheckpointHandler,
} from "./checkpoint-controller";
import { ClientExecController, LostConnection } from "./exec-controller";
import {
  ClientInteractionController,
  type InteractionListener,
} from "./interaction-controller";
import { type SplitChannels, splitStream } from "./split-stream";

export interface AgentRpcClient {
  run(
    input: AsyncIterable<AgentClientMessage>,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): AsyncIterable<AgentServerMessage>;
}

export interface AgentConnectDebugContext {
  sessionId?: string;
  conversationId?: string;
  clientVersion?: string;
  modelId?: string;
}

export interface AgentConnectRunOptions {
  interactionListener: InteractionListener;
  resources: ResourceAccessor;
  blobStore: BlobStore;
  checkpointHandler: CheckpointHandler;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  onConnectionStateChange?: (state: {
    state: "reconnecting" | "connected";
  }) => void;
  debugContext?: AgentConnectDebugContext;
}

const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Transport failure substrings treated as retriable by native cursor-agent.
 * Matched against error.message and nested cause messages.
 */
const RETRIABLE_TRANSPORT_SUBSTRINGS = [
  "NGHTTP2",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "socket hang up",
  "Premature close",
  "UND_ERR_SOCKET",
  "ERR_STREAM",
  "protocol error",
  "http/2 stream",
  "ERR_HTTP2_SESSION_ERROR",
  "Session closed with error code",
  "connection aborted",
  "PING timed out",
] as const;

function collectErrorTexts(error: unknown): string[] {
  const texts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current) && texts.length < 8) {
    seen.add(current);
    if (current instanceof Error) {
      texts.push(current.message);
      const withCode = current as Error & {
        code?: unknown;
        rawMessage?: unknown;
      };
      if (typeof withCode.code === "string") texts.push(withCode.code);
      if (typeof withCode.rawMessage === "string") {
        texts.push(withCode.rawMessage);
      }
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    texts.push(String(current));
    break;
  }

  return texts;
}

/** Exported for unit tests — mirrors native cursor-agent transport retry policy. */
export function isRetriableTransportError(error: unknown): boolean {
  if (error instanceof LostConnection) return true;

  const texts = collectErrorTexts(error);
  return RETRIABLE_TRANSPORT_SUBSTRINGS.some((needle) =>
    texts.some((text) => text.includes(needle)),
  );
}

function isRetriableError(error: unknown): boolean {
  return isRetriableTransportError(error);
}

/**
 * Stream-close failures that often mean "peer finished the bidi stream"
 * rather than a mid-turn drop. Matched against message/cause text.
 */
const BENIGN_STREAM_END_SUBSTRINGS = [
  "Premature close",
  "ERR_STREAM_PREMATURE_CLOSE",
  "missing EndStreamResponse",
  "WriteIterableClosed",
] as const;

export function isBenignStreamEndError(error: unknown): boolean {
  if (error instanceof LostConnection) {
    return isBenignStreamEndError(new Error(error.message));
  }
  const texts = collectErrorTexts(error);
  return BENIGN_STREAM_END_SUBSTRINGS.some((needle) =>
    texts.some((text) => text.includes(needle)),
  );
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(1_000 * 2 ** attempt, 30_000);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface PendingConversationAction {
  key: string;
  action: ConversationAction;
}

function getUserActionMessageId(
  action: ConversationAction,
): string | undefined {
  if (action.action.case !== "userMessageAction") return undefined;
  return action.action.value.userMessage?.messageId || undefined;
}

function getConversationActionKey(action: ConversationAction): string {
  return getUserActionMessageId(action) ?? crypto.randomUUID();
}

export class AgentConnectClient {
  private readonly client: AgentRpcClient;
  private readonly pendingConversationActions: PendingConversationAction[] = [];
  private conversationActionWriter:
    | ((action: ConversationAction) => Promise<void>)
    | undefined;

  constructor(client: AgentRpcClient) {
    this.client = client;
  }

  async sendConversationAction(action: ConversationAction): Promise<void> {
    await this.sendConversationActions([action]);
  }

  async sendConversationActions(actions: ConversationAction[]): Promise<void> {
    const writer = this.conversationActionWriter;
    if (!writer) {
      throw new Error("Cursor conversation is not accepting new actions");
    }

    const pending: PendingConversationAction[] = [];
    for (const action of actions) {
      const key = getConversationActionKey(action);
      if (this.pendingConversationActions.some((item) => item.key === key)) {
        continue;
      }
      const item = { key, action };
      this.pendingConversationActions.push(item);
      pending.push(item);
    }

    for (const item of pending) {
      try {
        await writer(item.action);
      } catch {
        // Keep the action pending. The active run will either retry its
        // transport or replay unacknowledged actions from the latest checkpoint.
        return;
      }
    }
  }

  private acknowledgeUserMessage(messageId: string): void {
    const index = this.pendingConversationActions.findIndex(
      (item) => item.key === messageId,
    );
    if (index >= 0) this.pendingConversationActions.splice(index, 1);
  }

  /**
   * Public entry point with centralized retry and resume logic.
   *
   * Retry behavior:
   * - Transport/stall errors: retry indefinitely with exponential backoff
   * - Server errors (high load): retry up to MAX_SERVER_ERROR_RETRIES times
   * - Non-retriable errors: surface immediately
   *
   * Checkpoint behavior:
   * - If a NEW checkpoint was received before failure, resume from checkpoint
   * - If NO checkpoint was received, resend the original action (prevents message loss)
   */
  async run(
    initialRequest: AgentClientMessage,
    options: AgentConnectRunOptions,
  ): Promise<void> {
    const runRequest = initialRequest.message.value as AgentRunRequest;
    const debugContext = {
      ...options.debugContext,
      conversationId:
        options.debugContext?.conversationId ?? runRequest.conversationId,
    };
    const activityTracker = new ActivityTrackingStallDetector();

    debugLogTransport("run.start", {
      ...debugContext,
      modelId:
        debugContext.modelId ??
        runRequest.modelDetails?.modelId ??
        undefined,
    });

    // Retry state
    let currentState = runRequest.conversationState;
    let currentAction = runRequest.action;
    if (!currentAction) {
      throw new Error("runRequest.action is required");
    }
    const modelDetails = runRequest.modelDetails;
    const mcpTools = runRequest.mcpTools;
    const conversationId = runRequest.conversationId;
    let attempt = 0;
    let unacknowledgedClosureKey: string | undefined;
    let unacknowledgedClosureAttempts = 0;
    const receivedNewCheckpoint = { value: false };
    const sawTurnEnded = { value: false };
    const runStartedAt = Date.now();

    // Helper: switch to ResumeAction if we received a checkpoint
    const maybeResumeFromCheckpoint = () => {
      if (!receivedNewCheckpoint.value) return;
      const checkpoint = options.checkpointHandler.getLatestCheckpoint?.();
      if (!checkpoint) return;
      currentState = checkpoint;
      currentAction = new ConversationAction({
        action: { case: "resumeAction", value: new ResumeAction() },
      });
    };

    const trackingInteractionListener: InteractionListener = {
      sendUpdate: async (ctx, update) => {
        if (update.type === "user-message-appended") {
          sawTurnEnded.value = false;
          const messageId = (update.userMessage as { messageId?: unknown })
            .messageId;
          if (typeof messageId === "string") {
            this.acknowledgeUserMessage(messageId);
          }
        } else if (update.type === "turn-ended") {
          sawTurnEnded.value = true;
        }
        await options.interactionListener.sendUpdate(ctx, update);
      },
      query: (ctx, query) => options.interactionListener.query(ctx, query),
    };

    // Wrap checkpoint handler to track when we receive new checkpoints
    const trackingCheckpointHandler: CheckpointHandler = {
      async handleCheckpoint(
        ctx: unknown,
        checkpoint: ConversationStateStructure,
      ): Promise<void> {
        receivedNewCheckpoint.value = true;
        return options.checkpointHandler.handleCheckpoint(ctx, checkpoint);
      },
      getLatestCheckpoint: () =>
        options.checkpointHandler.getLatestCheckpoint?.(),
    };

    // Main retry loop
    while (true) {
      if (options.signal?.aborted) {
        throw new Error("Request cancelled");
      }

      // Reset per-attempt flags
      receivedNewCheckpoint.value = false;

      try {
        const request = this.buildRequest(
          currentState,
          currentAction,
          modelDetails,
          mcpTools,
          conversationId,
        );

        await this.runInternal(request, {
          ...options,
          interactionListener: trackingInteractionListener,
          checkpointHandler: trackingCheckpointHandler,
          activityTracker,
        });

        const pending = this.pendingConversationActions[0];
        if (!pending) {
          debugLogTransport("run.end", {
            ...debugContext,
            reason: "completed",
            durationMs: Date.now() - runStartedAt,
            attempt,
          });
          return;
        }

        const checkpoint = options.checkpointHandler.getLatestCheckpoint?.();
        if (!checkpoint) {
          throw new Error(
            "Cursor closed before acknowledging steering input and no checkpoint is available",
          );
        }

        if (unacknowledgedClosureKey === pending.key) {
          unacknowledgedClosureAttempts += 1;
        } else {
          unacknowledgedClosureKey = pending.key;
          unacknowledgedClosureAttempts = 1;
        }
        if (unacknowledgedClosureAttempts > MAX_RETRY_ATTEMPTS) {
          throw new Error(
            "Cursor repeatedly closed before acknowledging steering input",
          );
        }

        // Cursor closed before acknowledging this action. Re-open from its
        // latest checkpoint with the same action and message ID as the initial
        // action. Keep it pending until Cursor explicitly appends it.
        currentState = checkpoint;
        currentAction = pending.action;
        attempt = 0;
      } catch (error) {
        const pendingCount = this.pendingConversationActions.length;
        // After Cursor sends turn_ended, the HTTP/2 stream often closes with
        // Premature close / missing EndStream. Retrying ResumeAction there
        // restarts the agent and stacks zombie "interrupted" turns.
        if (
          isBenignStreamEndError(error) &&
          sawTurnEnded.value &&
          pendingCount === 0
        ) {
          debugLogTransport("run.end", {
            ...debugContext,
            reason: "completed_after_turn_ended_stream_close",
            durationMs: Date.now() - runStartedAt,
            attempt,
            sawTurnEnded: true,
            ...serializeErrorForDebug(error),
            activity: activityTracker.snapshot(),
          });
          return;
        }

        const retriable = isRetriableError(error);
        const willRetry = retriable && attempt < MAX_RETRY_ATTEMPTS;

        debugLogTransport("transport.error", {
          ...debugContext,
          ...serializeErrorForDebug(error),
          isRetriable: retriable,
          willRetry,
          sawTurnEnded: sawTurnEnded.value,
          pendingCount,
          attempt,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          activity: activityTracker.snapshot(),
        });

        if (!willRetry) {
          debugLogTransport("run.end", {
            ...debugContext,
            reason: "error",
            durationMs: Date.now() - runStartedAt,
            attempt,
            sawTurnEnded: sawTurnEnded.value,
            ...serializeErrorForDebug(error),
          });
          throw error;
        }

        // Retry: notify UI, maybe resume from checkpoint, backoff
        attempt++;
        const delayMs = Math.min(1_000 * 2 ** attempt, 30_000);
        debugLogTransport("transport.retry", {
          ...debugContext,
          attempt,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          backoffMs: delayMs,
          resumeFromCheckpoint: receivedNewCheckpoint.value,
          sawTurnEnded: sawTurnEnded.value,
          activity: activityTracker.snapshot(),
        });
        options.onConnectionStateChange?.({ state: "reconnecting" });
        maybeResumeFromCheckpoint();

        await backoff(attempt, options.signal);
      }
    }
  }

  private buildRequest(
    conversationState: ConversationStateStructure | undefined,
    action: ConversationAction,
    modelDetails: ModelDetails | undefined,
    mcpTools: McpTools | undefined,
    conversationId: string | undefined,
  ): AgentClientMessage {
    return new AgentClientMessage({
      message: {
        case: "runRequest",
        value: new AgentRunRequest({
          ...(conversationState ? { conversationState } : {}),
          action,
          ...(modelDetails ? { modelDetails } : {}),
          ...(mcpTools ? { mcpTools } : {}),
          ...(conversationId ? { conversationId } : {}),
        }),
      },
    });
  }

  /**
   * Internal implementation that may throw any error type.
   * All errors are caught and converted at the public `run` boundary.
   */
  private async runInternal(
    initialRequest: AgentClientMessage,
    options: AgentConnectRunOptions & {
      activityTracker: ActivityTrackingStallDetector;
    },
  ): Promise<void> {
    const controlledExecManager = SimpleControlledExecManager.fromResources(
      options.resources,
    );

    const stallDetector = options.activityTracker;

    const baseRequestStream = createWritableIterable<AgentClientMessage>();

    void baseRequestStream.write(initialRequest);

    const conversationActionWriter = (action: ConversationAction) =>
      baseRequestStream.write(
        new AgentClientMessage({
          message: { case: "conversationAction", value: action },
        }),
      );
    this.conversationActionWriter = conversationActionWriter;

    const runOptions: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
    } = {};
    if (options.signal) runOptions.signal = options.signal;
    if (options.headers) runOptions.headers = options.headers;

    const response = this.client.run(baseRequestStream, runOptions);
    const initialAction = (initialRequest.message.value as AgentRunRequest)
      .action;
    const initialUserMessageId = initialAction
      ? getUserActionMessageId(initialAction)
      : undefined;

    for (const pending of this.pendingConversationActions) {
      if (pending.key === initialUserMessageId) continue;
      void conversationActionWriter(pending.action).catch(() => {});
    }

    const channels: SplitChannels = splitStream(response, stallDetector, () =>
      options.onConnectionStateChange?.({ state: "connected" }),
    );

    // Heartbeat sender using setTimeout (not setInterval)
    let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;

    const scheduleHeartbeat = () => {
      heartbeatTimeout = setTimeout(() => {
        baseRequestStream
          .write(
            new AgentClientMessage({
              message: {
                case: "clientHeartbeat",
                value: new ClientHeartbeat(),
              },
            }),
          )
          .then(scheduleHeartbeat)
          .catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
    };

    const clearHeartbeat = () => {
      if (heartbeatTimeout !== undefined) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = undefined;
      }
    };

    scheduleHeartbeat();

    try {
      const execOutputStream = new MapWritable<
        ExecClientMessage | ExecClientControlMessage,
        AgentClientMessage
      >(baseRequestStream, (message) => {
        if (message instanceof ExecClientMessage) {
          return new AgentClientMessage({
            message: { case: "execClientMessage", value: message },
          });
        }
        if (message instanceof ExecClientControlMessage) {
          return new AgentClientMessage({
            message: { case: "execClientControlMessage", value: message },
          });
        }
        throw new Error("Unknown exec message type");
      });

      const kvOutputStream = new MapWritable<
        KvClientMessage,
        AgentClientMessage
      >(
        baseRequestStream,
        (message) =>
          new AgentClientMessage({
            message: { case: "kvClientMessage", value: message },
          }),
      );

      const queryResponseStream = new MapWritable<
        InteractionResponse,
        AgentClientMessage
      >(
        baseRequestStream,
        (response) =>
          new AgentClientMessage({
            message: { case: "interactionResponse", value: response },
          }),
      );

      const interactionController = new ClientInteractionController(
        channels.interactionStream,
        options.interactionListener,
        queryResponseStream,
      );

      const execController = new ClientExecController(
        channels.execStream,
        execOutputStream,
        controlledExecManager,
      );

      const kvManager = new ControlledKvManager(
        channels.kvStream,
        kvOutputStream,
        options.blobStore,
      );

      const checkpointController = new CheckpointController(
        channels.checkpointStream,
        options.checkpointHandler,
        null,
      );

      const ctx = null;

      const results = await Promise.allSettled([
        channels.done.finally(() => {
          clearHeartbeat();
          execOutputStream.close();
        }),
        execController.run(ctx),
        interactionController.run(ctx),
        checkpointController.run(),
        kvManager.run(ctx),
      ]);

      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    } finally {
      clearHeartbeat();
      if (this.conversationActionWriter === conversationActionWriter) {
        this.conversationActionWriter = undefined;
      }
      baseRequestStream.close();
    }
  }
}
