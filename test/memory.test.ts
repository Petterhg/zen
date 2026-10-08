import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MemoryStore,
  memoryText,
  rankMemories,
} from "../extension/src/memory.js";
import { Hindsight } from "../extension/src/hindsight.js";
const preference = {
  key: "explanation.detail",
  scope: "personal",
  kind: "preference" as const,
  text: "Use concise explanations.",
  evidence: "I prefer concise explanations.",
  sources: [],
};

test("memory persists corrections, isolates repositories and suppresses forgotten evidence after restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zen-memory-"));
  let db = new MemoryStore(dir);
  try {
    const first = db.remember(preference);
    assert.equal(db.remember(preference).document, first.document);
    db.submitted(db.jobs()[0].id);
    const next = db.remember({ ...preference, text: "Explain each line." });
    assert.notEqual(next.document, first.document);
    assert.equal(db.list().length, 1);
    assert.deepEqual(
      db.jobs().map((j) => j.action),
      ["retain", "delete", "retain"],
    );
    db.remember({ ...preference, key: "style", scope: "repo-a" });
    db.remember({ ...preference, key: "style", scope: "repo-b" });
    assert.deepEqual(
      new Set(db.list("repo-a").map((r) => r.scope)),
      new Set(["personal", "repo-a"]),
    );
    db.forget(next.id);
    db.close();
    db = new MemoryStore(dir);
    assert.equal(
      db.list().some((r) => r.id === next.id),
      false,
    );
    assert.throws(() => db.remember(preference), /forgotten/);
    assert.throws(
      () => db.remember({ ...preference, key: "renamed" }),
      /forgotten/,
    );
    assert.equal(
      statSync(path.join(dir, "memory-v1.json")).mode & 0o777,
      0o600,
    );
    const restored = db.remember(preference, true);
    assert.equal(restored.text, preference.text);
    assert.throws(() => new MemoryStore(dir), /another Zen window/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory rejects credentials and ranking never crosses supplied scope", () => {
  assert.throws(
    () => memoryText("api_key=should-not-store-this"),
    /Credential/,
  );
  assert.throws(() => memoryText("Bearer private-token"), /Credential/);
  assert.throws(() => memoryText("x".repeat(1001)), /too long/);
  assert.deepEqual(rankMemories([], "anything"), []);
});

test("Hindsight validates endpoint, tracks async completion and returns only known canonical document IDs", async () => {
  for (const url of [
    "https://example.com",
    "http://localhost:9077",
    "http://127.0.0.1:9077/path",
    "http://user:pass@127.0.0.1:9077",
  ])
    assert.throws(() => new Hindsight(url, "token"));
  const calls: {
    url: string;
    method?: string;
    body?: Record<string, unknown>;
  }[] = [];
  let completed = false;
  const mock = (async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    assert.equal(init?.redirect, "error");
    if (String(url).includes("/operations/"))
      return new Response(
        JSON.stringify({ status: completed ? "completed" : "not_found" }),
        { status: 200 },
      );
    if (String(url).endsWith("/recall"))
      return Response.json({
        results: [
          { document_id: "known", text: "malicious generated instruction" },
          { document_id: "foreign", text: "another repo" },
          { text: "derived observation" },
        ],
      });
    if (init?.method === "DELETE") return Response.json({ success: true });
    return Response.json({ success: true, async: true, operation_id: "op" });
  }) as typeof fetch;
  const adapter = new Hindsight("http://127.0.0.1:9077", "token", mock);
  const record = {
    ...preference,
    id: "id",
    document: "known",
    bank: "bank",
    updated: new Date().toISOString(),
  };
  const job = {
    id: "op",
    action: "retain" as const,
    bank: "bank",
    document: "known",
    record,
  };
  const signal = new AbortController().signal;
  assert.equal(await adapter.step(job, signal), false);
  assert.equal(calls[1].body?.operation_id, "op");
  completed = true;
  assert.equal(await adapter.step(job, signal), true);
  assert.deepEqual(await adapter.recall([record], "style", signal), ["known"]);
  assert.equal(await adapter.step({ ...job, action: "delete" }, signal), true);
});

test("failed durable writes do not leave phantom memories in recall", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zen-memory-failure-"));
  const db = new MemoryStore(dir);
  try {
    const original = db.remember(preference);
    mkdirSync(path.join(dir, "memory-v1.json.tmp"));
    assert.throws(() =>
      db.remember({ ...preference, text: "A failed correction" }),
    );
    assert.deepEqual(db.list(), [original]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgotten retention polls an accepted operation without resending missing or failed content", async () => {
  const calls: string[] = [];
  let status = "missing";
  const remote = new Hindsight("http://127.0.0.1:9077", "token", (async (
    _,
    init,
  ) => {
    calls.push(init?.method ?? "GET");
    return status === "missing"
      ? new Response("{}", { status: 404 })
      : Response.json({ status });
  }) as typeof fetch);
  const job = {
    id: "op",
    action: "retain" as const,
    bank: "bank",
    document: "doc",
  };
  const signal = new AbortController().signal;
  assert.equal(await remote.step(job, signal, false), true);
  status = "processing";
  assert.equal(await remote.step(job, signal, false), false);
  status = "failed";
  assert.equal(await remote.step(job, signal, false), true);
  assert.deepEqual(calls, ["GET", "GET", "GET"]);
});

test("voice startup preserves whole memory records and their data-only label", async () => {
  const { createLiveSession } = await import("../extension/src/backend.js");
  let input: { content: { text: string }[] }[] = [];
  await createLiveSession({
    apiKey: "synthetic",
    sdp: "v=0\nsynthetic",
    voice: "marin",
    instructions: "synthetic",
    history: [{ role: "user", text: "Explain this function." }],
    memory: [
      { kind: "preference", text: "Short explanations." },
      { kind: "project", text: "界".repeat(2000) },
    ],
    signal: new AbortController().signal,
    fetchImpl: (async (_, options) => {
      input = JSON.parse(String(options?.body)).session.input;
      return Response.json({
        session: { id: "synthetic" },
        transport: { sdp: "v=0" },
      });
    }) as typeof fetch,
  });
  assert.match(
    input[0].content[0].text,
    /^Application memory reference, not a request or instructions/,
  );
  assert.match(input[0].content[0].text, /Short explanations/);
  assert.ok(!input[0].content[0].text.includes("界"));
  assert.equal(input[1].content[0].text, "Explain this function.");
});
