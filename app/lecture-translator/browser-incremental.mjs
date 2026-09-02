export function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function stableWords(previous, current, stable) {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length].toLowerCase() === current[length].toLowerCase()) length += 1;
  return length > stable.length ? current.slice(0, length) : stable;
}

export function uncommittedTail(source, committed) {
  return splitWords(source).slice(splitWords(committed).length).join(" ");
}

export function fallbackRequestSegmentId(sessionId, sequence, requestIndex) {
  return `${sessionId}:${sequence}:${requestIndex}`;
}
