import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Only this prototype's profile; project Ruff config and user overrides take precedence.
export function applyPythonDefaults(settingsFile) {
  if (!existsSync(settingsFile)) return; // Launch creates the full editor defaults first.
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  const defaults = {
    "python.languageServer": "None",
    "basedpyright.importStrategy": "useBundled",
    "basedpyright.analysis.typeCheckingMode": "basic",
    "ruff.configurationPreference": "filesystemFirst",
  };
  for (const [key, value] of Object.entries(defaults)) settings[key] ??= value;
  settings["[python]"] = {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.formatOnSave": true,
    ...(settings["[python]"] ?? {}),
  };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}
