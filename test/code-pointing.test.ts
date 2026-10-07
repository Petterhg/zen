import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bufferReferences,
  codeReference,
  SpokenCodeFocus,
} from "../extension/src/code-pointing.js";
import type { EditorContext } from "../extension/src/core.js";
const context: EditorContext = {
  uri: "file:///demo/main.py",
  file: "main.py",
  language: "python",
  version: 4,
  text: 'class Payload(BaseModel):\n    email: str\n\n@app.post("/onboarding")\ndef save_payload(payload: Payload):\n    db = sqlite3.connect("example.db")\n',
  selection: "",
  selectionStart: 0,
  selectionEnd: 0,
  diagnostics: [],
  textStart: 100,
};
function event(delta: string, end: number, id = String(end)) {
  return {
    type: "session.output_transcript.delta",
    delta,
    start_ms: end - 200,
    end_ms: end,
    event_id: id,
  };
}
test("spoken split Pydantic then POST endpoint moves between verified buffer anchors", () => {
  const refs = bufferReferences(context);
  const tracker = new SpokenCodeFocus();
  assert.equal(tracker.append(event("Först en Pydan", 200), refs), undefined);
  const model = tracker.append(event("tic-modell", 400), refs)!;
  assert.equal(model.label, "Payload");
  assert.equal(model.start, 100);
  assert.equal(model.version, 4);
  const endpoint = tracker.append(event(". Sen POST-endpointen", 600), refs)!;
  assert.equal(endpoint.label, "save_payload");
  assert.equal(
    context.text.slice(endpoint.start - 100, endpoint.end - 100),
    endpoint.quote,
  );
  assert.equal(tracker.append(event(" POST-endpointen", 600), refs), undefined);
  assert.equal(tracker.append(event(" Pydantic", 300), refs), undefined);
  assert.equal(
    tracker.append(
      { ...event(" Pydantic", 800), type: "session.input_transcript.delta" },
      refs,
    ),
    undefined,
  );
});
test("ambiguous spoken aliases never choose an arbitrary class", () => {
  const refs = bufferReferences({
    ...context,
    text: context.text + "\nclass Other(BaseModel):\n    other: str\n",
  });
  const tracker = new SpokenCodeFocus();
  assert.equal(tracker.append(event("Pydantic", 200), refs), undefined);
  assert.equal(tracker.append(event(" Payload", 400), refs)?.label, "Payload");
  assert.throws(
    () => codeReference({ ...context, text: "x\nx" }, "x", "x", ["target"]),
    /unique/,
  );
  assert.throws(
    () => codeReference(context, "class Imagined:", "Imagined", ["imagined"]),
    /unique/,
  );
});
test("long explanations still follow new mentions without re-triggering old ones", () => {
  const tracker = new SpokenCodeFocus();
  const refs = bufferReferences(context);
  for (let n = 1; n <= 20; n++)
    tracker.append(event(" some explanation ".repeat(3), n * 200), refs);
  assert.equal(
    tracker.append(event(" SQLite", 4200), refs)?.label,
    "SQLite connection",
  );
  assert.equal(tracker.append(event(" is used here", 4400), refs), undefined);
  tracker.reset();
  assert.equal(tracker.append(event("Payload", 200), refs)?.label, "Payload");
});
