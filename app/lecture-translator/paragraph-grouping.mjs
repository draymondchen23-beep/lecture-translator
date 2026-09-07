const abbreviations = /(?:\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|prof|fig|eq|no|for example)\.|(?:[A-Z]\.){2,})$/i;
const incompleteEnding = /(?:\b(?:and|or|but|because|so|if|when|while|than|that|which|who|with|to|of|for|in|on|at|by|from|as|you|we|they|it|this|these|those)|[,;:\-–—])$/i;
const topicCue = /^(?:\bnow\b[,:]?|\bnext\b[,:]?|moving on\b[,:]?|let'?s (?:move on|turn) to\b|another (?:topic|point)\b|the next (?:topic|point)\b|\bfirst\b[,:]?|\bsecond\b[,:]?|\bfinally\b[,:]?)/i;

export function isCompleteSemantic(text = "") {
  const value = text.trim();
  if (!/[.!?。！？]$/.test(value) || abbreviations.test(value) || /\d\.\d+$/.test(value)) return false;
  return !incompleteEnding.test(value.replace(/[.!?。！？]+$/, "").trim());
}

export function startsNewParagraph(previous, next) {
  if (!previous) return true;
  if (next.speaker && previous.speaker && next.speaker !== previous.speaker) return true;
  if (previous.sourceStatus === "draft") return false;
  const previousComplete = isCompleteSemantic(previous.sourceText);
  if (!previousComplete) return false;
  const pause = previous.endTime > 0 ? Math.max(0, (next.startTime || 0) - previous.endTime) : 0;
  return pause >= 4 || topicCue.test(next.sourceText || "");
}

export function assignParagraphId(segments, next) {
  if (next.paragraphId) return next.paragraphId;
  const previous = [...segments].sort((a, b) => a.sequence - b.sequence).filter((item) => item.sequence < next.sequence).at(-1);
  return !previous || startsNewParagraph(previous, next) ? `paragraph:${next.id}` : previous.paragraphId || `paragraph:${previous.id}`;
}

export function migrateParagraphIds(segments) {
  const assigned = [];
  return [...segments].sort((a, b) => a.sequence - b.sequence).map((segment) => {
    const paragraphId = assignParagraphId(assigned, segment);
    const next = segment.paragraphId === paragraphId ? segment : { ...segment, paragraphId };
    assigned.push(next);
    return next;
  });
}

export function groupParagraphs(segments) {
  const paragraphs = [];
  for (const segment of [...segments].sort((a, b) => a.sequence - b.sequence)) {
    const paragraphId = segment.paragraphId || `paragraph:${segment.id}`;
    const current = paragraphs.at(-1);
    if (current?.id === paragraphId) current.segments.push(segment);
    else paragraphs.push({ id: paragraphId, segments: [segment] });
  }
  return paragraphs;
}
