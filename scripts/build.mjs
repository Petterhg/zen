import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
await build({
  entryPoints: ["extension/src/extension.ts"],
  outfile: "extension/dist/extension.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["vscode", "@tursodatabase/database", "web-tree-sitter"],
  sourcemap: true,
});
console.log("Pair Code extension built.");

await build({
  entryPoints: ["extension/src/live-protocol.ts"],
  outfile: "extension/media/live-protocol.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  globalName: "PairLive",
});

// Native Turso packages and Tree-sitter assets must live beside the bundled host.
await mkdir("extension/dist/node_modules/@tursodatabase", { recursive: true });
for (const name of await readdir("node_modules/@tursodatabase"))
  await cp(
    path.join("node_modules/@tursodatabase", name),
    path.join("extension/dist/node_modules/@tursodatabase", name),
    { recursive: true },
  );
await cp(
  "node_modules/web-tree-sitter",
  "extension/dist/node_modules/web-tree-sitter",
  { recursive: true },
);
await mkdir("extension/dist/grammars", { recursive: true });
for (const language of [
  "python",
  "typescript",
  "tsx",
  "javascript",
  "json",
  "yaml",
])
  await cp(
    `node_modules/tree-sitter-wasms/out/tree-sitter-${language}.wasm`,
    `extension/dist/grammars/tree-sitter-${language}.wasm`,
  );

await cp(
  "node_modules/tree-sitter-wasms/LICENSE",
  "extension/dist/grammars/LICENSE",
);
