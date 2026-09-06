function record(value) {
  return value && typeof value === "object" ? value : {};
}

function id(value, ...keys) {
  const source = record(value);
  for (const key of keys) if (typeof source[key] === "string" && source[key]) return source[key];
  return "";
}

/**
 * Qwen gives source ASR and translation output different conversation item
 * ids. The translation item points back to its source through
 * `previous_item_id` in `conversation.item.created`.
 */
export function createQwenItemPairer() {
  const itemSources = new Map();
  const responseSources = new Map();

  const resolve = (payload) => {
    const itemId = id(payload, "item_id", "itemId", "conversation_item_id");
    const responseId = id(payload, "response_id", "responseId");
    return (itemId && itemSources.get(itemId)) || (responseId && responseSources.get(responseId)) || "";
  };

  return {
    captureCreated(payload) {
      const event = record(payload);
      const item = record(event.item);
      const itemId = id(item, "id", "item_id", "itemId");
      const previousItemId = id(event, "previous_item_id", "previousItemId") || id(item, "previous_item_id", "previousItemId");
      const sourceItemId = previousItemId && (itemSources.get(previousItemId) || previousItemId);
      if (itemId && sourceItemId) itemSources.set(itemId, sourceItemId);
      return { itemId, sourceItemId: sourceItemId || "" };
    },
    resolve,
    rememberResponse(payload, sourceItemId) {
      const responseId = id(payload, "response_id", "responseId");
      if (responseId && sourceItemId) responseSources.set(responseId, sourceItemId);
    },
    forgetSource(sourceItemId) {
      for (const [itemId, mappedSource] of itemSources) if (mappedSource === sourceItemId) itemSources.delete(itemId);
      for (const [responseId, mappedSource] of responseSources) if (mappedSource === sourceItemId) responseSources.delete(responseId);
    },
  };
}
