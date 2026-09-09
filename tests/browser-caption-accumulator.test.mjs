import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCaptionAccumulator } from "../app/lecture-translator/browser-caption-accumulator.mjs";

const commits = (update) => update.commits.map((item) => item.sourceText);

test("explicit stop preserves actual sentence boundaries inside a tentative snapshot", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "First short sentence. Second short sentence.", false, 0);
  const stopped = captions.advance(1, { force: true });
  assert.deepEqual(commits(stopped), ["First short sentence.", "Second short sentence."]);
  assert.equal(stopped.displayText, "");
});

test("many one-word finals stay one fluent source unit until a real boundary", () => {
  const captions = new BrowserCaptionAccumulator();
  for (const [index, word] of ["and", "it is", "a", "really", "rewarding", "thing."].entries()) {
    const update = captions.update(`0:${index}`, word, true, index + 1);
    assert.deepEqual(commits(update), index === 5 ? ["and it is a really rewarding thing."] : []);
  }
});

test("different ids retain genuine repeats and a final corrects only its own pending suffix", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "yes", true, 1);
  captions.update("0:1", "yes", true, 2);
  captions.update("0:1", "yes indeed", true, 3);
  const update = captions.update("0:2", "that is correct.", true, 4);
  assert.deepEqual(commits(update), ["yes yes indeed that is correct."]);
});

test("interim is replaceable while finals accumulate across restart ids and flush only on silence/stop", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "one two three", false, 1);
  captions.update("0:0", "one two four", false, 2);
  captions.update("0:0", "one two four", true, 3);
  captions.update("1:0", "five six seven", true, 4);
  assert.deepEqual(commits(captions.advance(500)), []);
  const silence = captions.advance(2_000);
  assert.deepEqual(commits(silence), ["one two four five six seven"]);
});

test("silence keeps a dangling short phrase pending but explicit stop retains it", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "and", true, 1);
  captions.update("1:0", "it is", true, 2);
  assert.deepEqual(commits(captions.advance(2_000)), []);
  assert.deepEqual(commits(captions.advance(2_001, { force: true })), ["and it is"]);
});

test("bounded commits consume across multiple final ids without loss or duplication", () => {
  const captions = new BrowserCaptionAccumulator({ maxWords: 5, maxChars: 120 });
  const output = [];
  for (let index = 0; index < 12; index += 1) output.push(...commits(captions.update(`0:${index}`, `word${index + 1}`, true, index + 1)));
  output.push(...commits(captions.advance(100, { force: true })));
  assert.equal(output.join(" "), Array.from({ length: 12 }, (_, index) => `word${index + 1}`).join(" "));
  assert.ok(output.every((line) => line.split(" ").length <= 5));
});

test("interim ids and restart runs retain pending tails without re-adding consumed prefixes", () => {
  const captions = new BrowserCaptionAccumulator({ maxWords: 5, maxChars: 120 });
  captions.update("0:0", "one two three four five six", false, 1);
  const committed = captions.update("0:0", "one two three four five six", false, 2);
  captions.update("0:1", "seven eight", false, 3);
  captions.update("1:0", "nine ten", false, 4);
  const final = captions.update("0:0", "one two three four five six", true, 5);
  const stop = captions.advance(6, { force: true });
  assert.equal([...commits(committed), ...commits(final), ...commits(stop)].join(" "), "one two three four five six seven eight nine ten");
});

test("revisable interim punctuation waits for grace instead of committing immediately", () => {
  const captions = new BrowserCaptionAccumulator({ boundaryGraceMs: 400 });
  captions.update("0:0", "The cell.", false, 1);
  const revised = captions.update("0:0", "The cell membrane", false, 2);
  assert.deepEqual(commits(revised), []);
});

test("force flush clears the display and cannot emit the same source twice", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "one two three", true, 1);
  const first = captions.advance(2, { force: true });
  const second = captions.advance(3, { force: true });
  assert.deepEqual(commits(first), ["one two three"]);
  assert.equal(first.displayText, "");
  assert.deepEqual(commits(second), []);
  assert.equal(second.displayText, "");
});

test("stable prefix plus tentative tail stays ordered when a newer result finalizes", () => {
  const captions = new BrowserCaptionAccumulator();
  captions.update("0:0", "one two three", false, 1);
  captions.update("0:0", "one two three", false, 2);
  const final = captions.update("0:1", "four five six.", true, 3);
  const update = captions.advance(4, { force: true });
  assert.equal([...commits(final), ...commits(update)].join(" "), "one two three four five six.");
  assert.equal(update.displayText, "");
});

test("a fully committed interim result can later contribute its new suffix", () => {
  const captions = new BrowserCaptionAccumulator({ boundaryGraceMs: 1 });
  captions.update("0:0", "one two.", false, 1);
  captions.update("0:0", "one two.", false, 2);
  const committed = captions.advance(4);
  captions.update("0:0", "one two. three four", false, 5);
  const tail = captions.advance(6, { force: true });
  assert.equal([...commits(committed), ...commits(tail)].join(" "), "one two. three four");
});

test("force after a capped stable snapshot emits only its remaining tail", () => {
  const source = Array.from({ length: 22 }, (_, index) => `word${index + 1}`).join(" ");
  const captions = new BrowserCaptionAccumulator({ maxWords: 18, maxChars: 120 });
  captions.update("0:0", source, false, 1);
  const seeded = captions.update("0:0", source, false, 2);
  const forced = captions.advance(3, { force: true });
  assert.equal([...commits(seeded), ...commits(forced)].join(" "), source);
  assert.ok([...commits(seeded), ...commits(forced)].every((line) => line.split(" ").length <= 18));
});
