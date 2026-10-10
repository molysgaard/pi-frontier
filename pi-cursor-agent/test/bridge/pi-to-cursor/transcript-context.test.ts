import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Tool } from "@mariozechner/pi-ai";
import {
  buildMcpToolDefinitionsForTools,
  getContextTools,
} from "../../../src/bridge/pi-to-cursor/request-builder.js";
import {
  resolveContextSystemPrompt,
  resolveContextTools,
} from "../../../src/bridge/pi-to-cursor/transcript-context.js";

const webSearchTool = {
  name: "web_search",
  description: "Search the web",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
} as Tool;

const bashTool = {
  name: "bash",
  description: "Run a shell command",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
} as Tool;

test("resolveContextTools reads toolsAdded from transcript system messages", () => {
  const context = {
    messages: [
      {
        role: "system",
        content: "You are helpful.",
        toolsAdded: [bashTool, webSearchTool],
        timestamp: 0,
      },
      { role: "user", content: "hi", timestamp: 1 },
    ],
  } as Context;

  const tools = resolveContextTools(context);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["bash", "web_search"],
  );
  assert.equal(resolveContextSystemPrompt(context), "You are helpful.");
});

test("resolveContextTools applies toolsRemoved deltas", () => {
  const context = {
    messages: [
      {
        role: "system",
        content: "base",
        toolsAdded: [bashTool, webSearchTool],
        timestamp: 0,
      },
      {
        role: "system",
        content: "",
        toolsRemoved: [{ name: "bash" }],
        timestamp: 1,
      },
      { role: "user", content: "hi", timestamp: 2 },
    ],
  } as Context;

  assert.deepEqual(
    resolveContextTools(context).map((tool) => tool.name),
    ["web_search"],
  );
});

test("getContextTools advertises non-native transcript tools as MCP", () => {
  const context = {
    messages: [
      {
        role: "system",
        content: "prompt",
        toolsAdded: [bashTool, webSearchTool],
        timestamp: 0,
      },
      { role: "user", content: "hi", timestamp: 1 },
    ],
  } as Context;

  const advertised = getContextTools(context);
  assert.deepEqual(
    advertised.map((tool) => tool.name),
    ["web_search"],
  );
  assert.equal(advertised[0]?.providerIdentifier, "pi-agent");
  assert.ok((advertised[0]?.inputSchema?.length ?? 0) > 0);
});

test("buildMcpToolDefinitionsForTools filters Cursor-native names", () => {
  const advertised = buildMcpToolDefinitionsForTools([bashTool, webSearchTool]);
  assert.deepEqual(
    advertised.map((tool) => tool.name),
    ["web_search"],
  );
});
