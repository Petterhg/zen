// Isolated UI regression checks. No provider credentials, shell execution or live integrations.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const server = spawn(process.execPath, ["scripts/serve-prototype.mjs"], {
  env: { ...process.env, ZEN_PROTOTYPE_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Prototype server timed out")),
      10000,
    );
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    server.on("error", reject);
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited: ${code}`));
    });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(url)) external.push(request.url());
  });
  await page.goto(url);
  const click = (id) => page.locator(`#${id}`).click();
  const text = (id) => page.locator(`#${id}`).innerText();
  const visible = (id) => page.locator(`#${id}`).isVisible();
  const code = page.locator("#code");
  const original = await code.inputValue();
  await mkdir("artifacts/zen-workbench", { recursive: true });
  await page.screenshot({ path: "artifacts/zen-workbench/dark.png" });
  await click("themeToggle");
  await page.screenshot({ path: "artifacts/zen-workbench/light-clean.png" });
  await click("openAgents");
  await page.screenshot({ path: "artifacts/zen-workbench/specialists.png" });
  await click("closeModal");
  await click("collaborate");
  await page.screenshot({ path: "artifacts/zen-workbench/shared-task.png" });
  await click("closeModal");
  await click("themeToggle");

  await click("hideBoard");
  assert.equal(await visible("workboard"), false);
  await click("toggleBoard");
  assert.equal(await visible("workboard"), true);
  await click("hideTerminal");
  assert.equal(await visible("terminal"), false);
  await click("toggleTerminal");
  assert.equal(await visible("terminal"), true);
  await click("hideFiles");
  assert.equal(await visible("files"), false);
  await click("showFiles");
  assert.equal(await visible("files"), true);
  await click("focus");
  assert.equal(await visible("workboard"), false);
  await click("focus");
  assert.equal(await visible("workboard"), true);

  await click("voice");
  await click("voiceSettings");
  await page.locator("#assistance").fill("0");
  await click("closeModal");
  assert.equal(await text("voiceLabel"), "Pause & save");
  assert.equal(await page.locator("#suggest").isDisabled(), true);
  await code.fill(original + "// My own work\n");
  assert.equal(await text("voiceLabel"), "Pause & save");
  await click("voice");
  await page.reload();
  assert.equal(await text("voiceLabel"), "Resume pairing");
  assert.match(await code.inputValue(), /My own work/);
  await click("sessionHistory");
  assert.match(await text("modalBody"), /traced cancellation/);
  await click("closeModal");

  assert.equal(
    await page.getByRole("tab", { name: "Memory", exact: true }).count(),
    0,
  );
  await click("taskPicker");
  await page.locator('[data-task="ZEN-148"]').click();
  assert.equal(await code.inputValue(), original);
  await click("taskPicker");
  await page.locator('[data-task="ZEN-142"]').click();
  assert.match(await code.inputValue(), /My own work/);

  await click("voiceSettings");
  await page.locator("#assistance").fill("60");
  await click("closeModal");
  await click("suggest");
  await code.fill(original + "// newer buffer\n");
  assert.equal(await page.locator("#acceptEdit").isDisabled(), true);
  await code.press("Control+Enter");
  assert.equal(await visible("proposal"), false);
  assert.doesNotMatch(await code.inputValue(), /signal\?\.throwIfAborted/);
  await click("suggest");
  assert.equal(await page.locator("#acceptEdit").isDisabled(), false);
  await click("rejectEdit");
  assert.equal(await visible("proposal"), false);
  await page.getByRole("tab", { name: "Delivery", exact: true }).click();
  await click("nextStage");
  await click("nextStage");
  assert.equal(await page.locator("#acceptEdit").isEnabled(), true);
  await page.locator('#tabs [data-file="clock.ts"]').click();
  assert.equal(await visible("proposal"), false);
  await page.locator('#tabs [data-file="retry.ts"]').click();
  assert.equal(await visible("proposal"), true);
  await click("acceptEdit");
  assert.match(await code.inputValue(), /signal\?\.throwIfAborted/);
  assert.match(await code.inputValue(), /newer buffer/);
  await click("nextStage");
  await click("nextStage");
  assert.equal(await text("stageLabel"), "Ready to merge");
  await click("confirmMerge");
  assert.equal(await text("stageLabel"), "Delivery");
  await click("nextStage");
  await click("failCheck");
  assert.equal(await text("stageLabel"), "Verify");
  await page.screenshot({ path: "artifacts/zen-workbench/delivery.png" });
  await click("nextStage");
  assert.equal(await text("stageLabel"), "Complete");

  await click("collaborate");
  await click("joinPeer");
  await click("followPeer");
  assert.equal(await visible("collabCursor"), true);
  await code.fill((await code.inputValue()) + "// Independent navigation\n");
  assert.equal(await visible("collabCursor"), false);
  assert.equal(await text("stageLabel"), "In progress");
  await click("openAgents");
  await page.locator('[data-configure="reviewer"]').click();
  await page
    .locator("#agentRules")
    .fill("Check retry conventions <script> without executing code.");
  await click("saveAgentRules");
  await page.locator('[data-run="reviewer"]').click();
  assert.match(
    await page.locator('[data-result="reviewer"]').innerText(),
    /Demo review/,
  );
  await page.locator('[data-run="sre"]').click();
  await click("injectIncident");
  assert.match(
    await page.locator('[data-result="sre"]').innerText(),
    /causality is unverified/,
  );
  await page.locator('[data-run="sre"]').click();
  await click("closeModal");
  await page.reload();
  await click("openAgents");
  await page.locator('[data-configure="reviewer"]').click();
  assert.match(
    await page.locator("#agentRules").inputValue(),
    /conventions <script>/,
  );
  await click("closeModal");
  await code.fill(original);
  await click("suggest");
  await click("voice");
  await click("collaborate");
  await click("previewGuest");
  assert.equal(await page.locator("#voice").isDisabled(), true);
  assert.equal(await page.locator("#voiceSettings").isDisabled(), true);
  assert.equal(await page.locator("#rejectEdit").isDisabled(), true);
  assert.equal(await code.isEditable(), true);
  await code.press("Control+Enter");
  assert.doesNotMatch(await code.inputValue(), /signal\?\.throwIfAborted/);
  await code.fill(original + "// Edited by the guest\n");
  assert.equal(await text("voiceLabel"), "Pause & save");
  await click("openAgents");
  assert.equal(await page.locator('[data-run="reviewer"]').isDisabled(), true);
  assert.match(
    await page.locator('[data-result="reviewer"]').innerText(),
    /Draft changed/,
  );
  await click("closeModal");
  await click("collaborate");
  await click("previewGuest");
  assert.equal(await page.locator("#voice").isEnabled(), true);
  assert.match(await code.inputValue(), /Edited by the guest/);
  await click("voice");
  await click("rejectEdit");
  await click("suggest");
  await click("collaborate");
  await click("peerEdit");
  assert.equal(await page.locator("#acceptEdit").isDisabled(), true);
  assert.match(await code.inputValue(), /Mira: also verify/);
  await code.press("Control+Enter");
  assert.equal(await visible("proposal"), false);
  await page.keyboard.press("Control+k");
  assert.equal(await visible("modal"), true);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Task", exact: true }).click();
  await click("themeToggle");
  await page.screenshot({ path: "artifacts/zen-workbench/light.png" });
  for (const width of [1440, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Horizontal overflow at ${width}`,
    );
  }
  await page.screenshot({ path: "artifacts/zen-workbench/narrow.png" });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(
    (await page.request.get(`${url}/../../package.json`)).status(),
    404,
  );
  console.log(
    "Zen workbench: persistence, task isolation, edit guards, session controls, delivery, collaboration demo and responsive layout passed.",
  );
} finally {
  await browser?.close();
  server.kill();
}
