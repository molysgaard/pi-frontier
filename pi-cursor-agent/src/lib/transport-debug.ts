import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConnectError } from "@connectrpc/connect";

const DEBUG_LOG_PATH =
  process.env["PI_CURSOR_AGENT_TRANSPORT_DEBUG_LOG"] ??
  "/tmp/pi-cursor-agent-transport-debug.log";

const enabled =
  process.env["PI_CURSOR_AGENT_TRANSPORT_DEBUG"] === "1" ||
  process.env["PI_CURSOR_AGENT_TRANSPORT_DEBUG"] === "true";

export function isTransportDebugEnabled(): boolean {
  return enabled;
}

export function debugLogTransport(
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!enabled) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });

  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(DEBUG_LOG_PATH, `${line}\n`, "utf8");
  } catch (error) {
    console.error(
      `[pi-cursor-agent:transport-debug] failed to write ${DEBUG_LOG_PATH}`,
      error,
    );
  }

  console.error(`[pi-cursor-agent:transport-debug] ${line}`);
}

interface CauseFrame {
  name?: string;
  message?: string;
  code?: unknown;
  rawMessage?: string;
}

export function serializeErrorForDebug(error: unknown): {
  name?: string;
  message?: string;
  stack?: string;
  connectCode?: number;
  connectRawMessage?: string;
  causeChain: CauseFrame[];
} {
  const causeChain: CauseFrame[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current) && causeChain.length < 8) {
    seen.add(current);
    if (current instanceof ConnectError) {
      causeChain.push({
        name: current.name,
        message: current.message,
        code: current.code,
        rawMessage: current.rawMessage,
      });
      current = current.cause;
      continue;
    }
    if (current instanceof Error) {
      const withCode = current as Error & { code?: unknown };
      causeChain.push({
        name: current.name,
        message: current.message,
        ...(withCode.code !== undefined ? { code: withCode.code } : {}),
      });
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    causeChain.push({ message: String(current) });
    break;
  }

  if (error instanceof ConnectError) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      connectCode: error.code,
      connectRawMessage: error.rawMessage,
      causeChain,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      causeChain,
    };
  }

  return {
    message: String(error),
    causeChain,
  };
}

const RECENT_MESSAGE_LIMIT = 12;

/** Native default failTimeoutMs is 30s (floored to ≥20s outside tests). */
export const DEFAULT_STALL_THRESHOLD_MS = 30_000;

export interface StreamActivitySnapshot {
  lastActivityAt: number | null;
  lastHeartbeatAt: number | null;
  lastMeaningfulActivityAt: number | null;
  recentMessageTypes: string[];
  msSinceLastActivity: number | null;
  msSinceLastHeartbeat: number | null;
  msSinceLastMeaningfulActivity: number | null;
  streamEnded: boolean;
}

export interface ActivityTrackingStallDetectorOptions {
  /** Idle time without inbound activity before onStall. ≤0 disables. */
  thresholdMs?: number;
  onStall?: () => void;
}

/**
 * StallDetector with transport-debug breadcrumbs and native-like fail timer.
 * Heartbeats reset the activity clock (same as any inbound message).
 */
export class ActivityTrackingStallDetector {
  private lastActivityAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastMeaningfulActivityAt: number | null = null;
  private readonly recentMessageTypes: string[] = [];
  private ended = false;
  private stalled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly thresholdMs: number;
  private readonly onStall: (() => void) | undefined;

  constructor(options: ActivityTrackingStallDetectorOptions = {}) {
    this.thresholdMs =
      options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.onStall = options.onStall;
  }

  onServerSentHeartbeat(): void {
    const now = Date.now();
    this.lastActivityAt = now;
    this.lastHeartbeatAt = now;
    this.armTimer();
  }

  reset(_activityType: string, messageType: string): void {
    const now = Date.now();
    this.lastActivityAt = now;
    if (messageType !== "heartbeat") {
      this.lastMeaningfulActivityAt = now;
    }
    this.recentMessageTypes.push(messageType);
    if (this.recentMessageTypes.length > RECENT_MESSAGE_LIMIT) {
      this.recentMessageTypes.shift();
    }
    this.armTimer();
  }

  onStreamEnded(): void {
    this.ended = true;
    this.clearTimer();
  }

  dispose(): void {
    this.clearTimer();
  }

  snapshot(): StreamActivitySnapshot {
    const now = Date.now();
    return {
      lastActivityAt: this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastMeaningfulActivityAt: this.lastMeaningfulActivityAt,
      recentMessageTypes: [...this.recentMessageTypes],
      msSinceLastActivity:
        this.lastActivityAt === null ? null : now - this.lastActivityAt,
      msSinceLastHeartbeat:
        this.lastHeartbeatAt === null ? null : now - this.lastHeartbeatAt,
      msSinceLastMeaningfulActivity:
        this.lastMeaningfulActivityAt === null
          ? null
          : now - this.lastMeaningfulActivityAt,
      streamEnded: this.ended,
    };
  }

  private armTimer(): void {
    this.clearTimer();
    if (this.ended || this.stalled || this.thresholdMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.ended || this.stalled) return;
      this.stalled = true;
      debugLogTransport("transport.stall", {
        thresholdMs: this.thresholdMs,
        activity: this.snapshot(),
      });
      this.onStall?.();
    }, this.thresholdMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
