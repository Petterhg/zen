import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("appearance migration preserves user choices and seeds missing defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "zen-appearance-"));
  const file = join(directory, "settings.json");
  const moduleUrl = new URL(
    "../scripts/appearance-defaults.mjs",
    import.meta.url,
  ).href;
  const apply = () =>
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { applyAppearanceDefaults } from ${JSON.stringify(moduleUrl)}; applyAppearanceDefaults(process.argv[1]);`,
      file,
    ]);
  try {
    writeFileSync(
      file,
      JSON.stringify({
        "workbench.colorTheme": "Custom Theme",
        "editor.fontSize": 17,
        "pairCode.assistanceLevel": 0,
      }),
    );
    apply();
    const first = readFileSync(file, "utf8");
    const settings = JSON.parse(first);
    assert.equal(settings["workbench.colorTheme"], "Custom Theme");
    assert.equal(settings["editor.fontSize"], 17);
    assert.equal(settings["pairCode.assistanceLevel"], 0);
    assert.equal(settings["workbench.preferredLightColorTheme"], "Zen Light");
    apply();
    assert.equal(readFileSync(file, "utf8"), first);
    writeFileSync(
      file,
      JSON.stringify({
        "workbench.colorTheme": "Pair Graphite",
        "editor.fontFamily": "SF Mono, Menlo, Consolas, monospace",
        "terminal.integrated.fontFamily": "Custom Mono",
        "window.density.editorTabHeight": "compact",
      }),
    );
    apply();
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    assert.match(migrated["editor.fontFamily"], /Courier New/);
    assert.equal(migrated["terminal.integrated.fontFamily"], "Custom Mono");
    assert.equal(migrated["window.density.editorTabHeight"], "default");
    assert.equal(
      JSON.parse(readFileSync(file, "utf8"))["workbench.colorTheme"],
      "Zen Dark",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native shell overlay updates idempotently and preserves upstream CSS", () => {
  const directory = mkdtempSync(join(tmpdir(), "zen-shell-"));
  const file = join(directory, "workbench.css");
  const moduleUrl = new URL("../scripts/native-shell.mjs", import.meta.url)
    .href;
  const apply = () =>
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { applyNativeShell } from ${JSON.stringify(moduleUrl)}; applyNativeShell(process.argv[1]);`,
      file,
    ]);
  try {
    writeFileSync(file, "body { color: red; }\n");
    apply();
    const first = readFileSync(file, "utf8");
    apply();
    assert.equal(readFileSync(file, "utf8"), first);
    assert.ok(first.startsWith("body { color: red; }"));
    writeFileSync(
      file,
      first.replace(
        "/* zen-native-shell:start */",
        "/* zen-native-shell:start */\n.old-overlay {}",
      ),
    );
    apply();
    assert.equal(readFileSync(file, "utf8"), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS branding installs a valid icon idempotently without changing bundle identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "zen-branding-"));
  const contents = join(directory, "Zen.app/Contents"),
    resources = join(contents, "Resources/app");
  mkdirSync(resources, { recursive: true });
  const plist = join(contents, "Info.plist");
  writeFileSync(
    plist,
    "<plist><dict><key>CFBundleIconFile</key><string>VSCodium.icns</string><key>CFBundleIdentifier</key><string>dev.paircode.editor</string></dict></plist>",
  );
  const moduleUrl = new URL("../scripts/branding.mjs", import.meta.url).href;
  const apply = () =>
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import {applyRuntimeIcon} from ${JSON.stringify(moduleUrl)};applyRuntimeIcon(process.argv[1]);`,
      resources,
    ]);
  try {
    apply();
    const first = readFileSync(plist, "utf8"),
      icon = readFileSync(join(contents, "Resources/Zen.icns"));
    assert.match(first, /<string>Zen.icns<\/string>/);
    assert.match(first, /dev.paircode.editor/);
    assert.equal(icon.subarray(0, 4).toString(), "icns");
    assert.equal(icon.readUInt32BE(4), icon.length);
    apply();
    assert.equal(readFileSync(plist, "utf8"), first);
    assert.deepEqual(readFileSync(join(contents, "Resources/Zen.icns")), icon);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
