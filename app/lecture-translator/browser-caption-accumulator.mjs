import { commonStablePrefix, DEFAULT_BOUNDARY_CONFIG, findSentenceBoundaries, SentenceAccumulator } from "./caption-stabilizer.mjs";

const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const words = (value) => clean(value).split(" ").filter(Boolean);

export function isReadableCaption(value, config = DEFAULT_BOUNDARY_CONFIG) {
  const source = clean(value);
  return words(source).length >= config.softMinWords || findSentenceBoundaries(source).some((boundary) => boundary.end === source.length);
}

/** Result IDs own replaceable snapshots; sentence boundaries own output rows. */
export class BrowserCaptionAccumulator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_BOUNDARY_CONFIG, ...config };
    this.entries = new Map();
    this.order = [];
    this.lastActivityAt = null;
    this.startedAt = null;
  }

  update(id, snapshot, isFinal, now = Date.now(), options = {}) {
    const key = String(id || "");
    const source = clean(snapshot);
    if (!key) return this.drain(now, options);
    let entry = this.entries.get(key);
    if (!entry) {
      // Moving to another recognizer result/run retains the preceding audible
      // tail as stable input, without submitting it as a separate sentence.
      for (const previous of this.order) {
        const item = this.entries.get(previous);
        item.stable = item.text;
        item.final = true;
      }
      entry = { text: "", stable: "", consumed: 0, final: false };
      this.entries.set(key, entry);
      this.order.push(key);
    } else if (!this.order.includes(key)) return this.drain(now, options);
    const next = words(source).slice(entry.consumed).join(" ");
    const stable = isFinal ? next : commonStablePrefix(entry.text, next);
    if (next !== entry.text || stable !== entry.stable || isFinal !== entry.final) this.lastActivityAt = now;
    entry.text = next;
    entry.stable = stable;
    entry.final = isFinal;
    if (next && this.startedAt === null) this.startedAt = now;
    return this.drain(now, options);
  }

  displayText() {
    return this.order.map((id) => this.entries.get(id).text).filter(Boolean).join(" ");
  }

  stableText() {
    const prefix = [];
    for (const id of this.order) {
      const entry = this.entries.get(id);
      if (entry.stable) prefix.push(entry.stable);
      // Stable text must be a PREFIX: skipping a tentative hole would pair
      // later words with the wrong source and consume the wrong result ID.
      if (entry.stable !== entry.text) break;
    }
    return prefix.join(" ");
  }

  consume(sourceText) {
    let remaining = words(sourceText).length;
    for (const id of this.order) {
      if (!remaining) break;
      const entry = this.entries.get(id);
      const count = Math.min(remaining, words(entry.text).length);
      entry.text = words(entry.text).slice(count).join(" ");
      entry.stable = words(entry.stable).slice(count).join(" ");
      entry.consumed += count;
      remaining -= count;
    }
    // An empty interim can still grow under the SAME id. Retain its cursor.
    this.order = this.order.filter((id) => { const entry = this.entries.get(id); return entry.text || !entry.final; });
  }

  drain(now, options = {}) {
    const display = this.displayText();
    // Final callbacks during shutdown may still revise the pending tail.
    if (options.deferCommit) {
      const stableText = this.stableText();
      return { stableText, tentativeText: display.slice(stableText.length).trim(), displayText: display, commits: [] };
    }
    const inactiveFor = now - (this.lastActivityAt ?? now);
    const age = now - (this.startedAt ?? now);
    const force = options.force || (isReadableCaption(display, this.config) && (inactiveFor >= this.config.hardSilenceMs || age >= this.config.maxDurationMs));
    const sentence = new SentenceAccumulator(this.config);
    sentence.stableText = force ? display : this.stableText();
    sentence.lastStableAt = this.lastActivityAt ?? now;
    sentence.sentenceStartedAt = this.startedAt ?? now;
    const allFinal = this.order.every((id) => this.entries.get(id).final);
    // Choose the source once; never append the full snapshot after committing
    // its first bounded units. Force includes tentative words exactly once.
    const commits = sentence.takeImmediateBoundaries(now, force || allFinal);
    if (force) commits.push(...sentence.advance(now, { force: true }).commits);
    commits.forEach((commit) => this.consume(commit.sourceText));
    const displayText = this.displayText();
    const stableText = this.stableText();
    if (commits.length) this.startedAt = displayText ? now : null;
    return { stableText, tentativeText: displayText.slice(stableText.length).trim(), displayText, commits };
  }

  advance(now = Date.now(), options = {}) { return this.drain(now, options); }
}
