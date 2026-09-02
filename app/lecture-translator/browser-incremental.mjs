export function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function stableWords(previous, current, stable) {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length].toLowerCase() === current[length].toLowerCase()) length += 1;
  return length > stable.length ? current.slice(0, length) : stable;
}

export const MIN_PREVIEW_WORDS = 3;
export const LIVE_TRANSLATION_CHUNK_WORDS = 4;

export function hasSemanticBoundary(text) {
  return /[.!?]["')\]]*$/.test(text.trim());
}

export function collectLiveTranslationWords({ sourceText = "", stableText = "", committedWordCount = 0 }) {
  const sourceWords = splitWords(sourceText);
  const stable = splitWords(stableText);
  const observed = stable.length >= MIN_PREVIEW_WORDS ? stable : sourceWords;
  const start = Math.min(committedWordCount, observed.length);
  return {
    words: observed.slice(start),
    committedWordCount: Math.max(committedWordCount, observed.length),
  };
}

export function takeLiveTranslationChunk(pendingWords, maxWords = LIVE_TRANSLATION_CHUNK_WORDS) {
  const boundary = pendingWords.findIndex((word) => hasSemanticBoundary(word));
  const count = boundary >= 0 ? boundary + 1 : pendingWords.length >= maxWords ? maxWords : 0;
  if (!count) return null;
  return { text: pendingWords.slice(0, count).join(" "), remainingWords: pendingWords.slice(count) };
}

export function appendUniqueTranslation(accumulated = "", next = "") {
  const current = accumulated.trim();
  const incoming = next.trim();
  if (!current || !incoming) return current || incoming;
  // Some MT responses echo the entire preview that was already appended
  // instead of returning only the requested delta. Treat an exact echo as a
  // no-op before looking for a suffix/prefix overlap.
  if (current.includes(incoming) && incoming.length >= 4) return current;
  const currentChars = Array.from(current);
  const incomingChars = Array.from(incoming);
  for (let length = Math.min(currentChars.length, incomingChars.length); length > 0; length -= 1) {
    if (currentChars.slice(-length).join("") === incomingChars.slice(0, length).join("")) {
      return `${current}${incomingChars.slice(length).join("")}`;
    }
  }
  return `${current}${incoming}`;
}

export function contextTail(source, maxChars = 400) {
  const text = source.trim();
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const boundary = tail.search(/\s/);
  return boundary >= 0 ? tail.slice(boundary).trim() : tail;
}

export function shouldProcessBrowserResult({ fallbackActive, paused, intentionalClose }) {
  return fallbackActive && !paused && !intentionalClose;
}

export function shouldStartBrowserFallbackImmediately(hostname) {
  return typeof hostname === "string" && /\.chatgpt\.site$/i.test(hostname);
}

export function fallbackRequestSegmentId(sessionId, sequence, requestIndex) {
  return `${sessionId}:${sequence}:${requestIndex}`;
}

export function fallbackFinalCorrectionSegmentId(sessionId, sequence) {
  return `${sessionId}:${sequence}:final`;
}

export function bestTranscript(result) {
  let transcript = "";
  let confidence = -Infinity;
  for (let index = 0; index < (result?.length || 0); index += 1) {
    const alternative = result[index];
    const text = alternative?.transcript?.trim();
    if (!text) continue;
    const score = typeof alternative.confidence === "number" ? alternative.confidence : -Infinity;
    if (!transcript || score > confidence) {
      transcript = text;
      confidence = score;
    }
  }
  return transcript;
}
