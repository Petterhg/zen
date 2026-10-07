import { test } from "node:test";
import assert from "node:assert/strict";
import { PassiveContextWindow } from "../extension/src/live-protocol.js";

test("editor bursts and continuing playback defer passive context until both settle", () => {
  const window = new PassiveContextWindow();
  window.edit(100);
  window.speech(200);
  assert.equal(window.remaining(700), 600);
  window.speech(1000); // Audio is still playing even if captions have already finished.
  assert.equal(window.remaining(1400), 700);
  window.edit(1900);
  assert.equal(window.remaining(2100), 400);
  assert.equal(window.remaining(2500), 0);
  window.speech(3000);
  window.reset();
  assert.equal(window.remaining(3001), 0);
});
