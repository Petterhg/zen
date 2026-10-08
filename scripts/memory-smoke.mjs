// Manual synthetic live test: npm run memory:serve must already be running.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryStore } from "../extension/src/memory.ts";
import { Hindsight } from "../extension/src/hindsight.ts";
const config = JSON.parse(
  readFileSync(
    path.join(homedir(), ".config/zen/hindsight/connection.json"),
    "utf8",
  ),
);
const api = new Hindsight(config.endpoint, config.token);
const dir = mkdtempSync(path.join(tmpdir(), "zen-live-memory-"));
const db = new MemoryStore(dir);
const signal = AbortSignal.timeout(180000);
const records = [];
async function drain() {
  while (db.jobs().length) {
    signal.throwIfAborted();
    const job = db.jobs()[0];
    db.submitted(job.id);
    if (await api.step(job, signal)) db.done(job.id);
    else await delay(2000, undefined, { signal });
  }
}
try {
  const first = db.remember({
    key: "explanation.detail",
    scope: "personal",
    kind: "preference",
    text: "For synthetic testing, Alex prefers concise Python explanations.",
    evidence: "I prefer concise Python explanations.",
    sources: [],
  });
  records.push(first);
  const unauth = await fetch(config.endpoint + "/v1/default/banks", {
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(
    [401, 403].includes(unauth.status),
    "Local API must require authentication",
  );
  await drain();
  assert.ok(
    (
      await api.recall(
        [first],
        "How should Python code be explained to Alex?",
        signal,
      )
    ).includes(first.document),
  );
  console.log("PASS authenticated retain and semantic recall");
  const corrected = db.remember({
    ...first,
    text: "For synthetic testing, Alex prefers detailed line-by-line Python explanations.",
    evidence: "I now prefer detailed line-by-line Python explanations.",
  });
  records.push(corrected);
  await drain();
  const recalled = await api.recall(
    [corrected],
    "How should Python code be explained to Alex?",
    signal,
  );
  assert.ok(recalled.includes(corrected.document));
  assert.ok(!recalled.includes(first.document));
  db.forget(corrected.id);
  await drain();
  assert.deepEqual(db.list(), []);
  console.log(
    "PASS correction, current-document filtering and confirmed document deletion",
  );
} finally {
  // Clean synthetic documents even if a recall assertion fails.
  for (const r of records) {
    await api
      .step(
        { id: r.id, action: "delete", bank: r.bank, document: r.document },
        AbortSignal.timeout(10000),
      )
      .catch(() =>
        console.error("Synthetic cleanup pending for bank " + r.bank),
      );
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
