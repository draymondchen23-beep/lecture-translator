import assert from "node:assert/strict";
import test from "node:test";
import { createQwenItemPairer } from "../app/lecture-translator/qwen-item-pairing.mjs";

test("a distinct Qwen translation item finalizes the preceding source item", () => {
  const pairer = createQwenItemPairer();
  const segments = new Map();
  const sourceEvent = { type: "conversation.item.input_audio_transcription.text", item_id: "source-item", text: "The source sentence." };
  segments.set(sourceEvent.item_id, { sourceText: sourceEvent.text, translatedText: "" });

  pairer.captureCreated({
    type: "conversation.item.created",
    item: { id: "translation-item" },
    previous_item_id: sourceEvent.item_id,
  });
  const translationEvent = { type: "response.text.text", item_id: "translation-item", response_id: "response-1", text: "源句。" };
  const pairedSourceId = pairer.resolve(translationEvent);
  pairer.rememberResponse(translationEvent, pairedSourceId);
  segments.get(pairedSourceId).translatedText = translationEvent.text;

  assert.equal(pairer.resolve({ type: "response.text.done", response_id: "response-1" }), "source-item");
  assert.deepEqual([...segments.entries()], [["source-item", { sourceText: "The source sentence.", translatedText: "源句。" }]]);
});

test("a response arriving before item-created uses the active source and remains paired", () => {
  const pairer = createQwenItemPairer();
  const activeSourceId = "source-item";
  const earlyTranslation = { item_id: "translation-item", response_id: "response-1" };
  const sourceId = pairer.resolve(earlyTranslation) || activeSourceId;
  pairer.rememberResponse(earlyTranslation, sourceId);
  pairer.captureCreated({ item: { id: "translation-item" }, previous_item_id: activeSourceId });
  assert.equal(pairer.resolve({ response_id: "response-1" }), activeSourceId);
  assert.equal(pairer.resolve({ item_id: "translation-item" }), activeSourceId);
});
