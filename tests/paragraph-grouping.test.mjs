import test from "node:test";
import assert from "node:assert/strict";
import { assignParagraphId, groupParagraphs, isCompleteSemantic, migrateParagraphIds } from "../app/lecture-translator/paragraph-grouping.mjs";

const segment = (id, sequence, sourceText, startTime, endTime, extra = {}) => ({ id, sequence, sourceText, startTime, endTime, speaker: "Lecturer", ...extra });

test("paragraph ids stay stable across source and translation revisions", () => {
  const first = { ...segment("a", 0, "Cells communicate, and you", 0, 1), paragraphId: "paragraph:a", bookmarked: true, sourceRevision: 1 };
  const second = segment("b", 1, "do things through signalling.", 1.2, 2);
  second.paragraphId = assignParagraphId([first], second);
  const revised = { ...first, sourceText: "Cells communicate, and you do things", sourceRevision: 2 };
  assert.equal(second.paragraphId, "paragraph:a");
  assert.equal(revised.paragraphId, "paragraph:a");
  assert.equal(revised.bookmarked, true);
  assert.deepEqual(groupParagraphs([revised, second]).map((item) => item.segments.map((value) => value.id)), [["a", "b"]]);
});

test("twenty consecutive complete sentences realign without pauses or topic changes", () => {
  const snapshots = Array.from({ length: 20 }, (_, sequence) => segment(`s${sequence}`, sequence, `Continuous explanation ${sequence}.`, sequence * 2, sequence * 2 + 1));
  const migrated = migrateParagraphIds(snapshots);
  assert.equal(new Set(migrated.map((item) => item.paragraphId)).size, 20);
});

test("only conservative semantic boundaries create a paragraph", () => {
  assert.equal(isCompleteSemantic("For example."), false);
  assert.equal(isCompleteSemantic("Dr."), false);
  assert.equal(isCompleteSemantic("e.g."), false);
  assert.equal(isCompleteSemantic("The value is 3.14."), true);
  assert.equal(isCompleteSemantic("Cells respond and"), false);
  assert.equal(isCompleteSemantic("Cells respond, and you."), false);
  assert.equal(isCompleteSemantic("I trust you."), true);
  assert.equal(isCompleteSemantic("What is this device for?"), true);
  assert.equal(isCompleteSemantic("What does the reading depend on?"), true);
  assert.equal(isCompleteSemantic('Dr. Smith measured 3.5 mm."'), true);
  assert.equal(isCompleteSemantic("Wait..."), false);
  const first = { ...segment("a", 0, "The matrix is active.", 0, 1), paragraphId: "paragraph:a" };
  const continuing = segment("b", 1, "It changes cell behaviour.", 1.5, 2);
  const topic = segment("c", 2, "Now, let us measure stiffness.", 8, 9);
  assert.equal(assignParagraphId([first], continuing), "paragraph:b");
  assert.equal(assignParagraphId([first, { ...continuing, paragraphId: "paragraph:a" }], topic), "paragraph:c");
  const provisional = { ...first, sourceStatus: "draft", endTime: 0 };
  assert.equal(assignParagraphId([provisional], segment("draft-next", 1, "Now, a new subject.", 100, 101)), "paragraph:a");
  const otherSpeaker = segment("speaker", 1, "Can I ask a question?", 1.1, 2, { speaker: "Student" });
  assert.equal(assignParagraphId([{ ...provisional, paragraphId: "paragraph:a" }], otherSpeaker), "paragraph:speaker");
});

test("legacy migration persists ids and preserves bookmarks after JSON roundtrip", () => {
  const legacy = [segment("a", 0, "The matrix is active.", 0, 1, { bookmarked: true }), segment("b", 1, "It signals to cells.", 1.2, 2)];
  const migrated = migrateParagraphIds(legacy);
  const reloaded = migrateParagraphIds(JSON.parse(JSON.stringify(migrated)));
  assert.notEqual(reloaded[0].paragraphId, reloaded[1].paragraphId);
  assert.deepEqual(reloaded, migrated);
  assert.equal(reloaded[0].bookmarked, true);
});

test("legacy long paragraphs are regrouped by source sentence with all translations intact", () => {
  const legacy = [
    segment("a", 0, "The English explanation is long enough to wrap over several physical lines.", 0, 1, { translatedText: "英文很长。", paragraphId: "paragraph:a" }),
    segment("b", 1, "It works.", 1, 2, { translatedText: "它起作用了。这里用两句中文表达，仍属于一个英文句子。", paragraphId: "paragraph:a" }),
    segment("c", 2, "The next sentence begins here.", 2, 3, { translatedText: "下一句从这里开始。", paragraphId: "paragraph:a" }),
  ];
  const rows = groupParagraphs(legacy);
  assert.deepEqual(rows.map((row) => row.segments.map((item) => item.id)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(rows.flatMap((row) => row.segments.map((item) => item.translatedText)), legacy.map((item) => item.translatedText));
});

test("late target revisions fill the original sentence without creating or moving rows", () => {
  const input = [segment("a", 0, "Cells communicate, and you", 0, 1), segment("b", 1, "do things through signalling.", 1, 2), segment("c", 2, "The next sentence starts now.", 2, 3)];
  const before = groupParagraphs(input);
  const after = groupParagraphs(input.map((item) => item.id === "a" ? { ...item, translatedText: "细胞会交流。这个译文包含两个中文句子。", translationRevision: 3, translationStatus: "final" } : item));
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id));
  assert.deepEqual(after.map((row) => row.segments.map((item) => item.id)), [["a", "b"], ["c"]]);
  assert.ok(after[0].segments[0].translatedText);
  assert.equal(after[1].segments[0].translatedText, undefined);
});

test("final source punctuation arriving after the next item settles the shared boundary", () => {
  const first = segment("a", 0, "The matrix is active", 0, 0, { sourceStatus: "draft" });
  const next = segment("b", 1, "Cells respond.", 1, 2);
  const pending = migrateParagraphIds([first, next]);
  assert.equal(groupParagraphs(pending).length, 1);
  const settled = groupParagraphs(pending.map((item) => item.id === "a" ? { ...item, sourceText: "The matrix is active.", sourceStatus: "final" } : item));
  assert.deepEqual(settled.map((row) => row.id), ["paragraph:a", "paragraph:b"]);
});

test("time limits and ASR final cannot split an unfinished sentence", () => {
  const pieces = [segment("a", 0, "We investigate the response because", 0, 1, { sourceStatus: "final" }), segment("b", 1, "it can depend on", 30, 31, { sourceStatus: "final" }), segment("c", 2, "the surrounding tissue.", 60, 61, { sourceStatus: "final" }), segment("d", 3, "That is the result.", 62, 63)];
  assert.deepEqual(groupParagraphs(pieces).map((row) => row.segments.map((item) => item.id)), [["a", "b", "c"], ["d"]]);
});

test("clear unpunctuated independent sentences realign without turning every ASR final into a row", () => {
  const input = [
    "The matrix provides structural support",
    "It also influences cell adhesion",
    "Cells sense stiffness as well as chemistry",
    "That information guides movement",
    "The value is 3.5",
    "It's related to receptor binding",
  ].map((source, index) => segment(String(index), index, source, index, index + 1, { sourceStatus: "final" }));
  assert.equal(groupParagraphs(input).length, 6);
});

test("unpunctuated continuation and complement fragments stay in the same sentence", () => {
  for (const pieces of [
    ["The matrix affects cells and you", "do things such as move through tissue"],
    ["We know", "the cells respond to stiffness"],
    ["Because the cells respond to stiffness", "the tissue changes its structure"],
    ["The matrix influences cell adhesion", "which helps cells move through tissue"],
    ["The matrix is", "the material that provides support"],
  ]) {
    const input = pieces.map((source, index) => segment(String(index), index, source, index * 30, index * 30 + 1, { sourceStatus: "final" }));
    assert.equal(groupParagraphs(input).length, 1, pieces.join(" / "));
  }
});

test("unpunctuated completeness is assessed across the source fragments of the sentence", () => {
  const input = ["The matrix depends on", "the surrounding tissue", "Cells respond to stiffness"]
    .map((source, index) => segment(String(index), index, source, index, index + 1, { sourceStatus: "final" }));
  assert.deepEqual(groupParagraphs(input).map((row) => row.segments.map((item) => item.id)), [["0", "1"], ["2"]]);
});
