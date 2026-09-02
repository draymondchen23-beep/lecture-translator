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
