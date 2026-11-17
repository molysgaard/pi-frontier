import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AiService from "../src/api/ai-service.js";
import { CURSOR_API_URL, CURSOR_CLIENT_VERSION } from "../src/lib/env.js";

async function main() {
  const auth = JSON.parse(
    readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
  ) as Record<string, { access?: string }>;
  const token = auth["cursor-agent"]?.access;
  if (!token) throw new Error("no token");
  const ai = new AiService(CURSOR_API_URL, {
    accessToken: token,
    clientVersion: CURSOR_CLIENT_VERSION,
    clientType: "cli",
  });
  const res = await ai.getUsableModels();
  const ids = (res.models ?? []).map((m) => m.modelId);
  console.log("count", ids.length);
  for (const id of ids) {
    if (/composer|grok|gpt-5-mini|flash|sonnet-4-5/i.test(id)) {
      console.log(id);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
