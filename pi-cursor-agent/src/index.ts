import type {
  Api,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import AiService from "./api/ai-service";
import Auth from "./api/auth";
import { resolveToolResult } from "./bridge/cursor-to-pi/tool-bridge";
import AuthManager from "./lib/auth";
import {
  CURSOR_API_URL,
  CURSOR_CLIENT_VERSION,
  CURSOR_WEBSITE_URL,
} from "./lib/env";
import {
  CURSOR_STATE_ENTRY_TYPE,
  persistAgentStore,
  restoreAgentStoreFromBranch,
  setCoveredEntryId,
} from "./provider/agent-store";
import { getLiveSession } from "./provider/agent-stream-hook";
import {
  getCachedPiModels,
  updateCachedPiModelsIfStale,
} from "./provider/models";
import {
  retainOnlyActiveSessionMemory,
  terminateSession,
} from "./provider/session-lifecycle";
import { createStateStore } from "./provider/state";
import { streamCursorAgent } from "./provider/stream";

const auth = new AuthManager(new Auth(CURSOR_API_URL), CURSOR_WEBSITE_URL);

const createAiService = (accessToken: string) => {
  return new AiService(CURSOR_API_URL, {
    accessToken,
    clientVersion: CURSOR_CLIENT_VERSION,
    clientType: "cli",
  });
};

const updateCachedModelsInBackground = (accessToken: string) => {
  const ai = createAiService(accessToken);
  void updateCachedPiModelsIfStale(ai).catch(() => {}); // ignore
};

const updateCachedModelsFromContextInBackground = (ctx: ExtensionContext) => {
  void (async () => {
    const accessToken =
      await ctx.modelRegistry.getApiKeyForProvider("cursor-agent");
    if (!accessToken) {
      return;
    }

    await updateCachedPiModelsIfStale(createAiService(accessToken));
  })().catch(() => {}); // ignore
};

const login = async (
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> => {
  const credentials = await auth.login(callbacks);
  updateCachedModelsInBackground(credentials.access);
  return credentials;
};

const refreshToken = async (
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> => {
  const refreshed = await auth.refresh(credentials);
  updateCachedModelsInBackground(refreshed.access);
  return refreshed;
};

export default (pi: ExtensionAPI) => {
  let lastCtx: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  const getCtx = () => lastCtx;

  const state = createStateStore((type, data) => {
    pi.appendEntry(type, data);
  });

  const cleanupPreviousSession = async (newSessionId: string) => {
    const previousSessionId = currentSessionId;
    currentSessionId = newSessionId;
    if (previousSessionId && previousSessionId !== newSessionId) {
      await terminateSession(previousSessionId, "Session ended");
    }
  };

  const refreshBranchState = async (ctx: ExtensionContext) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    await cleanupPreviousSession(sessionId);
    // Always drop live Cursor RPC when the branch/session binding changes
    // (including /tree within the same session id).
    await terminateSession(sessionId, "Session branch changed");
    state.resetFromContext(ctx);
    try {
      await restoreAgentStoreFromBranch(
        sessionId,
        ctx.sessionManager.getBranch(),
      );
    } catch {}
    retainOnlyActiveSessionMemory(sessionId);
  };

  const flushCoveredEntryAnchor = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== "cursor-agent") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafEntry();
    if (!leaf || leaf.type !== "message") return;

    const live = getLiveSession(sessionId);
    if (live) {
      setCoveredEntryId(sessionId, leaf.id);
      try {
        await live.flushSessionState();
        return;
      } catch {}
    }

    // Stream path often evicts the in-memory store before turn_end. Restore
    // from the branch first, then write a snapshot that includes coveredEntryId
    // pointing at the just-finished message leaf.
    try {
      await restoreAgentStoreFromBranch(
        sessionId,
        ctx.sessionManager.getBranch(),
      );
      setCoveredEntryId(sessionId, leaf.id);
      const snapshot = await persistAgentStore(sessionId);
      if (snapshot) {
        pi.appendEntry(CURSOR_STATE_ENTRY_TYPE, snapshot);
      }
    } catch {}
  };

  pi.on("before_agent_start", async (_, ctx) => {
    lastCtx = ctx;
  });

  pi.on("agent_start", async (_, ctx) => {
    lastCtx = ctx;
  });

  pi.on("turn_end", async (_, ctx) => {
    lastCtx = ctx;
    await flushCoveredEntryAnchor(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    lastCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.model.provider === "cursor-agent") {
      updateCachedModelsFromContextInBackground(ctx);
    } else {
      await terminateSession(sessionId, "Switched away from Cursor Agent");
    }
  });

  pi.on("session_start", async (_, ctx) => {
    await refreshBranchState(ctx);
    updateCachedModelsFromContextInBackground(ctx);
  });

  pi.on("session_switch", async (_, ctx) => {
    await refreshBranchState(ctx);
    updateCachedModelsFromContextInBackground(ctx);
  });

  pi.on("session_tree", async (_, ctx) => {
    await refreshBranchState(ctx);
  });

  pi.on("tool_execution_end", async (event) => {
    resolveToolResult({
      role: "toolResult",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.result?.content ?? [],
      details: event.result?.details,
      isError: event.isError,
      timestamp: Date.now(),
    });
  });

  pi.registerProvider("cursor-agent", {
    baseUrl: CURSOR_API_URL,
    apiKey: "CURSOR_ACCESS_TOKEN",
    api: "cursor-agent" as unknown as Api,
    streamSimple: (model, context, options) =>
      streamCursorAgent(pi, getCtx, state, model, context, options),
    models: getCachedPiModels(),
    oauth: {
      name: "Cursor",
      login,
      refreshToken,
      getApiKey: (cred) => cred.access,
    },
  });
};
