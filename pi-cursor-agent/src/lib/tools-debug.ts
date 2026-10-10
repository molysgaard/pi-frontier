import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { McpToolDefinition } from "../__generated__/agent/v1/mcp_pb";

const DEBUG_LOG_PATH =
  process.env["PI_CURSOR_AGENT_TOOLS_DEBUG_LOG"] ??
  "/tmp/pi-cursor-agent-tools-debug.log";

const enabled =
  process.env["PI_CURSOR_AGENT_TOOLS_DEBUG"] === "1" ||
  process.env["PI_CURSOR_AGENT_TOOLS_DEBUG"] === "true";

function summarizeSchema(inputSchema: Uint8Array | undefined): {
  schemaBytes: number;
  schemaPreview: string | null;
} {
  if (!inputSchema || inputSchema.length === 0) {
    return { schemaBytes: 0, schemaPreview: null };
  }
  // inputSchema is protobuf Value binary — length is enough for step 2.
  return {
    schemaBytes: inputSchema.length,
    schemaPreview: `protobuf-value-binary(${inputSchema.length} bytes)`,
  };
}

export function debugLogTools(event: string, data: Record<string, unknown>): void {
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
    console.error(`[pi-cursor-agent:tools-debug] failed to write ${DEBUG_LOG_PATH}`, error);
  }

  console.error(`[pi-cursor-agent:tools-debug] ${line}`);
}

export function debugLogContextTools(params: {
  contextToolNames: string[];
  legacyContextToolNames?: string[];
  activeToolNames: string[];
  advertised: McpToolDefinition[];
}): void {
  debugLogTools("session_start.getContextTools", {
    contextToolCount: params.contextToolNames.length,
    contextToolNames: params.contextToolNames,
    legacyContextToolCount: params.legacyContextToolNames?.length ?? 0,
    legacyContextToolNames: params.legacyContextToolNames ?? [],
    activeToolCount: params.activeToolNames.length,
    activeToolNames: params.activeToolNames,
    advertisedCount: params.advertised.length,
    advertised: params.advertised.map((tool) => ({
      name: tool.name,
      toolName: tool.toolName,
      providerIdentifier: tool.providerIdentifier,
      descriptionChars: tool.description?.length ?? 0,
      ...summarizeSchema(tool.inputSchema),
    })),
  });
}

export function debugLogRunRequestMcpTools(
  mcpTools: McpToolDefinition[],
  conversationId: string,
): void {
  debugLogTools("wire.AgentRunRequest.mcp_tools", {
    conversationId,
    mcpToolsCount: mcpTools.length,
    mcpTools: mcpTools.map((tool) => ({
      name: tool.name,
      toolName: tool.toolName,
      providerIdentifier: tool.providerIdentifier,
      descriptionChars: tool.description?.length ?? 0,
      ...summarizeSchema(tool.inputSchema),
    })),
    mcpFileSystemOptionsSet: false,
  });
}

export function debugLogRequestContextTools(
  tools: McpToolDefinition[],
  extras?: {
    webSearchEnabled?: boolean;
    webFetchEnabled?: boolean;
  },
): void {
  debugLogTools("exec.RequestContext.tools", {
    toolsCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    webSearchEnabled: extras?.webSearchEnabled ?? null,
    webFetchEnabled: extras?.webFetchEnabled ?? null,
  });
}
