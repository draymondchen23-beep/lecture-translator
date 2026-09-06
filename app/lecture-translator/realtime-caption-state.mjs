/**
 * Normalizes both the legacy realtime relay events and browser fallback into
 * revisioned, identity-stable caption rows.  The UI only needs to upsert by
 * `segmentId`; an older network response can never replace a newer revision.
 */
function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export class RealtimeCaptionNormalizer {
  constructor(sessionId, runId = sessionId, sequenceBase = 0) {
    this.sessionId = sessionId;
    this.runId = runId;
    this.rows = new Map();
    this.nextSequence = sequenceBase;
  }

  key(event) {
    return String(event.itemId || `${event.sequence}:${event.startedAt || 0}`);
  }

  row(event) {
    const key = this.key(event);
    let row = this.rows.get(key);
    if (!row) {
      row = {
        sessionId: this.sessionId,
        segmentId: `${this.runId}:${key}`,
        // Provider sequence counters can reset on reconnect or advance only
        // when a target completes. Allocate UI order on first stable identity.
        sequence: this.nextSequence++,
        startTime: Number.isFinite(event.startedAt) ? event.startedAt : Date.now(),
        endTime: Number.isFinite(event.endedAt) ? event.endedAt : 0,
        sourceText: "", sourceRevision: 0, sourceStatus: "draft",
        translationText: "", translationRevision: 0, translationStatus: "idle",
        provider: event.provider || "qwen",
      };
      this.rows.set(key, row);
    }
    return row;
  }

  snapshot(row, extra = {}) {
    return { type: "segment.upsert", ...row, ...extra };
  }

  ingest(event) {
    if (!event || typeof event !== "object" || event.type === "segment.upsert") return event;
    if (!['source.partial', 'source.final', 'translation.partial', 'translation.final', 'segment.final'].includes(event.type)) return event;
    const row = this.row(event);
    const source = event.type === 'source.partial' || event.type === 'source.final' ? clean(event.text) : clean(event.sourceText);
    const translation = event.type === 'translation.partial' || event.type === 'translation.final' ? clean(event.text) : clean(event.translatedText);
    if (source && source !== row.sourceText && row.sourceStatus !== 'final') { row.sourceText = source; row.sourceRevision += 1; }
    // A completed translation is immutable. A late packet from the same
    // response is stale data, not a new subtitle revision.
    if (translation && translation !== row.translationText && row.translationStatus !== 'final') { row.translationText = translation; row.translationRevision += 1; }
    if (Number.isFinite(event.endedAt)) row.endTime = event.endedAt;
    if (event.provider) row.provider = event.provider;
    if (event.type === 'source.partial' && row.sourceStatus !== 'final') {
      row.sourceStatus = 'draft';
      if (row.translationStatus !== 'final') row.translationStatus = row.translationText ? 'draft' : 'pending';
    } else if (event.type === 'source.final') {
      row.sourceStatus = 'final';
    } else if (event.type === 'translation.partial' && row.translationStatus !== 'final') {
      row.translationStatus = 'draft';
    } else if (event.type === 'translation.final') {
      row.translationStatus = row.translationText ? 'final' : 'error';
    } else if (event.type === 'segment.final') {
      if (source) row.sourceStatus = 'final';
      if (translation && row.translationStatus !== 'final') row.translationStatus = 'final';
      else if (!row.translationText && row.sourceStatus === 'final') row.translationStatus = 'error';
    }
    return this.snapshot(row, { itemId: event.itemId, responseId: event.responseId });
  }
}

/** A small bounded, keyed scheduler. Newer work replaces queued stale work. */
export function createBoundedTranslationQueue(run, { concurrency = 2, maxPending = 24 } = {}) {
  const pending = new Map();
  let active = 0;
  const waiters = new Set();
  const settleIdle = () => {
    if (active || pending.size) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const pump = () => {
    while (active < concurrency && pending.size) {
      const finalEntry = [...pending.entries()].find(([, candidate]) => candidate.final);
      const [key, job] = finalEntry || pending.entries().next().value;
      pending.delete(key);
      active += 1;
      Promise.resolve(run(job)).catch(() => undefined).finally(() => {
        active -= 1;
        pump();
        settleIdle();
      });
    }
  };
  return {
    enqueue(job) {
      const key = job.segmentId || job.requestId;
      if (!key) throw new Error('A translation job needs a stable segmentId or requestId.');
      if (!pending.has(key) && pending.size >= maxPending) {
        const staleDraft = [...pending.entries()].find(([, candidate]) => !candidate.final);
        if (!staleDraft) return false;
        pending.delete(staleDraft[0]);
      }
      pending.set(key, job);
      pump();
      return true;
    },
    get size() { return pending.size + active; },
    idle() {
      if (!active && !pending.size) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
  };
}
