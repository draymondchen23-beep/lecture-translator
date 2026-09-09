import test from "node:test";
import assert from "node:assert/strict";
import { buildGlossary, annotatePair } from "../app/lecture-translator/paired-annotations.mjs";
import { groupParagraphs } from "../app/lecture-translator/paragraph-grouping.mjs";

const marked = (tokens) => tokens.filter((token) => token.id).map((token) => token.text);
test("course terminology overrides notes and built-ins without losing matching explanations", () => {
  const glossary = buildGlossary({ scaffold: "支架结构" }, [{ english: "scaffold", chinese: "支架结构", explanation: "课程说明" }]);
  assert.deepEqual(glossary.find((term) => term.english === "scaffold"), { kind: "term", english: "scaffold", chinese: "支架结构", explanation: "课程说明" });
});
test("matches repeated bilingual terms, respects English boundaries and preserves raw text", () => {
  const source = "Scaffold, scaffolding, scaffold. <b>";
  const result = annotatePair(source, "支架以及支架", buildGlossary());
  assert.deepEqual(marked(result.source), ["Scaffold", "scaffold"]);
  assert.deepEqual(marked(result.translation), ["支架", "支架"]);
  assert.equal(result.source.map((token) => token.text).join(""), source);
  assert.equal(new Set(result.source.filter((token) => token.id).map((token) => token.id)).size, 1);
});
test("longer phrases win overlaps; target does not inherit a suppressed match", () => {
  const result = annotatePair("extracellular matrix", "细胞外基质，基质", buildGlossary({ matrix: "基质" }));
  assert.deepEqual(marked(result.source), ["extracellular matrix"]);
  assert.deepEqual(marked(result.translation), ["细胞外基质"]);
});
test("late and revised translations recompute pairing without using neighboring segments", () => {
  const glossary = buildGlossary();
  assert.deepEqual(marked(annotatePair("scaffold", "", glossary).source), ["scaffold"]);
  assert.deepEqual(marked(annotatePair("scaffold", "", glossary).translation), []);
  assert.deepEqual(marked(annotatePair("scaffold", "支架", glossary).translation), ["支架"]);
  assert.deepEqual(marked(annotatePair("a different sentence", "支架", glossary).translation), []);
  assert.deepEqual(marked(annotatePair("scaffold", "不同译文", glossary).translation), []);
});
test("expression explanation requires its contextual translation in the same pair", () => {
  const glossary = buildGlossary();
  const source = "Take this with a pinch of salt.";
  const result = annotatePair(source, "对此有所保留。", glossary);
  assert.equal(result.entries[0].kind, "idiom");
  assert.deepEqual(marked(result.translation), ["有所保留"]);
  assert.equal(annotatePair(source, "加一撮盐。", glossary).entries.length, 0);
});
test("literal punctuation, whitespace and Unicode do not corrupt offsets", () => {
  const glossary = buildGlossary({ "C++": "C加加", "cell adhesion": "细胞黏附" });
  const source = "İ C++ and cell\nadhesion";
  const result = annotatePair(source, "C加加与细胞黏附", glossary);
  assert.deepEqual(marked(result.source), ["C++", "cell\nadhesion"]);
  assert.equal(result.source.map((token) => token.text).join(""), source);
});
test("legacy two-column grouping preserves per-segment annotation correspondence", () => {
  const segments = [
    { id: "one", sequence: 0, sourceText: "The extracellular matrix helps cells, and", translatedText: "细胞外基质帮助细胞，", sourceStatus: "final" },
    { id: "two", sequence: 1, sourceText: "it supports cell adhesion.", translatedText: "并支持细胞黏附。", sourceStatus: "final" },
    { id: "three", sequence: 2, sourceText: "We discuss a scaffold.", translatedText: "我们讨论支架。", sourceStatus: "final" },
  ];
  const rows = groupParagraphs(segments);
  assert.deepEqual(rows.map((row) => row.segments.map((segment) => segment.id)), [["one", "two"], ["three"]]);
  const glossary = buildGlossary();
  const first = rows[0].segments.map((segment) => annotatePair(segment.sourceText, segment.translatedText, glossary));
  assert.deepEqual(first.flatMap((pair) => marked(pair.translation)), ["细胞外基质", "细胞黏附"]);
  assert.deepEqual(groupParagraphs(segments.map((segment) => ({ ...segment, translatedText: "" }))).map((row) => row.id), rows.map((row) => row.id));
});
