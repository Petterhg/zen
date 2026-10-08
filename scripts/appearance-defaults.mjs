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
  // Pair Graphite was the application's previous default. Keep custom themes intact.
  if (settings["workbench.colorTheme"] === "Pair Graphite")
    settings["workbench.colorTheme"] = "Zen Dark";
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}
