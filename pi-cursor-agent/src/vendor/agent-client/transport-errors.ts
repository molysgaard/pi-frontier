import { ConnectError } from "@connectrpc/connect";
import { LostConnection } from "./exec-controller";

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
  "Connection stalled",
] as const;

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

/**
 * Native non-retriable inference / config error types.
 * Detected via message text or `x-cursor-inference-request-error-type`.
 * Fail fast — never ResumeAction / transport-retry these.
 */
const NON_RETRIABLE_AGENT_ERROR_TYPES = ["OUTDATED_CLIENT"] as const;

const INFERENCE_ERROR_TYPE_HEADER = "x-cursor-inference-request-error-type";

const NON_RETRIABLE_AGENT_ERROR_RE = new RegExp(
  `\\b(${NON_RETRIABLE_AGENT_ERROR_TYPES.join("|")})\\b`,
);

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

function inferenceErrorTypeFromMetadata(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ConnectError) {
      const value = current.metadata.get(INFERENCE_ERROR_TYPE_HEADER);
      if (value) return value;
    }
    if (current instanceof Error) {
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return undefined;
}

export function getNonRetriableAgentErrorType(
  error: unknown,
): (typeof NON_RETRIABLE_AGENT_ERROR_TYPES)[number] | undefined {
  const fromHeader = inferenceErrorTypeFromMetadata(error);
  if (
    fromHeader &&
    (NON_RETRIABLE_AGENT_ERROR_TYPES as readonly string[]).includes(fromHeader)
  ) {
    return fromHeader as (typeof NON_RETRIABLE_AGENT_ERROR_TYPES)[number];
  }

  for (const text of collectErrorTexts(error)) {
    const match = NON_RETRIABLE_AGENT_ERROR_RE.exec(text);
    if (match?.[1]) {
      return match[1] as (typeof NON_RETRIABLE_AGENT_ERROR_TYPES)[number];
    }
  }
  return undefined;
}

/** Native config/auth-class errors that must not trigger ResumeAction retries. */
export function isNonRetriableAgentError(error: unknown): boolean {
  return getNonRetriableAgentErrorType(error) !== undefined;
}

export function formatNonRetriableAgentError(error: unknown): string {
  const type = getNonRetriableAgentErrorType(error) ?? "UNKNOWN";
  if (type === "OUTDATED_CLIENT") {
    return (
      "Cursor rejected this client as OUTDATED_CLIENT. " +
      "Bump CURSOR_CLIENT_VERSION / pi-cursor-agent to match a current cursor-agent CLI."
    );
  }
  return `Cursor returned non-retriable error ${type}`;
}

/** Exported for unit tests — mirrors native cursor-agent transport retry policy. */
export function isRetriableTransportError(error: unknown): boolean {
  if (isNonRetriableAgentError(error)) return false;
  if (error instanceof LostConnection) return true;

  const texts = collectErrorTexts(error);
  return RETRIABLE_TRANSPORT_SUBSTRINGS.some((needle) =>
    texts.some((text) => text.includes(needle)),
  );
}

export function isBenignStreamEndError(error: unknown): boolean {
  if (error instanceof LostConnection) {
    return isBenignStreamEndError(new Error(error.message));
  }
  const texts = collectErrorTexts(error);
  return BENIGN_STREAM_END_SUBSTRINGS.some((needle) =>
    texts.some((text) => text.includes(needle)),
  );
}

export function serializeErrorTextsForDebug(error: unknown): string[] {
  return collectErrorTexts(error);
}
