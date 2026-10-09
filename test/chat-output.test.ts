import { test } from "node:test";
import assert from "node:assert/strict";
import { backendInstructions } from "../extension/src/prompts.js";

test("voice prompt remains the default and keeps spoken length guidance", () => {
  assert.equal(backendInstructions(25), backendInstructions(25, "voice"));
  assert.equal(backendInstructions(0), backendInstructions(0, "voice"));
  assert.match(
    backendInstructions(25),
    /at most two short sentences and 350 UTF-8 bytes/,
  );
  assert.doesNotMatch(backendInstructions(25), /Output for text chat/);
});

test("text chat allows a complete researched answer while proposals stay inline", () => {
  const prompt = backendInstructions(75, "chat");
  assert.match(prompt, /verified sequence, decisions and effects/);
  assert.match(prompt, /up to 4000 characters/);
  assert.match(prompt, /path:line citations/);
  assert.match(prompt, /one inline proposal in edits/);
  assert.doesNotMatch(
    prompt,
    /350 UTF-8 bytes|single authoritative spoken answer|about 500 characters/,
  );
});

test("guide mode in text chat explains research fully but never proposes code", () => {
  const prompt = backendInstructions(0, "chat");
  assert.match(prompt, /complete source-backed explanation even in guide mode/);
  assert.match(prompt, /slider controls code writing/);
  assert.match(prompt, /Never return a code proposal/);
  assert.match(prompt, /"edits":\[\]/);
  assert.doesNotMatch(
    prompt,
    /350 UTF-8 bytes|single authoritative spoken answer|ONE focused inline preview/,
  );
});
