import { patchRuntimeLayout } from "./native-layout.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const start = "/* zen-native-shell:start */";
const end = "/* zen-native-shell:end */";
export function applyNativeShell(cssFile) {
  const original = readFileSync(cssFile, "utf8");
  const begin = original.indexOf(start);
  const finish = original.indexOf(end);
  if (begin < 0 !== finish < 0 || (begin >= 0 && finish < begin))
    throw new Error(`Invalid Zen overlay markers in ${cssFile}`);
  const base =
    begin < 0 ? original.trimEnd() : original.slice(0, begin).trimEnd();
  const suffix = finish < 0 ? "" : original.slice(finish + end.length).trim();
  const css = readFileSync(
    new URL("./native-shell.css", import.meta.url),
    "utf8",
  ).trim();
  const next = `${base}\n${start}\n${css}\n${end}\n${suffix ? suffix + "\n" : ""}`;
  if (next !== original) writeFileSync(cssFile, next);
}

export function applyRuntimeShell(resources) {
  patchRuntimeLayout(resources);
  applyNativeShell(
    path.join(resources, "out/vs/workbench/workbench.desktop.main.css"),
  );
  const productFile = path.join(resources, "product.json");
  const product = JSON.parse(readFileSync(productFile, "utf8"));
  product.nameShort = product.nameLong = "Zen";
  for (const relative of Object.keys(product.checksums ?? {})) {
    product.checksums[relative] = createHash("sha256")
      .update(readFileSync(path.join(resources, "out", relative)))
      .digest("base64")
      .replace(/=+$/, "");
  }
  writeFileSync(productFile, JSON.stringify(product, null, 2));
}
