import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  console.log(
    "Native helper fixture passed: one title toggle, fold state, full editor/terminal height, no duplicate heading, disposal.",
  );
} finally {
  await browser.close();
}
