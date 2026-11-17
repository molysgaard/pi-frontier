import assert from "node:assert/strict";
import test from "node:test";
import { shouldCancelCompactionForModel } from "../../src/provider/compaction-policy.js";

test("cancels compaction for cursor-agent", () => {
  assert.equal(
    shouldCancelCompactionForModel({ provider: "cursor-agent" }),
    true,
  );
});

test("allows compaction for other providers", () => {
  assert.equal(shouldCancelCompactionForModel({ provider: "deepseek" }), false);
  assert.equal(shouldCancelCompactionForModel({ provider: "openai" }), false);
  assert.equal(shouldCancelCompactionForModel(undefined), false);
  assert.equal(shouldCancelCompactionForModel(null), false);
});
