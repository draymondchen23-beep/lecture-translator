import assert from "node:assert/strict";
import test from "node:test";
import { reducePartialEvent } from "../app/lecture-translator/partial-events.mjs";

test("late translations and finals cannot replace a newer live block", () => {
  let partial = { source: "first", translation: "第一", sequence: 3 };
  partial = reducePartialEvent(partial, { type: "source.partial", text: "second", sequence: 4 });
  assert.deepEqual(partial, { source: "second", translation: "", sequence: 4 });
  assert.equal(reducePartialEvent(partial, { type: "translation.partial", text: "第一", sequence: 3 }), partial);
  assert.equal(reducePartialEvent(partial, { type: "segment.final", sequence: 3 }), partial);
  assert.deepEqual(reducePartialEvent(partial, { type: "translation.partial", text: "第二", sequence: 4 }), { source: "second", translation: "第二", sequence: 4 });
});
