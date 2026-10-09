import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const next = plist.replace(iconKey, "$1Zen.icns$2");
  if (next !== plist) writeFileSync(plistFile, next);
}
