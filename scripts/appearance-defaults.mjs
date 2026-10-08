import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(
  readFileSync(new URL("../extension/package.json", import.meta.url), "utf8"),
);
export const appearanceDefaults = manifest.contributes.configurationDefaults;
// Only seed missing values. Existing personal appearance choices win.
export function applyAppearanceDefaults(settingsFile) {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  for (const [key, value] of Object.entries(appearanceDefaults))
    settings[key] ??= value;
  // Replace exact former application defaults, without resetting custom values.
  const previousDefaults = {
    "editor.fontFamily": "SF Mono, Menlo, Consolas, monospace",
    "terminal.integrated.fontFamily": "SF Mono, Menlo, Consolas, monospace",
    "window.density.editorTabHeight": "compact",
    "terminal.integrated.lineHeight": 1.4,
    "editor.padding.top": 18,
  };
  for (const [key, value] of Object.entries(previousDefaults)) {
    if (settings[key] === value) settings[key] = appearanceDefaults[key];
  }
  // Pair Graphite was the application's previous default. Keep custom themes intact.
  if (settings["workbench.colorTheme"] === "Pair Graphite")
    settings["workbench.colorTheme"] = "Zen Dark";
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}
