import { findSentenceBoundaries } from "./caption-stabilizer.mjs";

const incompleteEnding = /(?:\b(?:and|or|but|because|if|when|while|than|which|who|with|to|of|for|in|on|at|by|from|as)|\b(?:and|or|but|because|if|when|while)\s+(?:you|we|they|it|this|these|those)|[,;:\-–—])$/i;

// Browser speech recognition often supplies no punctuation. Recognise only
// clear independent clauses on BOTH sides; a timeout/final flag alone must
// never turn a transport chunk into a display sentence. These conservative
// local cues are fallbacks, not a claim of general semantic parsing.
const dependentStart = /^(?:and|or|but|because|if|when|while|although|unless|until|since|as|which|who|whose|where|whether|to|of|for|with|in|on|at|by|from)\b/i;
const unfinishedPredicate = /\b(?:am|is|are|was|were|be|been|being|can|could|may|might|must|shall|should|will|would|have|has|had|do|does|did|the|a|an|this|these|those|my|your|our|their|its|very|more|less|such|not|think|thinks|know|knows|say|says|said|means|mean|whether|that)$/i;
const awaitingComplement = /\b(?:show(?:s|ed)?|explain(?:s|ed)?|demonstrate(?:s|d)?|suggest(?:s|ed)?|confirm(?:s|ed)?|assume(?:s|d)?|believe(?:s|d)?|determine(?:s|d)?|understand|understood)$/i;
const subjectStart = /^(?:i|you|we|they|he|she|it|there|this|that|these|those|the|a|an|my|your|our|their|its|[a-z]+s)\b/i;
const predicate = /\b(?:am|is|are|was|were|can|could|may|might|must|should|will|would|has|have|had|do|does|did|[a-z]+(?:'s|'re|'ve|'ll)|affect(?:s|ed)?|allow(?:s|ed)?|appear(?:s|ed)?|become(?:s)?|became|cause(?:s|d)?|change(?:s|d)?|communicate(?:s|d)?|compare(?:s|d)?|contain(?:s|ed)?|control(?:s|led)?|depend(?:s|ed)?|describe(?:s|d)?|develop(?:s|ed)?|differ(?:s|ed)?|explain(?:s|ed)?|express(?:es|ed)?|find(?:s)?|found|follow(?:s|ed)?|give(?:s)?|gave|guide(?:s|d)?|happen(?:s|ed)?|help(?:s|ed)?|include(?:s|d)?|influence(?:s|d)?|involve(?:s|d)?|learn(?:s|ed)?|make(?:s)?|made|mean(?:s)?|measure(?:s|d)?|move(?:s|d)?|need(?:s|ed)?|observe(?:s|d)?|occur(?:s|red)?|play(?:s|ed)?|produce(?:s|d)?|provide(?:s|d)?|record(?:s|ed)?|remain(?:s|ed)?|require(?:s|d)?|respond(?:s|ed)?|result(?:s|ed)?|sense(?:s|d)?|shape(?:s|d)?|show(?:s|ed)?|signal(?:s|led)?|start(?:s|ed)?|take(?:s)?|took|use(?:s|d)?|work(?:s|ed)?)\b/i;

function independentClause(text = "") {
  const value = text.replace(/\s+/g, " ").trim().replace(/^(?:now|next|finally|therefore)[,:]?\s+/i, "");
  if (dependentStart.test(value) || !subjectStart.test(value) || value.split(" ").length < 3) return false;
  if (incompleteEnding.test(value) || unfinishedPredicate.test(value) || awaitingComplement.test(value)) return false;
  // A finite predicate must follow a subject and have a complement. This
  // deliberately leaves uncertain speech attached until more evidence arrives.
  const match = predicate.exec(value);
  return Boolean(match && (match.index > 0 || /^(?:i|you|we|they|he|she|it|there|that)'(?:s|re|ve|ll)\b/i.test(value)) && value.slice(match.index + match[0].length).trim());
}

export function isCompleteSemantic(text = "") {
  const value = text.replace(/\s+/g, " ").trim();
  const last = findSentenceBoundaries(value).at(-1);
  if (!last || last.end !== value.length || /(?:\.{2,}|…)\s*["'”’\])}]*$/.test(value) || /^(?:for example|such as)[.!?]$/i.test(value)) return false;
  if (/[?？]["'”’\])}]*$/.test(value) && /^(?:what|where|when|why|who|which|how|is|are|was|were|do|does|did|can|could|will|would|should|have|has)\b/i.test(value)) return true;
  return !incompleteEnding.test(value.replace(/[.!?。！？"'”’\])}]+$/, "").trim());
}

export function startsNewParagraph(previous, next) {
  if (!previous) return true;
  if (next.speaker && previous.speaker && next.speaker !== previous.speaker) return true;
  if (previous.sourceStatus === "draft") return false;
  // A display row is one source sentence, even with no pause or topic change.
  // ASR final, time/word limits and translation completion are NOT boundaries.
  if (isCompleteSemantic(previous.sourceText)) return true;
  if (/[.!?。！？…]["'”’\])}]*$/.test((previous.sourceText || "").trim())) return false;
  return independentClause(previous.sourceText) && independentClause(next.sourceText);
}

export function assignParagraphId(segments, next) {
  return migrateParagraphIds([...segments.filter((item) => item.id !== next.id), next]).find((item) => item.id === next.id).paragraphId;
}

export function migrateParagraphIds(segments) {
  let previous = null;
  let sentenceText = "";
  return [...segments].sort((a, b) => a.sequence - b.sequence).map((segment) => {
    const begins = startsNewParagraph(previous && { ...previous, sourceText: sentenceText }, segment);
    const paragraphId = begins ? `paragraph:${segment.id}` : previous.paragraphId;
    sentenceText = begins ? segment.sourceText : `${sentenceText || ""} ${segment.sourceText || ""}`.trim();
    const next = segment.paragraphId === paragraphId ? segment : { ...segment, paragraphId };
    previous = next;
    return next;
  });
}

export function groupParagraphs(segments) {
  const paragraphs = [];
  // Recompute from source only. Legacy paragraph ids may join many sentences;
  // late source punctuation may also settle after the next ASR item arrives.
  // Translation arrival never influences membership or row identity.
  for (const segment of migrateParagraphIds(segments)) {
    const paragraphId = segment.paragraphId || `paragraph:${segment.id}`;
    const current = paragraphs.at(-1);
    if (current?.id === paragraphId) current.segments.push(segment);
    else paragraphs.push({ id: paragraphId, segments: [segment] });
  }
  return paragraphs;
}
