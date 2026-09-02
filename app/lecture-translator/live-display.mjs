// Display-only helpers. Realtime events and persisted segments must keep the
// complete cumulative text; these helpers only decide what is visible now.
export function codePoints(text) {
  return Array.from(text || "");
}

export function codePointLength(text) {
  return codePoints(text).length;
}

export function commonPrefixByCodePoint(first, second) {
  const a = codePoints(first);
  const b = codePoints(second);
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return a.slice(0, length).join("");
}

/**
 * Keep the part already shown that is still valid when a cumulative target is
 * rewritten. This prevents a correction from flashing back to an empty line.
 */
export function reconcileDisplayedPrefix(previousTarget, displayed, nextTarget) {
  const shared = codePointLength(commonPrefixByCodePoint(previousTarget, nextTarget));
  return codePoints(displayed).slice(0, Math.min(codePointLength(displayed), shared)).join("");
}

export function advanceDisplayedText(displayed, target) {
  const next = codePoints(target);
  const current = codePoints(displayed).slice(0, next.length);
  // A target rewrite should never retain a character that is no longer its
  // prefix; the caller normally reconciles first, but this keeps each tick safe.
  let shared = 0;
  while (shared < current.length && shared < next.length && current[shared] === next[shared]) shared += 1;
  return next.slice(0, Math.min(shared + 1, next.length)).join("");
}

export function progressiveDelay(backlog, base = 34) {
  if (backlog <= 0) return 0;
  // Catch up with a large backlog by shortening the interval, never by
  // revealing multiple code points in one tick.
  return Math.max(10, base - Math.min(24, Math.floor(Math.max(0, backlog - 1) / 3)));
}

export function centerOffset(container, target) {
  return (target.top + target.height / 2) - (container.top + container.height / 2);
}

export function shouldRecenter(container, target, tolerance = 24) {
  return Math.abs(centerOffset(container, target)) > tolerance;
}

export function visibleContentRect(container, dockTop, gap = 12) {
  const bottom = Math.min(container.top + container.height, dockTop - gap);
  return { top: container.top, height: Math.max(0, bottom - container.top) };
}

/** Compute the bounded scrollTop that puts a row at the visible center. */
export function centeredScrollTop({
  currentScrollTop,
  scrollHeight,
  clientHeight,
  containerTop,
  targetTop,
  targetHeight,
  dockTop,
  stickyTop = 0,
  gap = 12,
}) {
  const visibleTop = containerTop + Math.max(0, stickyTop);
  const visibleBottom = Math.min(containerTop + clientHeight, dockTop - gap);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  if (!visibleHeight) return Math.max(0, Math.min(currentScrollTop, scrollHeight - clientHeight));
  const targetCenter = targetTop + targetHeight / 2;
  const visibleCenter = visibleTop + visibleHeight / 2;
  const desired = currentScrollTop + targetCenter - visibleCenter;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(maxScrollTop, desired));
}

const ENDS = {
  en: new Set([".", "!", "?"]),
  zh: new Set(["。", "！", "？"]),
};
const CLOSERS = new Set(["\"", "'", "”", "’", "»", "）", "】", "」", "』", ")", "]"]);

export function splitSentences(text, language = "en") {
  const points = codePoints(text).join("").trim();
  if (!points) return [];
  const chars = codePoints(points);
  const endings = ENDS[language === "zh" ? "zh" : "en"];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (!endings.has(chars[index])) continue;
    // Do not split an ellipsis into three tiny lines.
    if (chars[index] === "." && chars[index + 1] === ".") continue;
    let end = index + 1;
    while (end < chars.length && CLOSERS.has(chars[end])) end += 1;
    const sentence = chars.slice(start, end).join("").trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }
  const tail = chars.slice(start).join("").trim();
  if (tail) sentences.push(tail);
  return sentences;
}
