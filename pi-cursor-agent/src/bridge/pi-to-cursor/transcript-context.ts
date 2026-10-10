import * as piAi from "@mariozechner/pi-ai";
import type { Context, Tool } from "@mariozechner/pi-ai";

/**
 * Pi >= 0.86 passes custom providers a TranscriptContext: system prompt and tool
 * declarations live on system messages (`toolsAdded` / `toolsRemoved`), not on
 * `context.systemPrompt` / `context.tools`. Read them with the official helpers
 * when the host pi-ai exposes them (Pi's extension loader aliases
 * `@mariozechner/pi-ai` to the host compat entrypoint).
 *
 * @see https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
 */

type ToolRef = { name: string };

type SystemLike = {
  role: string;
  content?: unknown;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolRef[];
};

type TranscriptApi = {
  getCurrentTools?: (messages: readonly { role: string }[]) => Tool[];
  getCurrentSystemPrompt?: (messages: readonly { role: string }[]) => string;
};

function readToolsFromTranscript(
  messages: readonly { role: string }[],
): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const system = message as SystemLike;
    for (const tool of system.toolsRemoved ?? []) {
      tools.delete(tool.name);
    }
    for (const tool of system.toolsAdded ?? []) {
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

function readPromptFromTranscript(
  messages: readonly { role: string }[],
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    const content = (message as SystemLike).content;
    if (typeof content === "string" && content.length > 0) {
      parts.push(content);
    }
  }
  return parts.join("\n\n");
}

export function resolveContextTools(context: Context): Tool[] {
  const api = piAi as unknown as TranscriptApi;
  if (typeof api.getCurrentTools === "function") {
    return api.getCurrentTools(context.messages);
  }

  const fromTranscript = readToolsFromTranscript(context.messages);
  if (fromTranscript.length > 0) {
    return fromTranscript;
  }

  return (context as Context & { tools?: Tool[] }).tools ?? [];
}

export function resolveContextSystemPrompt(context: Context): string {
  const api = piAi as unknown as TranscriptApi;
  if (typeof api.getCurrentSystemPrompt === "function") {
    const prompt = api.getCurrentSystemPrompt(context.messages);
    if (prompt) return prompt;
  }

  const fromTranscript = readPromptFromTranscript(context.messages);
  if (fromTranscript) return fromTranscript;

  return context.systemPrompt ?? "";
}
