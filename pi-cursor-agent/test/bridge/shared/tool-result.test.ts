import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeImageContent,
  decodeImagesFromContent,
  toolResultPrimaryImage,
  toolResultToText,
} from "../../../src/bridge/shared/tool-result.js";

test("decodeImageContent decodes base64 bytes", () => {
  const bytes = Buffer.from([1, 2, 3, 4]);
  const decoded = decodeImageContent({
    type: "image",
    data: bytes.toString("base64"),
    mimeType: "image/png",
  });
  assert.ok(decoded);
  assert.equal(decoded.mimeType, "image/png");
  assert.deepEqual(Buffer.from(decoded.bytes), bytes);
});

test("decodeImageContent rejects empty payload", () => {
  assert.equal(
    decodeImageContent({ type: "image", data: "", mimeType: "image/png" }),
    null,
  );
});

test("toolResultPrimaryImage prefers first image", () => {
  const first = Buffer.from([1]);
  const second = Buffer.from([2]);
  const image = toolResultPrimaryImage({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    timestamp: 1,
    content: [
      { type: "text", text: "note" },
      {
        type: "image",
        data: first.toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "image",
        data: second.toString("base64"),
        mimeType: "image/jpeg",
      },
    ],
  });
  assert.ok(image);
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.bytes), first);
});

test("decodeImagesFromContent collects all images", () => {
  const images = decodeImagesFromContent([
    { type: "text", text: "hi" },
    {
      type: "image",
      data: Buffer.from([9]).toString("base64"),
      mimeType: "image/webp",
    },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.mimeType, "image/webp");
});

test("toolResultToText keeps placeholder for images", () => {
  assert.equal(
    toolResultToText({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      isError: false,
      timestamp: 1,
      content: [
        { type: "text", text: "note" },
        { type: "image", data: "QQ==", mimeType: "image/png" },
      ],
    }),
    "note\n[image/png image]",
  );
});
