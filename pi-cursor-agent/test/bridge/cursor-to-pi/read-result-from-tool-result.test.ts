import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { buildReadResultFromToolResult } from "../../../src/bridge/cursor-to-pi/executors/read.js";

function errResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: 1,
  };
}

function okResult(
  content: ToolResultMessage["content"],
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content,
    isError: false,
    timestamp: 1,
  };
}

test("ENOENT maps to ReadResult fileNotFound", () => {
  const r = buildReadResultFromToolResult(
    "missing.txt",
    errResult(
      "ENOENT: no such file or directory, access '/tmp/missing.txt'",
    ),
  );
  assert.equal(r.result.case, "fileNotFound");
  if (r.result.case === "fileNotFound") {
    assert.equal(r.result.value.path, "missing.txt");
  }
});

test("generic read error stays ReadError", () => {
  const r = buildReadResultFromToolResult(
    "x.txt",
    errResult("Something else went wrong"),
  );
  assert.equal(r.result.case, "error");
  if (r.result.case === "error") {
    assert.match(r.result.value.error, /Something else/);
  }
});

test("text read maps to content output", () => {
  const r = buildReadResultFromToolResult(
    "a.ts",
    okResult([{ type: "text", text: "const x = 1;" }]),
  );
  assert.equal(r.result.case, "success");
  if (r.result.case !== "success") assert.fail("expected success");
  assert.equal(r.result.value.output.case, "content");
  if (r.result.value.output.case !== "content") assert.fail("expected content");
  assert.equal(r.result.value.output.value, "const x = 1;");
  assert.equal(r.result.value.totalLines, 1);
});

test("image read maps to binary data output", () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const r = buildReadResultFromToolResult(
    "shot.png",
    okResult([
      { type: "text", text: "Read image file [image/png]" },
      {
        type: "image",
        data: pngBytes.toString("base64"),
        mimeType: "image/png",
      },
    ]),
  );
  assert.equal(r.result.case, "success");
  if (r.result.case !== "success") assert.fail("expected success");
  assert.equal(r.result.value.output.case, "data");
  if (r.result.value.output.case !== "data") assert.fail("expected data");
  assert.deepEqual(
    Buffer.from(r.result.value.output.value),
    pngBytes,
  );
  assert.equal(r.result.value.fileSize, BigInt(pngBytes.length));
  assert.equal(r.result.value.totalLines, 0);
});
