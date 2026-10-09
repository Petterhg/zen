import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localKey } from "../extension/src/local-keys.ts";
import { evaluateModel, togetherModels } from "./together-evaluation.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error("Usage: npm run eval:together -- /absolute/path/to/.env");
const keyFile = args[0] ? path.resolve(args[0]) : path.join(root, ".env");
const key =
  process.env.TOGETHER_API_KEY?.trim() ||
  (await localKey(keyFile, "TOGETHER_API_KEY"));
if (!key) {
  console.error(
    `Add TOGETHER_API_KEY to ${keyFile}, then rerun. Keep the key out of chat.`,
  );
  process.exitCode = 1;
} else {
  const report = {
    recordedAt: new Date().toISOString(),
    input: "built-in synthetic fixtures only",
    measurement: "complete HTTP answer, not first token or audible speech",
    reasoning: "provider default; no unsupported model-specific toggle assumed",
    models: [],
  };
  for (const model of togetherModels) {
    const result = await evaluateModel({
      model,
      apiKey: key,
      progress: (v) => console.log(v),
    });
    report.models.push(result);
    for (const r of result.results)
      console.log(
        `  ${r.scenario}: ${r.ok ? "PASS" : "FAIL"} ${r.elapsedMs}ms${r.error ? ` (${r.error})` : ""}`,
      );
    if (
      result.results.some((r) => /Together HTTP (401|403)/.test(r.error ?? ""))
    )
      break;
  }
  const directory = path.join(root, "artifacts/together");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(directory, `${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Report: ${reportPath}. PASS checks protocol/structure only; inspect answers for correctness.`,
  );
  if (report.models.some((m) => m.results.some((r) => !r.ok)))
    process.exitCode = 1;
}
