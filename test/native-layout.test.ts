import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zenEditorGeometry,
  zenQuietPanelPins,
} from "../scripts/native-layout.js";

test("native editor inset reserves real layout space and adapts to small splits", () => {
  assert.deepEqual(zenEditorGeometry(920, 680), {
    inset: 28,
    heading: 0,
    width: 864,
    height: 680,
  });
  assert.deepEqual(zenEditorGeometry(300, 250), {
    inset: 12,
    heading: 0,
    width: 276,
    height: 250,
  });
  assert.equal(zenEditorGeometry(10, 20).width, 0);
  assert.equal(zenEditorGeometry(10, 20).height, 20);
});

test("quiet panel migration preserves custom tools and malformed state", () => {
  const original = [
    { id: "custom.tool", pinned: true, order: 1 },
    { id: "workbench.panel.output", pinned: true, order: 2 },
  ];
  const next = JSON.parse(zenQuietPanelPins(JSON.stringify(original)));
  assert.deepEqual(next[0], original[0]);
  assert.deepEqual(next[1], { ...original[1], pinned: false });
  assert.ok(
    next.some(
      (entry: { id: string; pinned: boolean }) =>
        entry.id === "~remote.forwardedPortsContainer" && !entry.pinned,
    ),
  );
  assert.equal(zenQuietPanelPins(JSON.stringify(next)), JSON.stringify(next));
  assert.equal(zenQuietPanelPins("broken"), "broken");
});
