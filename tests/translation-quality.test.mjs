import assert from "node:assert/strict";
import test from "node:test";
import { cleanTranslation, translationNeedsRetry } from "../app/api/translate/translation-quality.mjs";

test("accepts Chinese prose with biomedical terms and equations", () => {
  assert.equal(translationNeedsRetry("血红蛋白（Hemoglobin）与 ATP 浓度为 2 mg/mL。"), false);
});

test("rejects abnormal scripts and untranslated English prose", () => {
  assert.equal(translationNeedsRetry("هذه ترجمة غير صالحة"), true);
  assert.equal(translationNeedsRetry("This is still an English lecture sentence."), true);
  assert.equal(translationNeedsRetry("..."), true);
  assert.equal(translationNeedsRetry("polymerase"), true);
  assert.equal(translationNeedsRetry("this"), true);
  assert.equal(translationNeedsRetry("This"), true);
  assert.equal(translationNeedsRetry("Polymerase"), true);
  assert.equal(translationNeedsRetry("ATP"), false);
});

test("cleanup removes abnormal script without removing technical Chinese content", () => {
  assert.equal(cleanTranslation("译文：细胞 ATP \u0627\u0644\u062e\u0644\u064a\u0629"), "细胞 ATP");
});
