import test from "node:test";
import assert from "node:assert/strict";
import { effectiveViewport, targetDelta } from "../app/lecture-translator/follow-geometry.mjs";

test("follow geometry excludes sticky header and dock", () => {
  const viewport = effectiveViewport({ top: 178.34, bottom: 728.34, sticky: 214.34, dockTop: 634 });
  assert.equal(Number(viewport.center.toFixed(2)), 416.17);
  assert.equal(Number(targetDelta(viewport, { top: 371.395, height: 89.55, bottom: 460.945 }).toFixed(2)), 0.0);
});

test("long active rows follow their visible tail", () => {
  const viewport = effectiveViewport({ top: 0, bottom: 600, sticky: 40, dockTop: 600 });
  assert.equal(targetDelta(viewport, { top: 50, height: 700, bottom: 750 }), 166);
});
