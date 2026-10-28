import { type JsonValue, Value } from "@bufbuild/protobuf";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  AgentClientMessage,
  AgentConversationTurnStructure,
  AgentRunRequest,
  AssistantMessage as AssistantMessageProto,
  ConversationAction,
  type ConversationStateStructure,
  ConversationStateStructure as ConversationStateStructureClass,
  ConversationStep,
  ConversationTurnStructure,
  ModelDetails,
  UserMessage,
  UserMessageAction,
} from "../../__generated__/agent/v1/agent_pb";
import {
  type McpToolDefinition,
  McpToolDefinition as McpToolDefinitionClass,
  McpTools,
} from "../../__generated__/agent/v1/mcp_pb";
import {
  SelectedContext,
  SelectedImage,
} from "../../__generated__/agent/v1/selected_context_pb";
import type { CursorStateStore } from "../../provider/state";
import { type BlobStore, getBlobId } from "../../vendor/agent-kv";
import {
  type DecodedImage,
  decodeImagesFromContent,
  toolResultToText,
} from "../shared/tool-result";
import {
  resolveContextSystemPrompt,
  resolveContextTools,
} from "./transcript-context";

const CURSOR_NATIVE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "delete",
  "ls",
  "grep",
  "lsp",
  "todo_write",
]);

interface UserMessagePayload {
  text: string;
  images: DecodedImage[];
}

function extractUserMessagePayload(msg: Message): UserMessagePayload | null {
  if (msg.role !== "user") return null;

  if (typeof msg.content === "string") {
    const text = msg.content.trim();
    return text ? { text, images: [] } : null;
  }

  const text = msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  const images = decodeImagesFromContent(msg.content);
  if (!text && images.length === 0) return null;
  return { text, images };
}

function resolveCurrentUserPayloads(
  messages: Message[],
): UserMessagePayload[] {
  const trailing: UserMessagePayload[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") break;
    const payload = extractUserMessagePayload(message);
    if (payload) trailing.unshift(payload);
  }
  return trailing;
}

function isInCurrentUserTurn(messages: Message[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i]?.role !== "user") return false;
  }
  return true;
}

function selectedImagesFromDecoded(images: DecodedImage[]): SelectedImage[] {
  return images.map(
    (image) =>
      new SelectedImage({
        uuid: crypto.randomUUID(),
        mimeType: image.mimeType,
        dataOrBlobId: { case: "data", value: image.bytes },
      }),
  );
}

function createUserMessageAction(
  payload: UserMessagePayload,
): ConversationAction {
  const selectedImages = selectedImagesFromDecoded(payload.images);
  const userMessage = new UserMessage({
    text: payload.text,
    messageId: crypto.randomUUID(),
    ...(selectedImages.length > 0
      ? { selectedContext: new SelectedContext({ selectedImages }) }
      : {}),
  });

  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({ userMessage }),
    },
  });
}

/**
 * Build the user actions added by Pi between Cursor tool boundaries.
 *
 * Without steering, a continuation context ends in a tool result. Trailing
 * user messages therefore represent new input that must be forwarded into the
 * still-running Cursor conversation. Pi can deliver more than one message at
 * once, so preserve the original order of the entire trailing user block.
 */
export function buildContinuationActions(
  context: Context,
): ConversationAction[] {
  return resolveCurrentUserPayloads(context.messages).map(
    createUserMessageAction,
  );
}

/** Format content blocks (thinking, text, toolCall) into a single string. */
function formatContentBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b["type"]) {
      case "thinking":
        if (b["thinking"]) parts.push(String(b["thinking"]));
        break;
      case "text":
        if (b["text"]) parts.push(String(b["text"]));
        break;
      case "toolCall":
        parts.push(`[Tool: ${String(b["name"] || "unknown")}]`);
        break;
    }
  }
  return parts.join("\n\n");
}

/** Reconstruct assistant text from stored content or Pi message blocks. */
function reconstructAssistantText(
  msg: AssistantMessage,
  state: CursorStateStore | undefined,
): string {
  const stored = state?.getAssistantContent(msg.timestamp);
  if (stored && stored.blocks.length > 0) {
    return formatContentBlocks(stored.blocks);
  }
  if (!Array.isArray(msg.content)) return "";
  return formatContentBlocks(msg.content as unknown[]);
}

/** Format a tool result with exec-type label from stored metadata. */
function formatToolResultStep(
  msg: ToolResultMessage,
  state: CursorStateStore | undefined,
): string {
  const text = toolResultToText(msg);
  const meta = state?.getToolCallMeta(msg.toolCallId);
  const label = meta ? meta.cursorExecType : "Tool";
  const status = msg.isError ? "error" : "result";
  return `[${label} ${status}]\n${text || "(no output)"}`;
}

function storeBlob(blobStore: BlobStore, bytes: Uint8Array): Uint8Array {
  const blobId = getBlobId(bytes);
  void blobStore.setBlob(null, blobId, bytes);
  return new Uint8Array(Array.from(blobId));
}

function buildConversationTurns(
  messages: Message[],
  blobStore: BlobStore,
  state: CursorStateStore | undefined,
): Uint8Array[] {
  const turns: Uint8Array[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") {
      i++;
      continue;
    }

    if (isInCurrentUserTurn(messages, i)) break;

    const payload = extractUserMessagePayload(msg);
    if (!payload) {
      i++;
      continue;
    }

    const selectedImages = selectedImagesFromDecoded(payload.images);
    const userMessage = new UserMessage({
      text: payload.text,
      messageId: crypto.randomUUID(),
      ...(selectedImages.length > 0
        ? { selectedContext: new SelectedContext({ selectedImages }) }
        : {}),
    });
    const userMessageBlobId = storeBlob(blobStore, userMessage.toBinary());

    const stepBlobIds: Uint8Array[] = [];
    i++;
    while (i < messages.length && messages[i]?.role !== "user") {
      const stepMsg = messages[i];
      if (!stepMsg) {
        i++;
        continue;
      }

      if (stepMsg.role === "assistant") {
        const text = reconstructAssistantText(
          stepMsg as AssistantMessage,
          state,
        );
        if (text) {
          const step = new ConversationStep({
            message: {
              case: "assistantMessage",
              value: new AssistantMessageProto({ text }),
            },
          });
          stepBlobIds.push(storeBlob(blobStore, step.toBinary()));
        }
      } else if (stepMsg.role === "toolResult") {
        const text = formatToolResultStep(stepMsg as ToolResultMessage, state);
        if (text) {
          const step = new ConversationStep({
            message: {
              case: "assistantMessage",
              value: new AssistantMessageProto({ text }),
            },
          });
          stepBlobIds.push(storeBlob(blobStore, step.toBinary()));
        }
      }

      i++;
    }

    const agentTurn = new AgentConversationTurnStructure({
      userMessage: userMessageBlobId as Uint8Array<ArrayBuffer>,
      steps: stepBlobIds as Uint8Array<ArrayBuffer>[],
    });
    const turn = new ConversationTurnStructure({
      turn: { case: "agentConversationTurn", value: agentTurn },
    });
    turns.push(storeBlob(blobStore, turn.toBinary()));
  }

  return turns;
}

function buildMcpToolDefinitions(
  tools: Tool[] | undefined,
): McpToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const advertisedTools = tools.filter(
    (tool) => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name),
  );
  if (advertisedTools.length === 0) {
    return [];
  }

  return advertisedTools.map((tool) => {
    const jsonSchema = tool.parameters as Record<string, unknown> | undefined;
    const schemaValue: JsonValue =
      jsonSchema && typeof jsonSchema === "object"
        ? (jsonSchema as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = new Uint8Array(Value.fromJson(schemaValue).toBinary());
    return new McpToolDefinitionClass({
      name: tool.name,
      description: tool.description,
      providerIdentifier: "pi-agent",
      toolName: tool.name,
      inputSchema,
    });
  });
}

interface BuildRunRequestParams {
  model: Model<Api>;
  context: Context;
  conversationId: string;
  blobStore: BlobStore;
  conversationState: ConversationStateStructure | undefined;
  mcpToolDefinitions?: McpToolDefinition[];
  state?: CursorStateStore;
  systemPromptOverride?: string;
}

interface BuildRunRequestResult {
  initialRequest: AgentClientMessage;
  conversationState: ConversationStateStructure;
}

export function buildRunRequest(
  params: BuildRunRequestParams,
): BuildRunRequestResult {
  const content =
    params.systemPromptOverride ||
    resolveContextSystemPrompt(params.context) ||
    "You are a helpful assistant.";

  const systemPromptJson = JSON.stringify({
    role: "system",
    content: content,
  });
  const systemPromptBytes = new TextEncoder().encode(systemPromptJson);
  const systemPromptId = getBlobId(systemPromptBytes);
  void params.blobStore.setBlob(null, systemPromptId, systemPromptBytes);

  const payloads = resolveCurrentUserPayloads(params.context.messages);
  const userText = payloads
    .map((payload) => payload.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const images = payloads.flatMap((payload) => payload.images);
  if (!userText && images.length === 0) {
    throw new Error("Cannot send empty user message to Cursor API");
  }

  const action = createUserMessageAction({ text: userText, images });

  const cached = params.conversationState;
  const turns = buildConversationTurns(
    params.context.messages,
    params.blobStore,
    params.state,
  );

  const conversationState =
    cached && cached.rootPromptMessagesJson.length > 0
      ? cached
      : new ConversationStateStructureClass({
          rootPromptMessagesJson: [systemPromptId],
          turns,
          todos: [],
          pendingToolCalls: [],
          previousWorkspaceUris: [],
          fileStates: {},
          fileStatesV2: {},
          summaryArchives: [],
          turnTimings: [],
          subagentStates: {},
          selfSummaryCount: 0,
          readPaths: [],
        });

  const modelDetails = new ModelDetails({
    modelId: params.model.id,
    displayModelId: params.model.id,
    displayName: params.model.name,
  });

  const mcpToolDefinitions = params.mcpToolDefinitions ?? [];
  const runRequest = new AgentRunRequest({
    conversationState,
    action,
    modelDetails,
    conversationId: params.conversationId,
    mcpTools: new McpTools({ mcpTools: mcpToolDefinitions }),
  });

  const initialRequest = new AgentClientMessage({
    message: { case: "runRequest", value: runRequest },
  });

  return {
    initialRequest,
    conversationState,
  };
}

export function getContextTools(context: Context): McpToolDefinition[] {
  return buildMcpToolDefinitions(resolveContextTools(context));
}

/** Exported for tests: MCP advertise list after native-tool filtering. */
export function buildMcpToolDefinitionsForTools(
  tools: Tool[] | undefined,
): McpToolDefinition[] {
  return buildMcpToolDefinitions(tools);
}
