import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("summary route is transcript-grounded and returns structured study notes", async () => {
  const route = await readFile(new URL("app/api/summarize/route.ts", root), "utf8");
  assert.match(route, /config\.QWEN_API_KEY \|\| config\.DASHSCOPE_API_KEY/);
  assert.match(route, /QWEN_SUMMARY_MODEL \|\| "qwen-plus"/);
  assert.match(route, /response_format: \{ type: "json_object" \}/);
  assert.match(route, /enable_thinking: false/);
  assert.match(route, /untrusted quoted content/);
  assert.match(route, /MAX_TRANSCRIPT_LENGTH = 180_000/);
  assert.match(route, /professorEmphasis/);
  assert.match(route, /examTips/);
  assert.match(route, /formulas/);
  assert.match(route, /"flow", "concept-map", "comparison", "timeline"/);
  assert.match(route, /Do not add outside facts/);
});

