export function reducePartialEvent(current, event) {
  if (event.type === "source.partial") {
    return {
      source: event.text,
      translation: event.sequence === current.sequence ? current.translation : "",
      sequence: event.sequence,
    };
  }
  if (event.type === "translation.partial") {
    if (event.sequence === current.sequence || (current.source === "" && event.sequence > current.sequence)) {
      return { ...current, translation: event.text, sequence: event.sequence };
    }
  }
  if (event.type === "segment.final" && event.sequence === current.sequence) {
    return { source: "", translation: "", sequence: event.sequence + 1 };
  }
  return current;
}
