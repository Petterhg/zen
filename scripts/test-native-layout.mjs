import assert from "node:assert/strict";
import { nativeShellCss } from "./native-shell.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { transform } from "esbuild";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<main><div class="titlebar"></div><div class="editor"></div><div class="panel"></div></main>',
  );
  await page.addScriptTag({
    content: (
      await transform(
        (await readFile("scripts/native-layout.ts", "utf8")).replaceAll(
          "export function",
          "function",
        ),
        { loader: "ts" },
      )
    ).code,
  });
  const result = await page.evaluate(async () => {
    let listener,
      visible = true;
    const commands = [],
      disposables = [];
    const part = (selector) => ({
      getContainer: () => document.querySelector(selector),
      contextKeyService: {
        onDidChangeContext: (fn) => {
          listener = fn;
          return {
            dispose() {
              listener = undefined;
            },
          };
        },
      },
      layoutService: { isVisible: () => visible },
      instantiationService: {
        invokeFunction: (fn) =>
          fn({
            get: () => ({
              executeCommand: async (id) => {
                commands.push(id);
                visible = !visible;
              },
            }),
          }),
      },
      _register: (d) => disposables.push(d),
    });
    const title = part(".titlebar");
    const sizes = [
      zenLayoutPart(title, 900, 54, "commands"),
      zenLayoutPart(part(".editor"), 900, 600, "commands"),
      zenLayoutPart(part(".panel"), 900, 210, "commands"),
    ];
    zenLayoutPart(title, 900, 54, "commands");
    const button = document.querySelector(".zen-workboard-toggle");
    const initial = button.getAttribute("aria-expanded");
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    const folded = button.getAttribute("aria-expanded");
    visible = true;
    listener();
    const restored = button.getAttribute("aria-expanded");
    const count = document.querySelectorAll("button").length;
    const group = {
      element: document.createElement("div"),
      titleContainer: document.createElement("div"),
      editorContainer: document.createElement("div"),
    };
    group.element.innerHTML =
      '<section class="zen-file-heading">Old duplicate heading</section>';
    group.element.append(group.titleContainer, group.editorContainer);
    zenLayoutGroup(group, 900, 600);
    const heading = group.element.querySelector(".zen-file-heading");
    disposables.forEach((d) => d.dispose());
    return {
      sizes,
      initial,
      folded,
      restored,
      count,
      commands,
      heading: !!heading,
      width: group.titleContainer.style.width,
      remaining: document.querySelectorAll("button").length,
    };
  });
  assert.deepEqual(result, {
    sizes: [54, 600, 210],
    initial: "true",
    folded: "false",
    restored: "true",
    count: 1,
    commands: ["pairCode.toggleWorkboard"],
    heading: false,
    width: "844px",
    remaining: 0,
  });
  await mkdir("artifacts/branding", { recursive: true });
  const icon = (await readFile("assets/brand/app-icon.png")).toString("base64");
  await page.setViewportSize({ width: 640, height: 300 });
  await page.setContent(
    `<style>${nativeShellCss()} body{margin:0} .titlebar{position:relative;height:54px;border-bottom:1px solid #8883} .preview{height:246px;display:flex;align-items:center;justify-content:center;gap:24px}.preview img{object-fit:contain}</style><div class="monaco-workbench"><div class="part titlebar"><div class="titlebar-left"></div></div></div><div class="preview"><img width="160" height="160" src="data:image/png;base64,${icon}"><img width="64" height="64" src="data:image/png;base64,${icon}"><img width="32" height="32" src="data:image/png;base64,${icon}"></div>`,
  );
  for (const theme of ["light", "dark"]) {
    const palette = JSON.parse(
      await readFile(`extension/media/zen-${theme}.json`, "utf8"),
    );
    await page.evaluate((colors) => {
      for (const [key, value] of Object.entries(colors))
        document.documentElement.style.setProperty(
          "--vscode-" + key.replaceAll(".", "-"),
          value,
        );
      document.body.style.background = colors["editor.background"];
    }, palette.colors);
    assert.match(
      await page
        .locator(".titlebar-left")
        .evaluate((el) => getComputedStyle(el, "::before").maskImage),
      /^url\("data:image\/png;base64,/,
    );
    await page.screenshot({ path: `artifacts/branding/${theme}.png` });
  }
  console.log(
    "Native helper fixture passed: one title toggle, fold state, full editor/terminal height, no duplicate heading, disposal.",
  );
} finally {
  await browser.close();
}
