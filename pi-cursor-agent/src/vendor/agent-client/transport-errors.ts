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
