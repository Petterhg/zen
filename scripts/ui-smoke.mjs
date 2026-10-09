import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
// Start with npm start -- --remote-debugging-port=9328 --remote-debugging-address=127.0.0.1.
const version = await (
  await fetch("http://127.0.0.1:9328/json/version")
).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) =>
  ws.addEventListener("open", resolve, { once: true }),
);
let next = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.error) call.reject(new Error(message.error.message));
  else call.resolve(message.result);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9328");
try {
  const { targetInfos } = await send("Target.getTargets");
  const target = targetInfos.find(
    (t) =>
      t.type === "iframe" && t.url.includes("extensionId=pair-code.pair-code"),
  );
  assert.ok(target, "Pair sidebar must be open");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const evaluate = async (expression) => {
    const result = await send(
      "Runtime.evaluate",
      {
        expression: `(()=>{const doc=document.querySelector('iframe').contentDocument;return (${expression});})()`,
        returnByValue: true,
      },
      sessionId,
    );
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  const state = await evaluate(
    `({file:doc.getElementById('contextFile').textContent,disabled:doc.getElementById('connect').disabled,microphone:doc.featurePolicy.allowsFeature('microphone'),camera:doc.featurePolicy.allowsFeature('camera'),providerSelector:!!doc.getElementById('provider'),agentSettings:!!doc.getElementById('agentSettings'),inlineMode:doc.getElementById('inlineMode').value})`,
  );
  assert.equal(state.file, "pairing.ts");
  assert.equal(state.microphone, true);
  assert.equal(state.camera, false);
  assert.ok(["off", "manual", "automatic"].includes(state.inlineMode));
  assert.equal(state.providerSelector, false);
  assert.equal(state.agentSettings, true);
  await evaluate(`doc.getElementById('configure').click()`);
  const page = browser.contexts()[0].pages()[0];
  await page
    .getByText("GPT-Live voice", { exact: true })
    .waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await evaluate(
    `(()=>{const field=doc.getElementById('message');field.value='Use read_file to inspect pairing.ts and explain what summarize returns. Do not edit.';doc.getElementById('composer').dispatchEvent(new doc.defaultView.Event('submit',{bubbles:true,cancelable:true}));return true;})()`,
  );
  let result;
  for (let attempt = 0; attempt < 450; attempt++) {
    result = await evaluate(
      `({error:doc.getElementById('error').textContent,answer:doc.querySelector('.turn.assistant p')?.textContent})`,
    );
    if (result.error || result.answer) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (state.disabled)
    assert.match(result.error, /Configure your cerebras API key first/);
  else {
    assert.equal(result.error, "");
    assert.ok(
      result.answer?.length > 15,
      "Live backend answer must appear in the actual sidebar",
    );
  }
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/ui-smoke.png" });
  console.log(
    `UI smoke passed: editor context, scoped audio permission, inline controls, native key configuration, and ${state.disabled ? "missing-key error" : "live typed backend answer"}.`,
  );
} finally {
  ws.close();
  await browser.close();
}
