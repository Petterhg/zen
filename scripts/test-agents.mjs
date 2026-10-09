import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1080 },
  });
  await page.addInitScript(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.messages.push(m),
    });
  });
  // Load actual assets with a simulated host; no network or model calls.
  await page.route("https://agents.test/**", (route) =>
    route.fulfill({ body: "<html></html>", contentType: "text/html" }),
  );
  await page.goto("https://agents.test/");
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.messages.push(m),
    });
  });
  const html = (await readFile("extension/media/agents.html", "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/<link[^>]*>/, "")
    .replace(/<script[^>]*><\/script>/, "");
  await page.setContent(html);
  await page.addStyleTag({
    content: await readFile("extension/media/agents.css", "utf8"),
  });
  await page.addScriptTag({
    content: await readFile("extension/media/agents.js", "utf8"),
  });
  assert.deepEqual(await page.evaluate(() => window.messages), [
    { type: "ready" },
  ]);
  const agents = {
    explorer: {
      name: "Explorer",
      description: "Discovery",
      mode: "foreground",
      orientation: true,
      enabled: true,
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
      reasoningEffort: "medium",
      instructions: "Source-backed discovery and summaries.",
    },
    deep_research: {
      name: "Deep research",
      description: "Complex questions",
      mode: "background",
      orientation: false,
      enabled: true,
      model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      reasoningEffort: "high",
      instructions: "Inspect both sides of cross-service contracts.",
    },
  };
  const models = [
    agents.explorer.model,
    agents.deep_research.model,
    "zai-org/GLM-5.3-Flash",
  ];
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    { type: "settings", agents, models, togetherReady: true },
  );
  assert.equal(await page.locator("#explorer-model").inputValue(), models[0]);
  assert.equal(
    await page.locator("#deep_research-effort").inputValue(),
    "high",
  );
  await page
    .locator("#explorer-instructions")
    .fill('<img src=x onerror="window.injected=true">Use tests first.');
  // A key-status refresh must preserve pending human edits.
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "settings", togetherReady: false },
      }),
    ),
  );
  assert.match(
    await page.locator("#explorer-instructions").inputValue(),
    /Use tests first/,
  );
  await page.locator('[data-agent="deep_research"] summary').click();
  await page.locator("#deep_research-enabled").uncheck();
  await page.locator("#save").click();
  const saved = await page.evaluate(() => window.messages.at(-1));
  assert.equal(saved.type, "save");
  assert.equal(saved.agents.deep_research.enabled, false);
  assert.equal(saved.agents.explorer.model, models[0]);
  assert.match(saved.agents.explorer.instructions, /Use tests first/);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "error", text: "Invalid configuration" },
      }),
    ),
  );
  assert.equal(await page.locator("#save").isEnabled(), true);
  await page.locator("#keys").click();
  assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
    type: "configureKeys",
  });
  await page.locator("#add").click();
  assert.equal(await page.locator(".profile").count(), 3);
  const custom = page.locator(".profile").last();
  await custom.locator('input[id$="-name"]').fill("API critic");
  await custom
    .locator('textarea[id$="-description"]')
    .fill("Use when reviewing API compatibility");
  await custom.locator('select[id$="-mode"]').selectOption("background");
  await page.locator("#save").click();
  const created = await page.evaluate(() => window.messages.at(-1));
  assert.equal(Object.keys(created.agents).length, 3);
  assert.equal(Object.values(created.agents).at(-1).name, "API critic");
  assert.equal(Object.values(created.agents).at(-1).mode, "background");
  await custom.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal(await page.locator(".profile").count(), 2);
  // Visual checks use actual page/assets at both desktop and narrow widths.
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    { type: "settings", agents, models, togetherReady: true },
  );
  await page.evaluate(() => {
    document.getElementById("status").textContent = "";
  });
  await mkdir("artifacts/agent-settings", { recursive: true });
  await page.screenshot({
    path: "artifacts/agent-settings/light.png",
    fullPage: true,
  });
  await page.addStyleTag({
    content:
      "body { --vscode-foreground:#d1d8cd; --vscode-editor-background:#101713; --vscode-descriptionForeground:#8c9a90; --vscode-panel-border:#2a352d; --vscode-input-background:#18221a; --vscode-input-foreground:#d1d8cd; --vscode-input-border:#394435; --vscode-button-background:#283726; --vscode-button-foreground:#c6d5b8; --vscode-button-border:#7e9170; }",
  });
  await page.screenshot({
    path: "artifacts/agent-settings/dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 380, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  console.log(
    "Agent settings passed: actual light/dark assets, profile edits, disabled agents, key-only refresh, safe instruction rendering and narrow layout. Simulated host; no native editor or model calls.",
  );
} finally {
  await browser.close();
}
