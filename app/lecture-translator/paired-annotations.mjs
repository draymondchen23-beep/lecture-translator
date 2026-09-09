/** @typedef {{kind: 'term'|'idiom', english: string, chinese: string, explanation: string}} Entry */
const terms = [
  ["extracellular matrix", "细胞外基质"], ["scaffold", "支架"],
  ["biomaterial", "生物材料"], ["biomaterials", "生物材料"],
  ["tissue engineering", "组织工程"], ["cell adhesion", "细胞黏附"],
  ["biocompatibility", "生物相容性"], ["gene expression", "基因表达"],
  ["Young's modulus", "杨氏模量"], ["action potential", "动作电位"],
];
const expressions = [
  ["with a pinch of salt", "有所保留", "不要完全采信，应保留判断；不是字面上的加盐。"],
  ["in a nutshell", "简而言之", "表示用几句话概括要点。"],
  ["a ballpark figure", "粗略估计", "表示大致数值，而不是精确测量。"],
  ["the elephant in the room", "避而不谈的问题", "指大家意识到、却不愿直接讨论的问题。"],
  ["break the ice", "打破僵局", "常指缓和初次见面或交流时的拘谨气氛。"],
];

/** Course choices override notes, which override the small built-in vocabulary. */
export function buildGlossary(sessionTerms = {}, noteTerms = []) {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  const add = (english, chinese, explanation = "", kind = "term") => {
    if (typeof english !== "string" || typeof chinese !== "string") return;
    english = english.trim(); chinese = chinese.trim();
    const key = english.toLowerCase();
    if (!english || !chinese || entries.has(key)) return;
    entries.set(key, { english, chinese, kind: kind === "idiom" ? "idiom" : "term", explanation: typeof explanation === "string" ? explanation : "" });
  };
  const notes = Array.isArray(noteTerms) ? noteTerms : [];
  for (const [english, chinese] of Object.entries(sessionTerms || {})) {
    const note = notes.find((item) => item?.english?.toLowerCase() === english.toLowerCase() && item?.chinese === chinese);
    add(english, chinese, note?.explanation);
  }
  for (const item of notes) if (item) add(item.english, item.chinese, item.explanation);
  for (const [english, chinese] of terms) add(english, chinese);
  for (const [english, chinese, explanation] of expressions) add(english, chinese, explanation, "idiom");
  return [...entries.values()].sort((a, b) => b.english.length - a.english.length);
}

function matches(text, phrase, english) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const regex = new RegExp(escaped, english ? "giu" : "gu");
  return [...text.matchAll(regex)].filter((match) => !english || (
    !/[\p{L}\p{N}_]/u.test(text.slice(0, match.index).at(-1) || "") &&
    !/[\p{L}\p{N}_]/u.test(text.slice(match.index + match[0].length)[0] || "")
  )).map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function acceptRanges(ranges) {
  const accepted = [];
  for (const range of ranges.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
    if (!accepted.some((item) => range.start < item.end && range.end > item.start)) accepted.push(range);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function tokenize(text, ranges) {
  /** @type {Array<{text: string, id?: string}>} */
  const tokens = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) tokens.push({ text: text.slice(cursor, range.start) });
    tokens.push({ text: text.slice(range.start, range.end), id: range.id });
    cursor = range.end;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

/** Match within this revision of this pair only; never rewrite or inject HTML. */
export function annotatePair(source = "", translation = "", glossary = []) {
  const candidates = [];
  const sourceRanges = [];
  const targetRanges = [];
  for (const item of glossary) {
    const sourceMatches = matches(source, item.english, true);
    if (!sourceMatches.length) continue;
    const targetMatches = matches(translation, item.chinese, false);
    // A common expression is annotated only when its usual reading is also in the translation.
    if (item.kind === "idiom" && !targetMatches.length) continue;
    const id = `${item.kind}:${item.english.toLowerCase()}`;
    candidates.push({ ...item, id });
    sourceRanges.push(...sourceMatches.map((range) => ({ ...range, id })));
    targetRanges.push(...targetMatches.map((range) => ({ ...range, id })));
  }
  const acceptedSource = acceptRanges(sourceRanges);
  const ids = new Set(acceptedSource.map((range) => range.id));
  return {
    source: tokenize(source, acceptedSource),
    translation: tokenize(translation, acceptRanges(targetRanges.filter((range) => ids.has(range.id)))),
    entries: candidates.filter((item) => ids.has(item.id)),
  };
}
