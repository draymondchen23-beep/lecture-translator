import assert from "node:assert/strict";
import test from "node:test";
import { fallbackRequestSegmentId, stableWords, uncommittedTail } from "../app/lecture-translator/browser-incremental.mjs";

test("stable prefixes yield only new chunks and final sends only its tail", () => {
  let stable = [];
  stable = stableWords(["The", "quick"], ["The", "quick", "brown"], stable);
  assert.deepEqual(stable, ["The", "quick"]);
  stable = stableWords(["The", "quick", "brown"], ["The", "quick", "brown", "fox"], stable);
  assert.deepEqual(stable, ["The", "quick", "brown"]);
  assert.equal(uncommittedTail("The quick brown fox", stable.join(" ")), "fox");
});

test("each browser fallback request has a unique cache key", () => {
  const ids = [0, 1, 2].map((index) => fallbackRequestSegmentId("session", 4, index));
  assert.equal(new Set(ids).size, ids.length);
});
