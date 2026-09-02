const CJK = /[\u3400-\u9fff]/g;
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;
const ABNORMAL_SCRIPT = /[\u0400-\u04ff\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0b00-\u0b7f\u0c00-\u0c7f\u0d00-\u0d7f]/;
const SHORT_UNITS = /^(?:m|cm|mm|kg|mg|g|L|mL|μm|nm|s|ms|Hz|kHz|mol|mM|μM)$/;

export function translationNeedsRetry(value) {
  const text = value.trim();
  if (!text || ARABIC.test(text) || ABNORMAL_SCRIPT.test(text)) return true;
  const chinese = (text.match(CJK) || []).length;
  const latinWords = text.match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
  const latinCharacters = (text.match(/[A-Za-z]/g) || []).length;
  // Only clearly technical tokens may stand alone without Chinese prose.
  const isTechnicalToken = (word) => /^[A-Z][A-Z0-9-]{1,8}$/.test(word) || SHORT_UNITS.test(word) ||
    /^\d+(?:\.\d+)?(?:[A-Za-zμ]+)?$/.test(word);
  const proseWords = latinWords.filter((word) => !isTechnicalToken(word));
  if (chinese === 0 && !/[A-Za-z0-9]/.test(text)) return true;
  if (chinese === 0 && proseWords.length > 0) return true;
  if (chinese === 0 && proseWords.length >= 2) return true;
  if (chinese === 0 && text.length > 24) return true;
  return latinCharacters > chinese * 3 && proseWords.length > 1;
}

export function cleanTranslation(value) {
  return value
    .replace(/```(?:text|中文|chinese)?/gi, "")
    .replace(/^(?:translation|translated text|译文)\s*[:：]\s*/i, "")
    .replace(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\u0400-\u04ff\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0b00-\u0b7f\u0c00-\u0c7f\u0d00-\u0d7f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
