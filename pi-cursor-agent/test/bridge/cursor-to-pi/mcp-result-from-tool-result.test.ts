import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { buildMcpResultFromToolResult } from "../../../src/bridge/cursor-to-pi/executors/mcp.js";

function okResult(
  content: ToolResultMessage["content"],
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "screenshot",
    content,
    isError: false,
    timestamp: 1,
  };
}

test("maps text and image content parts", () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const r = buildMcpResultFromToolResult(
    okResult([
      { type: "text", text: "here is a shot" },
      {
        type: "image",
        data: pngBytes.toString("base64"),
        mimeType: "image/png",
      },
    ]),
  );

  assert.equal(r.result.case, "success");
  if (r.result.case !== "success") assert.fail("expected success");
  assert.equal(r.result.value.content.length, 2);

  const textItem = r.result.value.content[0];
  assert.equal(textItem?.content.case, "text");
  if (textItem?.content.case !== "text") assert.fail("expected text");
  assert.equal(textItem.content.value.text, "here is a shot");

  const imageItem = r.result.value.content[1];
  assert.equal(imageItem?.content.case, "image");
  if (imageItem?.content.case !== "image") assert.fail("expected image");
  assert.equal(imageItem.content.value.mimeType, "image/png");
  assert.deepEqual(
    Buffer.from(imageItem.content.value.data),
    pngBytes,
  );
});

test("empty content becomes placeholder text", () => {
  const r = buildMcpResultFromToolResult(okResult([]));
  assert.equal(r.result.case, "success");
  if (r.result.case !== "success") assert.fail("expected success");
  assert.equal(r.result.value.content.length, 1);
  assert.equal(r.result.value.content[0]?.content.case, "text");
  if (r.result.value.content[0]?.content.case !== "text") {
    assert.fail("expected text");
  }
  assert.equal(r.result.value.content[0].content.value.text, "(no output)");
});
