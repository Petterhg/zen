import { test } from "node:test";
import assert from "node:assert/strict";
import { zenEditorGeometry } from "../scripts/native-layout.js";

test("native editor inset reserves real layout space and adapts to small splits", () => {
  assert.deepEqual(zenEditorGeometry(920, 680), {
    inset: 28,
    heading: 96,
    width: 864,
    height: 584,
  });
  assert.deepEqual(zenEditorGeometry(300, 250), {
    inset: 12,
    heading: 48,
    width: 276,
    height: 202,
  });
  assert.equal(zenEditorGeometry(10, 20).width, 0);
  assert.equal(zenEditorGeometry(10, 20).height, 0);
});
