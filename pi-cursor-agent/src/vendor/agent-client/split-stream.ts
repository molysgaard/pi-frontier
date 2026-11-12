import { createWritableIterable } from "@connectrpc/connect/protocol";
import type {
  AgentServerMessage,
  ConversationStateStructure,
  InteractionQuery,
  InteractionUpdate,
} from "../../__generated__/agent/v1/agent_pb";
import type {
  ExecServerControlMessage,
  ExecServerMessage,
} from "../../__generated__/agent/v1/exec_pb";
import type { KvServerMessage } from "../../__generated__/agent/v1/kv_pb";
import {
  isBenignStreamEndError,
  isRetriableTransportError,
} from "./transport-errors";

export type InteractionMessage =
  | { case: "interactionUpdate"; value: InteractionUpdate }
  | { case: "interactionQuery"; value: InteractionQuery };

export type ExecMessage = ExecServerMessage | ExecServerControlMessage;

/** Mirrors native cursor-agent checkpoint resume gating after turn_ended. */
export type ResumeEligibility = "eligible" | "ineligible_terminal_turn";

export type CheckpointStreamItem = {
  checkpoint: ConversationStateStructure;
  metadata: { resumeEligibility: ResumeEligibility };
};

export interface StallDetector {
  onServerSentHeartbeat(): void;
  reset(activityType: string, messageType: string): void;
  onStreamEnded(): void;
}

export interface SplitStreamOptions {
  onFirstMessage?: () => void;
  /** Fired synchronously when turn_ended is demuxed from the wire. */
  onTurnEnded?: () => void;
  signal?: AbortSignal;
  parentSignal?: AbortSignal;
}

export interface SplitChannels {
  interactionStream: AsyncIterable<InteractionMessage>;
  execStream: AsyncIterable<ExecMessage>;
  checkpointStream: AsyncIterable<CheckpointStreamItem>;
  kvStream: AsyncIterable<KvServerMessage>;
  done: Promise<void>;
}

function getMessageTypeLabelForStallDetector(
  message: AgentServerMessage,
): string {
  const parts: (string | undefined)[] = [];
  parts.push(message.message.case);

  const msg = message.message;
  switch (msg.case) {
    case "interactionUpdate":
      parts.push(msg.value.message.case);
      break;
    case "interactionQuery":
      parts.push(msg.value.query.case);
      break;
    case "execServerMessage":
      parts.push(msg.value.message.case);
      break;
    case "execServerControlMessage":
      parts.push(msg.value.message.case);
      break;
    case "conversationCheckpointUpdate":
      break;
    case "kvServerMessage":
      parts.push(msg.value.message.case);
      break;
  }

  return parts.filter((p) => p !== undefined).join(":");
}

function isIgnorableTerminalTransportClose(error: unknown): boolean {
  return (
    isBenignStreamEndError(error) || isRetriableTransportError(error)
  );
}

/**
 * Demux the agent bidi stream.
 *
 * Native cursor-agent marks turn_ended here (not in the interaction listener),
 * tags post-turn checkpoints as ineligible for resume, and swallows the common
 * Premature-close teardown that follows a terminal turn.
 */
export function splitStream(
  stream: AsyncIterable<AgentServerMessage>,
  detector: StallDetector,
  onFirstMessageOrOptions?: (() => void) | SplitStreamOptions,
): SplitChannels {
  const options: SplitStreamOptions =
    typeof onFirstMessageOrOptions === "function"
      ? { onFirstMessage: onFirstMessageOrOptions }
      : (onFirstMessageOrOptions ?? {});

  const interactionStream = createWritableIterable<InteractionMessage>();
  const execStream = createWritableIterable<ExecMessage>();
  const checkpointStream = createWritableIterable<CheckpointStreamItem>();
  const kvStream = createWritableIterable<KvServerMessage>();

  let firstMessageFired = false;

  async function run() {
    let caughtError: unknown;
    let sawTurnEnded = false;
    let sawIneligibleCheckpoint = false;

    try {
      for await (const message of stream) {
        // Notify on first message (indicates connection is working)
        if (!firstMessageFired) {
          firstMessageFired = true;
          options.onFirstMessage?.();
        }

        if (
          message.message.case === "interactionUpdate" &&
          message.message.value.message.case === "heartbeat"
        ) {
          // Server heartbeat = server is alive and processing, reset stall timer
          detector.onServerSentHeartbeat();
          detector.reset("inbound_message", "heartbeat");
        } else {
          // Reset stall detector on any meaningful inbound message
          detector.reset(
            "inbound_message",
            getMessageTypeLabelForStallDetector(message),
          );
        }

        if (
          message.message.case === "interactionUpdate" &&
          message.message.value.message.case === "turnEnded"
        ) {
          sawTurnEnded = true;
          options.onTurnEnded?.();
        }

        if (
          message.message.case === "interactionUpdate" ||
          message.message.case === "interactionQuery"
        ) {
          // Avoid unhandled rejections if the interaction stream was closed
          // (e.g., due to client-side abort/cleanup racing with server writes)
          await interactionStream
            .write(message.message as InteractionMessage)
            .catch(() => {});
        }

        if (
          message.message.case === "execServerMessage" ||
          message.message.case === "execServerControlMessage"
        ) {
          await execStream.write(message.message.value as ExecMessage);
        }

        if (message.message.case === "conversationCheckpointUpdate") {
          const resumeEligibility: ResumeEligibility = sawTurnEnded
            ? "ineligible_terminal_turn"
            : "eligible";
          if (resumeEligibility === "ineligible_terminal_turn") {
            sawIneligibleCheckpoint = true;
          }
          await checkpointStream.write({
            checkpoint: message.message.value,
            metadata: { resumeEligibility },
          });
        }

        if (message.message.case === "kvServerMessage") {
          await kvStream.write(message.message.value);
        }
      }

      detector.onStreamEnded();
    } catch (error) {
      caughtError = error;
    } finally {
      let errorToThrow = caughtError;
      const aborted =
        options.signal?.aborted === true ||
        options.parentSignal?.aborted === true;

      // Native: ignore Premature close after turn_ended + terminal checkpoint.
      if (
        sawTurnEnded &&
        sawIneligibleCheckpoint &&
        errorToThrow !== undefined &&
        !aborted &&
        isIgnorableTerminalTransportClose(errorToThrow)
      ) {
        detector.onStreamEnded();
        errorToThrow = undefined;
      }

      interactionStream.close();
      execStream.close();
      checkpointStream.close();
      kvStream.close();

      if (errorToThrow !== undefined) {
        throw errorToThrow;
      }
    }
  }

  return {
    interactionStream,
    execStream,
    checkpointStream,
    kvStream,
    done: run(),
  };
}
