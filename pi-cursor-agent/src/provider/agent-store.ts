import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { ConversationStateStructure } from "../__generated__/agent/v1/agent_pb";
import {
  type AgentStoreSnapshot,
  CURSOR_STATE_ENTRY_TYPE,
  findLatestStateSnapshot,
  isAgentStoreSnapshot,
} from "../bridge/pi-to-cursor/checkpoint-sync";
import {
  applySnapshotToStore,
  deleteAgentStore as deleteStore,
  ensureAgentStore as ensureStore,
  persistAgentStore as persistStore,
} from "../lib/agent-store";
import { type AgentStore, fromHex, toHex } from "../vendor/agent-kv";
import { PI_CURSOR_AGENT_CACHE_DIR } from "./env";

export { CURSOR_STATE_ENTRY_TYPE };
export type { AgentStoreSnapshot };

/** Per-session covered Pi entry id (mirrored into state snapshots on flush). */
const coveredEntryIds = new Map<string, string>();

export const getCoveredEntryId = (sessionId: string): string | undefined =>
  coveredEntryIds.get(sessionId);

export const setCoveredEntryId = (
  sessionId: string,
  entryId: string | undefined,
): void => {
  if (!entryId) {
    coveredEntryIds.delete(sessionId);
    return;
  }
  coveredEntryIds.set(sessionId, entryId);
};

export const clearCoveredEntryId = (sessionId: string): void => {
  coveredEntryIds.delete(sessionId);
};

export const findSnapshot = (
  entries: SessionEntry[],
): AgentStoreSnapshot | null =>
  findLatestStateSnapshot(entries)?.snapshot ?? null;

export const ensureAgentStore = async (
  sessionId: string,
): Promise<AgentStore> => {
  const entry = await ensureStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  return entry.store;
};

export const mintAgentId = async (sessionId: string): Promise<string> => {
  const entry = await ensureStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  const agentId = crypto.randomUUID();
  entry.jsonStore.metadata.agentId = agentId;
  return agentId;
};

export const persistAgentStore = async (
  sessionId: string,
): Promise<AgentStoreSnapshot | null> => {
  const entry = await persistStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  if (!entry) {
    return null;
  }

  const {
    store,
    jsonStore: { metadata },
  } = entry;
  const snapshot: AgentStoreSnapshot = {
    version: 1,
    agentId: metadata.agentId,
    latestRootBlobId: toHex(metadata.latestRootBlobId),
  };

  const coveredEntryId = coveredEntryIds.get(sessionId);
  if (coveredEntryId) {
    snapshot.coveredEntryId = coveredEntryId;
  }

  try {
    const bytes = store.getConversationStateStructure().toBinary();
    if (bytes.length > 0) {
      snapshot.conversationState = Buffer.from(bytes).toString("base64");
    }
  } catch {}

  return snapshot;
};

export const evictAgentStore = async (
  sessionId: string,
  options?: { persist?: boolean },
): Promise<void> => {
  try {
    if (options?.persist !== false) {
      await persistStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
    }
  } finally {
    deleteStore(sessionId);
    // Keep coveredEntryId across short-lived evict/restore within the same
    // session; clear only when retain/explicit clear is used elsewhere.
  }
};

export const restoreAgentStoreFromBranch = async (
  sessionId: string,
  entries: SessionEntry[],
): Promise<void> => {
  const snapshot = findSnapshot(entries);
  if (!snapshot) {
    clearCoveredEntryId(sessionId);
    return;
  }

  if (snapshot.coveredEntryId) {
    setCoveredEntryId(sessionId, snapshot.coveredEntryId);
  } else {
    clearCoveredEntryId(sessionId);
  }

  const storeEntry = await ensureStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  const rootBlobId = snapshot.latestRootBlobId
    ? fromHex(snapshot.latestRootBlobId)
    : new Uint8Array();

  if (rootBlobId.length > 0) {
    await applySnapshotToStore(storeEntry, snapshot.agentId, rootBlobId);
    return;
  }

  if (snapshot.conversationState) {
    storeEntry.jsonStore.metadata.agentId = snapshot.agentId;
    try {
      storeEntry.store.conversationStateStructure =
        ConversationStateStructure.fromBinary(
          Buffer.from(snapshot.conversationState, "base64"),
        );
    } catch {}
  } else {
    storeEntry.jsonStore.metadata.agentId = snapshot.agentId;
  }
};

/** @internal test helper */
export const _isAgentStoreSnapshotForTest = isAgentStoreSnapshot;
