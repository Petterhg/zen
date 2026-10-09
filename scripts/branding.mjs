import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Install assets before the launcher signs the bundle. Never change its identity. */
export function applyRuntimeIcon(resources) {
  const contents = path.resolve(resources, "../..");
  const plistFile = path.join(contents, "Info.plist");
  if (!existsSync(plistFile)) return; // Non-macOS/source fixture.
  const plist = readFileSync(plistFile, "utf8");
  const iconKey = /(<key>CFBundleIconFile<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!iconKey.test(plist))
    throw new Error("Cannot locate the macOS app icon declaration.");
  const icon = readFileSync(
    new URL("../assets/brand/zen.icns", import.meta.url),
  );
  const destination = path.join(contents, "Resources/Zen.icns");
  if (!existsSync(destination) || !readFileSync(destination).equals(icon))
    writeFileSync(destination, icon);
  // Asset-catalog names take precedence over CFBundleIconFile on macOS.
  let next = plist
    .replace(iconKey, "$1Zen.icns$2")
    .replace(/\s*<key>CFBundleIconName<\/key>\s*<string>[^<]*<\/string>/g, "");
  for (const [key, value] of [
    ["CFBundleDisplayName", "Zen"],
    ["CFBundleName", "VSCodium"],
  ]) {
    const field = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (field.test(next)) next = next.replace(field, `$1${value}$2`);
    else
      next = next.replace(
        "<dict>",
        `<dict>\n<key>${key}</key><string>${value}</string>`,
      );
  }
  // CFBundleName must match the pinned VSCodium Helper executables.
  // Keep Electron package.name and the bundle identifier unchanged: existing
  // SecretStorage uses that application identity, independently of display branding.

  if (next !== plist) writeFileSync(plistFile, next);
  applyDisplayName(contents);
}

/** Localized display metadata leaves Electron's raw helper lookup name intact. */
function applyDisplayName(contents) {
  const resources = path.join(contents, "Resources");
  const locales = new Set([
    "en.lproj",
    ...readdirSync(resources).filter((name) => name.endsWith(".lproj")),
  ]);
  for (const locale of locales) {
    const directory = path.join(resources, locale);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "InfoPlist.strings");
    const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
    let next = previous;
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      const field = new RegExp(`"?${key}"?\\s*=\\s*"[^"\\n]*"\\s*;`, "g");
      const value = `"${key}" = "Zen";`;
      next = field.test(next)
        ? next.replace(field, value)
        : `${next}\n${value}\n`;
    }
    if (next !== previous) writeFileSync(file, next);
  }
}
