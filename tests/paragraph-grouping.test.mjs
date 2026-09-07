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

test("twenty continuous snapshots stay in one paragraph", () => {
  const snapshots = Array.from({ length: 20 }, (_, sequence) => segment(`s${sequence}`, sequence, `Continuous explanation ${sequence}.`, sequence * 2, sequence * 2 + 1));
  const migrated = migrateParagraphIds(snapshots);
  assert.equal(new Set(migrated.map((item) => item.paragraphId)).size, 1);
});

test("only conservative semantic boundaries create a paragraph", () => {
  assert.equal(isCompleteSemantic("For example."), false);
  assert.equal(isCompleteSemantic("Dr."), false);
  assert.equal(isCompleteSemantic("e.g."), false);
  assert.equal(isCompleteSemantic("The value is 3.14."), true);
  assert.equal(isCompleteSemantic("Cells respond and"), false);
  const first = { ...segment("a", 0, "The matrix is active.", 0, 1), paragraphId: "paragraph:a" };
  const continuing = segment("b", 1, "It changes cell behaviour.", 1.5, 2);
  const topic = segment("c", 2, "Now, let us measure stiffness.", 8, 9);
  assert.equal(assignParagraphId([first], continuing), "paragraph:a");
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
  assert.equal(reloaded[0].paragraphId, reloaded[1].paragraphId);
  assert.equal(reloaded[0].bookmarked, true);
});
