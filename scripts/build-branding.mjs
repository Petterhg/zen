// Optional asset regeneration on macOS; checked-in outputs keep npm start portable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (process.platform !== "darwin")
  throw new Error("Icon regeneration requires macOS sips and iconutil.");
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), "zen-icons-"));
const iconset = path.join(temp, "Zen.iconset");
mkdirSync(iconset);
try {
  execFileSync("sips", [
    "-z",
    "128",
    "128",
    path.join(root, "assets/brand/enso-master.png"),
    "--out",
    path.join(root, "extension/media/zen-mark.png"),
  ]);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      execFileSync("sips", [
        "-z",
        pixels,
        pixels,
        path.join(root, "assets/brand/app-icon.png"),
        "--out",
        path.join(
          iconset,
          `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
        ),
      ]);
    }
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(root, "assets/brand/zen.icns"),
  ]);
  console.log("Generated Zen header mark and multi-resolution macOS icon.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
