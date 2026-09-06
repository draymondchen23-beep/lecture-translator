import assert from "node:assert/strict";
import test from "node:test";
import { createFinalSegmentGate, shouldRefineFinal } from "../app/lecture-translator/incremental-refinement.mjs";
import { createIncrementalRefiner, validateIncrementalRequest } from "../app/api/translate/incremental-refinement.mjs";

test("one hundred final segments submit one refinement each, despite duplicate delivery", async () => {
  const gate = createFinalSegmentGate();
  const refiner = createIncrementalRefiner();
  let requests = 0;
  let externalCalls = 0;
  const external = async () => { externalCalls += 1; return { translation: "translated", provider: "qwen-mt" }; };
  for (let index = 0; index < 100; index += 1) {
    const id = `lecture-1:${index}:${index * 1_000}`;
    if (gate.claim("lecture-1", id)) {
      requests += 1;
      void refiner.run({ lectureId: "lecture-1", segmentId: id, text: `segment ${index}`, tokenEstimate: 2, warning: false }, external);
    }
    if (gate.claim("lecture-1", id)) requests += 1;
  }
  assert.equal(requests, 100);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(externalCalls, 100);
  assert.equal(refiner.usage().externalRequests, 100);
});

test("interim events and rerenders do not claim a refinement", () => {
  const gate = createFinalSegmentGate();
  for (const type of ["source.partial", "translation.partial", "metrics", "state"]) {
    const event = { type, sourceText: "interim text" };
    if (shouldRefineFinal(event)) gate.claim("lecture-1", "unexpected");
  }
  assert.equal(gate.claim("lecture-1", "unexpected"), true);
  assert.equal(shouldRefineFinal({ type: "segment.final", sourceText: "   " }), false);
  assert.equal(shouldRefineFinal({ type: "segment.final", sourceText: "final text" }), true);
  assert.equal(shouldRefineFinal({ type: "segment.final", sourceText: "final text", refined: true }), false);
});

test("duplicate segment uses memory cache and never repeats external refinement", async () => {
  const refiner = createIncrementalRefiner();
  const request = validateIncrementalRequest({ lectureId: "lecture-1", sessionId: "lecture-1", segmentId: "7", text: "Single final segment." });
  assert.ok("value" in request);
  let externalCalls = 0;
  const external = async () => { externalCalls += 1; return { translation: "单个最终片段。", provider: "qwen-mt", inputTokens: 4, outputTokens: 5 }; };
  const [first, duplicate] = await Promise.all([refiner.run(request.value, external), refiner.run(request.value, external)]);
  assert.equal(externalCalls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(duplicate.cacheHit, true);
  assert.equal(refiner.usage().cacheHits, 1);
});

test("cache identity includes model and terminology, while unknown usage stays unknown", async () => {
  const refiner = createIncrementalRefiner();
  let calls = 0;
  const external = async () => ({ translation: `译文${++calls}`, provider: "qwen-mt", model: "m" });
  const base = { text: "same", quality: "fast", provider: "qwen-mt", sourceLanguage: "English", targetLanguage: "Chinese", terminologyKey: "[]", tokenEstimate: 1, warning: false };
  await refiner.run({ ...base, model: "m1" }, external);
  await refiner.run({ ...base, model: "m2" }, external);
  await refiner.run({ ...base, model: "m2", terminologyKey: "[[\"term\",\"术语\"]]" }, external);
  assert.equal(calls, 3);
  assert.equal(refiner.usage().unknownUsageResponses, 3);
  assert.equal("estimatedCostUsd" in refiner.usage(), false);
});

test("contract rejects transcript payloads and unsafe segment limits", () => {
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "x", transcript: "old history" }).status, 400);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "x", context: "x".repeat(401) }).status, 400);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "x", context: ["history"] }).status, 400);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "x".repeat(20_001) }).status, 413);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "ok" }).value.warning, false);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "ok", quality: "accurate" }).value.quality, "accurate");
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "abcd", context: "efgh" }).value.tokenEstimate, 2);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "ok", quality: "slow" }).status, 400);
  assert.equal(validateIncrementalRequest({ lectureId: "l", sessionId: "l", segmentId: "s", text: "ok", terminology: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`term-${index}`.repeat(20), "译".repeat(160)])) }).status, 413);
  assert.ok("value" in validateIncrementalRequest({ lectureId: "lecture", sessionId: "session", segmentId: "s", text: "ok" }));
});
