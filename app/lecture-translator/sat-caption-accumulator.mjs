import { BrowserCaptionAccumulator } from './browser-caption-accumulator.mjs';

const tokens = text => text.trim().split(/\s+/).filter(Boolean);
const isPrefix = (text, prefix) => text === prefix || text.startsWith(prefix + ' ');

/** ASR owns the text; SaT only proposes cuts in an unchanged stable prefix. */
export class SatCaptionAccumulator extends BrowserCaptionAccumulator {
  constructor() {
    super();
    this.semantic = true;
    this.generation = 0;
    this.previousInput = '';
    this.candidates = new Set();
  }

  drain(now, options = {}) {
    if (!this.semantic) return super.drain(now, options);
    // Silence, recognizer final flags and word counts are NOT sentence ends.
    // Explicit pause/end goes through segment(..., {force:true}) instead.
    return super.drain(now, { deferCommit: true });
  }

  async segment(split, { force = false, now = Date.now() } = {}) {
    const text = force ? this.displayText() : this.stableText();
    if (!this.semantic || !text || (!force && text === this.previousInput)) return this.drain(now);
    const generation = this.generation;
    const result = await split(text);
    const current = force ? this.displayText() : this.stableText();
    // Reject responses to a previous cursor or an ASR correction. Appended
    // right context is safe; canonical local text is always what we consume.
    if (generation !== this.generation || !this.semantic || !isPrefix(current, text)) return this.drain(now);
    const ends = new Set([...text.matchAll(/\S+/g)].map(word => word.index + word[0].length));
    const cuts = [...new Set((result.boundaries || []).map(char => char + 1))].filter(end => ends.has(end) && end < text.length).sort((a, b) => a - b);
    const proposed = new Set(cuts.map(end => text.slice(0, end)));
    const accepted = force ? cuts : cuts.filter(end => this.candidates.has(text.slice(0, end)) && tokens(text.slice(end)).length >= 4);
    if (force) accepted.push(text.length); // Preserve the final audible tail exactly once.
    const commits = [];
    let offset = 0;
    for (const end of accepted) {
      const sourceText = text.slice(offset, end).trim();
      if (sourceText) { this.consume(sourceText); commits.push({ sourceText, boundary: force ? 'sat-final' : 'sat' }); }
      offset = end;
    }
    this.candidates = new Set([...proposed].filter(prefix => prefix.length > offset).map(prefix => prefix.slice(offset).trim()));
    this.previousInput = text.slice(offset).trim();
    if (commits.length) { this.generation++; this.startedAt = this.displayText() ? now : null; }
    return { ...this.drain(now), commits };
  }

  invalidate() { this.generation++; }

  fallback(now = Date.now(), force = false, deferCommit = false) {
    this.generation++;
    this.semantic = false;
    this.candidates.clear();
    return super.drain(now, { force, deferCommit });
  }
}
