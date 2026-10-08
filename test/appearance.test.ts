import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
      JSON.stringify({ "workbench.colorTheme": "Pair Graphite" }),
    );
    apply();
    assert.equal(
      JSON.parse(readFileSync(file, "utf8"))["workbench.colorTheme"],
      "Zen Dark",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
