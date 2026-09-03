/**
 * Small, runtime-neutral state machine for incremental speech captions.
 *
 * A recognizer's interim result is a replaceable snapshot; only its final
 * result becomes stable source text.  That distinction prevents rewritten
 * interim hypotheses from being appended to a sentence more than once.
 */

/** @typedef {{ id: string, text: string, stableText: string, tentativeText: string, isFinal: boolean, at: number }} CaptionSnapshot */
/** @typedef {{ sourceText: string, boundary: "hard" | "soft" | "grace" | "forced", index: number }} SentenceCommit */

export const DEFAULT_BOUNDARY_CONFIG = Object.freeze({
  // Stable clause boundaries are responsive without being tied to a browser
  // recognition end. Silence remains a separate, more conservative signal.
  softMinWords: 6,
  boundaryGraceMs: 350,
  softSilenceMs: 900,
  hardSilenceMs: 1_800,
  resumeMergeMs: 1_200,
  maxDurationMs: 15_000,
  maxWords: 38,
  maxChars: 220,
});

const CLOSERS = new Set(["\"", "'", "”", "’", ")", "]", "}"]);
const TERMINATORS = new Set([".", "!", "?", "。", "！", "？"]);
const SOFT_MARKS = new Set([";", "；", ":", "：", ",", "，", "—", "–"]);
const ABBREVIATIONS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.",
  "fig.", "eq.", "no.", "inc.", "ltd.", "co.", "jan.", "feb.", "mar.", "apr.",
  "jun.", "jul.", "aug.", "sep.", "sept.", "oct.", "nov.", "dec.", "e.g.", "i.e.",
]);

function text(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function wordCount(value) {
  return text(value).split(/\s+/).filter(Boolean).length;
}

function token(value) {
  return value.toLowerCase().replace(/^\W+|\W+$/g, "");
}

function mergeText(current, incoming) {
  const left = text(current);
  const right = text(incoming);
  if (!left || !right) return left || right;
  if (left === right || left.endsWith(` ${right}`)) return left;
  if (right.startsWith(`${left} `)) return right;

  const previous = left.split(" ");
  const next = right.split(" ");
  for (let size = Math.min(previous.length, next.length); size > 0; size -= 1) {
    if (previous.slice(-size).map(token).join("\u0000") === next.slice(0, size).map(token).join("\u0000")) {
      if (size === previous.length && size === next.length) return right;
      return `${left} ${next.slice(size).join(" ")}`.trim();
    }
  }
  return `${left} ${right}`;
}

function isFalsePeriod(textValue, start, end) {
  if (textValue[start] !== ".") return false;
  const before = textValue[start - 1] || "";
  const after = textValue[end] || "";
  // 3.14 and 1.000 are not sentence endings.
  if (/\d/.test(before) && /\d/.test(after)) return true;
  const space = Math.max(textValue.lastIndexOf(" ", start - 1), textValue.lastIndexOf("\n", start - 1));
  const lastToken = textValue.slice(space + 1, end).toLowerCase();
  return ABBREVIATIONS.has(lastToken) || /^(?:[a-z]\.){2,}$/i.test(lastToken);
}

function punctuationEnd(textValue, start, allowed) {
  let end = start;
  while (end < textValue.length && allowed.has(textValue[end])) end += 1;
  while (end < textValue.length && CLOSERS.has(textValue[end])) end += 1;
  return end;
}

/**
 * Normalizes the different shape used by browser and server speech events.
 * A missing id is valid but cannot provide idempotency across deliveries.
 *
 * @param {unknown} input
 * @param {number} [fallbackAt]
 * @returns {CaptionSnapshot}
 */
export function normalizeCaptionSnapshot(input, fallbackAt = Date.now()) {
  const value = input && typeof input === "object" ? input : {};
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const at = typeof candidate.at === "number" && Number.isFinite(candidate.at)
    ? candidate.at
    : typeof candidate.startedAt === "number" && Number.isFinite(candidate.startedAt)
      ? candidate.startedAt
      : fallbackAt;
  return {
    id: candidate.id === undefined || candidate.id === null ? "" : String(candidate.id),
    text: text(candidate.text ?? candidate.transcript),
    stableText: text(candidate.stableText),
    tentativeText: text(candidate.tentativeText ?? (candidate.isFinal ?? candidate.final ? "" : candidate.text ?? candidate.transcript)),
    isFinal: Boolean(candidate.isFinal ?? candidate.final),
    at,
  };
}

/**
 * Returns sentence endings that are safe to use immediately.  A decimal and
 * common abbreviation period is deliberately left in the running sentence.
 */
export function findSentenceBoundaries(value) {
  const source = text(value);
  const boundaries = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!TERMINATORS.has(source[index])) continue;
    const end = punctuationEnd(source, index, TERMINATORS);
    if (end < source.length && !/\s/.test(source[end])) continue;
    if (isFalsePeriod(source, index, end)) continue;
    boundaries.push({ start: index, end, kind: "hard" });
    index = end - 1;
  }
  return boundaries;
}

/** @param {string} value */
function safeSoftBoundary(value, config, allowTrailing = false) {
  const source = text(value);
  let candidate = null;
  for (let index = 0; index < source.length; index += 1) {
    if (!SOFT_MARKS.has(source[index])) continue;
    const end = punctuationEnd(source, index, SOFT_MARKS);
    if (end < source.length && !/\s/.test(source[end])) continue;
    const before = source.slice(0, end).trim();
    const after = source.slice(end).trim();
    if (wordCount(before) < config.softMinWords) continue;
    // A comma in a number is never a phrase boundary.  A trailing comma needs
    // a longer clause than an internal comma before it is safe to flush.
    if ((source[index] === "," || source[index] === "，") && /\d/.test(source[index - 1] || "") && /\d/.test(source[end] || "")) continue;
    if (after && wordCount(after) < 3) continue;
    if (!after && !allowTrailing) continue;
    candidate = { end, kind: "soft" };
  }
  return candidate;
}

function forcedSplit(value, config) {
  const source = text(value);
  const words = source.split(" ");
  if (words.length <= config.maxWords && source.length <= config.maxChars) return null;
  const soft = safeSoftBoundary(source, config);
  if (soft) return soft;
  const count = Math.min(config.maxWords, words.length);
  return { end: words.slice(0, count).join(" ").length, kind: "forced" };
}

/** Returns the exact word-prefix shared by two browser interim snapshots. */
export function commonStablePrefix(previousValue, nextValue) {
  const previous = text(previousValue).split(" ").filter(Boolean);
  const next = text(nextValue).split(" ").filter(Boolean);
  let length = 0;
  while (length < previous.length && length < next.length && token(previous[length]) === token(next[length])) length += 1;
  return next.slice(0, length).join(" ");
}

/** @param {string} value @param {string} prefix */
export function textAfterStablePrefix(value, prefix) {
  const source = text(value);
  const stable = text(prefix);
  const sourceWords = source.split(" ").filter(Boolean);
  const stableWords = stable.split(" ").filter(Boolean);
  if (!stableWords.length) return source;
  if (stableWords.length >= sourceWords.length) {
    return stableWords.length === sourceWords.length && stableWords.every((part, index) => token(part) === token(sourceWords[index])) ? "" : source;
  }
  if (!stableWords.every((part, index) => token(part) === token(sourceWords[index]))) return source;
  return sourceWords.slice(stableWords.length).join(" ");
}

/**
 * Accepts speech snapshots and emits complete source units.  Calls are pure
 * from the caller's perspective: each result contains the next display state
 * plus only the commits newly created by that call.
 */
export class SentenceAccumulator {
  /** @param {Partial<typeof DEFAULT_BOUNDARY_CONFIG>} [config] */
  constructor(config = {}) {
    this.config = { ...DEFAULT_BOUNDARY_CONFIG, ...config };
    this.stableText = "";
    this.tentativeText = "";
    this.lastStableAt = 0;
    this.sentenceStartedAt = 0;
    this.commitIndex = 0;
    this.finalSnapshots = new Map();
  }

  /** @returns {{ stableText: string, tentativeText: string, displayText: string, commits: SentenceCommit[] }} */
  snapshot(commits = []) {
    return {
      stableText: this.stableText,
      tentativeText: this.tentativeText,
      displayText: mergeText(this.stableText, this.tentativeText),
      commits,
    };
  }

  /** @param {string} boundary @param {number} end @param {number} now @returns {SentenceCommit | null} */
  commitThrough(boundary, end, now) {
    const sourceText = text(this.stableText.slice(0, end));
    this.stableText = text(this.stableText.slice(end));
    this.sentenceStartedAt = this.stableText ? now : 0;
    if (!sourceText) return null;
    return { sourceText, boundary: /** @type {SentenceCommit["boundary"]} */ (boundary), index: this.commitIndex++ };
  }

  takeImmediateBoundaries(now, final = false) {
    const commits = [];
    while (this.stableText) {
      const hard = findSentenceBoundaries(this.stableText)[0];
      if (hard) {
        const commit = this.commitThrough(hard.kind, hard.end, now);
        if (commit) commits.push(commit);
        continue;
      }
      const soft = safeSoftBoundary(this.stableText, this.config);
      if (soft && (final || now - this.lastStableAt >= this.config.boundaryGraceMs)) {
        const commit = this.commitThrough(soft.kind, soft.end, now);
        if (commit) commits.push(commit);
        continue;
      }
      const forced = forcedSplit(this.stableText, this.config);
      if (forced) {
        const commit = this.commitThrough(forced.kind, forced.end, now);
        if (commit) commits.push(commit);
        continue;
      }
      break;
    }
    return commits;
  }

  /** @param {unknown} input @param {number} [now] */
  ingest(input, now = Date.now()) {
    const next = normalizeCaptionSnapshot(input, now);
    if (!next.isFinal) {
      if (next.stableText) {
        const before = this.stableText;
        this.stableText = mergeText(this.stableText, next.stableText);
        if (this.stableText !== before) {
          this.lastStableAt = next.at;
          if (!this.sentenceStartedAt) this.sentenceStartedAt = next.at;
        }
      }
      this.tentativeText = next.tentativeText;
      return this.snapshot(this.takeImmediateBoundaries(now));
    }

    if (next.id && this.finalSnapshots.has(next.id)) return this.snapshot();
    if (next.id) {
      this.finalSnapshots.set(next.id, next.text);
      // Browser recognition index ids are bounded per recognition session.
      if (this.finalSnapshots.size > 512) this.finalSnapshots.delete(this.finalSnapshots.keys().next().value);
    }
    this.tentativeText = "";
    if (next.stableText) {
      const before = this.stableText;
      this.stableText = mergeText(this.stableText, next.stableText);
      if (this.stableText !== before) {
        this.lastStableAt = next.at;
        if (!this.sentenceStartedAt) this.sentenceStartedAt = next.at;
      }
    }
    if (next.text) {
      const before = this.stableText;
      this.stableText = mergeText(this.stableText, next.text);
      if (this.stableText !== before) {
        this.lastStableAt = next.at;
        if (!this.sentenceStartedAt) this.sentenceStartedAt = next.at;
      }
    }
    return this.snapshot(this.takeImmediateBoundaries(now, true));
  }

  /** @param {number} [now] @param {{ force?: boolean }} [options] */
  advance(now = Date.now(), options = {}) {
    const commits = this.takeImmediateBoundaries(now);
    if (!this.stableText) return this.snapshot(commits);
    if (options.force) {
      const commit = this.commitThrough("forced", this.stableText.length, now);
      if (commit) commits.push(commit);
      return this.snapshot(commits);
    }
    const inactiveFor = now - this.lastStableAt;
    if (this.sentenceStartedAt && now - this.sentenceStartedAt >= this.config.maxDurationMs) {
      const commit = this.commitThrough("forced", this.stableText.length, now);
      if (commit) commits.push(commit);
    } else if (inactiveFor >= this.config.softSilenceMs) {
      const soft = safeSoftBoundary(this.stableText, this.config, true);
      if (soft) {
        const commit = this.commitThrough(soft.kind, soft.end, now);
        if (commit) commits.push(commit);
      }
    }
    if (!commits.length && inactiveFor >= this.config.hardSilenceMs) {
      const commit = this.commitThrough("grace", this.stableText.length, now);
      if (commit) commits.push(commit);
    }
    if (commits.length) this.lastStableAt = now;
    return this.snapshot(commits);
  }
}

/**
 * Preserves sentence order when translation latency varies. `run` receives
 * each item exactly once; a failed item does not block the next sentence.
 */
export function createSentenceTranslationQueue(run) {
  let tail = Promise.resolve();
  return {
    enqueue(item) {
      const task = tail.then(() => run(item));
      tail = task.catch(() => undefined);
      return task;
    },
    idle() {
      return tail;
    },
  };
}
