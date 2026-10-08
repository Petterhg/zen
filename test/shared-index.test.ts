import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { startSharedIndexServer } from "../extension/src/shared-index-server.js";
import { SharedIndexClient } from "../extension/src/shared-index-client.js";
import {
  sharedIndexPort,
  SHARED_PROTOCOL,
} from "../extension/src/shared-index-protocol.js";
import {
  embeddingDueAt,
  EMBEDDING_QUIET_MS,
  EMBEDDING_MAX_AGE_MS,
} from "../extension/src/shared-index-coordinator.js";
import { retireLegacyIndexes } from "../extension/src/index-migration.js";
const grammars = path.resolve(
  import.meta.dirname,
  "../extension/dist/grammars",
);
const daemonPath = path.resolve(
  import.meta.dirname,
  "../extension/dist/shared-index-daemon.cjs",
);
const vector = (n: number) =>
  Array.from({ length: 768 }, (_, i) => Number(i === n));
async function until(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(description);
}
test("shared owner coalesces windows, isolates checkouts before ranking, revalidates policy, and revokes registrations", async (t) => {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-index-shared-")),
  );
  const directory = path.join(base, "database"),
    a = path.join(base, "a"),
    b = path.join(base, "b");
  await mkdir(path.join(a, "services/auth"), { recursive: true });
  await mkdir(path.join(b, "services/auth"), { recursive: true });
  await writeFile(
    path.join(a, "services/auth/main.py"),
    "def authorize_alpha():\n    return True\n",
  );
  await writeFile(
    path.join(b, "services/auth/main.py"),
    "def authorize_beta():\n    return False\n",
  );
  await writeFile(path.join(a, ".env"), "PRIVATE_SOURCE_MARKER=secret");
  let alphaEmbeddings = 0;
  const server = await startSharedIndexServer(directory, {
    grammars,
    embed: async (texts) => {
      for (const text of texts) {
        assert.doesNotMatch(text, /PRIVATE_SOURCE_MARKER/);
        if (text.includes("authorize_alpha")) alphaEmbeddings++;
      }
      await new Promise((r) => setTimeout(r, 100));
      return texts.map((s) => vector(s.includes("alpha") ? 0 : 1));
    },
  });
  const clients = Array.from(
    { length: 3 },
    () => new SharedIndexClient({ directory, daemonPath, changed: () => {} }),
  );
  t.after(async () => {
    clients.forEach((c) => c.close());
    await server.close();
    await rm(base, { recursive: true, force: true });
  });
  await Promise.all([
    clients[0].register(
      [
        { path: a, name: "same-name" },
        { path: b, name: "same-name" },
      ],
      "fake",
      "rg",
    ),
    clients[1].register([{ path: a, name: "alias-a" }], "fake", "rg"),
    clients[2].register([{ path: b, name: "only-b" }], "fake", "rg"),
  ]);
  await until(async () => {
    const s = await clients[0].status();
    return s.roots.length === 2 && s.roots.every((r) => r.state === "ready");
  }, "shared roots never became ready");
  assert.equal(
    alphaEmbeddings,
    1,
    "two windows must not run duplicate indexing for the same checkout",
  );
  const signal = new AbortController().signal;
  const hits = await clients[0].search(
    a,
    "authorize",
    vector(0),
    { service: "services/auth", scope: "services/auth", language: "py" },
    signal,
  );
  assert.ok(hits.length);
  assert.ok(
    hits.every(
      (h) =>
        h.checkout === a &&
        h.text.includes("alpha") &&
        !h.text.includes("beta"),
    ),
  );
  assert.equal(
    (
      await clients[0].search(
        a,
        "authorize",
        vector(0),
        { service: "other" },
        signal,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await clients[0].search(
        a,
        "authorize",
        vector(0),
        { scope: "elsewhere" },
        signal,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await clients[0].search(
        a,
        "authorize",
        vector(0),
        { repository: "unknown" },
        signal,
      )
    ).length,
    0,
  );
  await assert.rejects(
    () => clients[2].search(a, "authorize", vector(0), {}, signal),
    /not registered/,
  );
  assert.equal((await clients[1].status()).roots[0].files, 1);
  clients[1].close();
  assert.ok(
    (await clients[0].search(a, "authorize", vector(0), {}, signal)).length,
  );
  await writeFile(
    path.join(a, "services/auth/main.py"),
    "def authorize_alpha_changed():\n    return 42\n",
  );
  await clients[0].refresh(a, "services/auth/main.py");
  await until(
    async () =>
      (await clients[0].status()).roots.find((r) => r.checkout === a)
        ?.pendingEmbeddings === 1,
    "saved change did not enter durable queue",
  );
  assert.equal(alphaEmbeddings, 1, "ordinary saves must wait before embedding");
  assert.match(
    (await clients[0].search(a, "authorize_alpha_changed", [], {}, signal))[0]
      .text,
    /42/,
  );
  await clients[0].refresh(a, undefined, true, true);
  await until(async () => {
    const status = (await clients[0].status()).roots.find(
      (r) => r.checkout === a,
    );
    return status?.state === "ready" && status.pendingEmbeddings === 0;
  }, "manual refresh did not flush embeddings");
  assert.equal(alphaEmbeddings, 2);
  await writeFile(path.join(a, ".pairignore"), "services/auth/\n");
  assert.equal(
    (await clients[0].search(a, "authorize", vector(0), {}, signal)).length,
    0,
    "new ignore policy must hide cached source immediately",
  );
  await clients[0].register([], "", "rg");
  await assert.rejects(
    () => clients[0].search(b, "authorize", vector(1), {}, signal),
    /not registered/,
  );
  assert.ok(
    (await clients[2].search(b, "authorize", vector(1), {}, signal)).length,
    "revoking one window must not cancel another window's registration",
  );
  const privateRoot = path.join(base, ".ssh");
  await mkdir(privateRoot);
  await assert.rejects(
    () =>
      clients[2].register(
        [{ name: "private", path: privateRoot }],
        "fake",
        "rg",
      ),
    /excluded from AI context/,
  );
  // Even a local unauthenticated socket cannot read registered roots or snippets.
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect(sharedIndexPort(directory), "127.0.0.1");
    let response = "";
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: "unauthorized",
          method: "hello",
          protocol: SHARED_PROTOCOL,
          token: "0".repeat(64),
        }) + "\n",
      ),
    );
    socket.on("data", (d) => (response += d));
    socket.on("close", () => resolve(response));
  });
  assert.match(reply, /authentication\/version mismatch/);
  assert.doesNotMatch(reply, /authorize_beta/);
});
test("migration wipes disposable old indexes including missing owner records, preserves personal state, and defers a live owner", async (t) => {
  const storage = await mkdtemp(path.join(tmpdir(), "zen-index-migrate-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const lock = path.join(storage, "indexes", "old", "owner.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(storage, "memory.json"), "personal-memory");
  await writeFile(path.join(storage, "indexes/old/v1.db"), "old-cache");
  assert.equal((await retireLegacyIndexes(storage)).retired, true);
  await assert.rejects(() => stat(path.join(storage, "indexes")), /ENOENT/);
  assert.equal(
    await readFile(path.join(storage, "memory.json"), "utf8"),
    "personal-memory",
  );
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "pid"), String(process.pid));
  assert.equal((await retireLegacyIndexes(storage)).deferred, true);
  await stat(lock);
  await rm(path.join(lock, "pid"));
  assert.equal((await retireLegacyIndexes(storage)).retired, true);
});
test("packaged daemon has one owner under simultaneous startup and automatically recovers after SIGKILL", async (t) => {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-index-process-")),
  );
  const directory = path.join(base, "database"),
    root = path.join(base, "empty");
  await mkdir(root);
  const clients = [0, 1].map(
    () => new SharedIndexClient({ directory, daemonPath, changed: () => {} }),
  );
  const pid = async () =>
    Number(
      JSON.parse(await readFile(path.join(directory, "service.json"), "utf8"))
        .pid,
    );
  t.after(async () => {
    clients.forEach((c) => c.close());
    try {
      process.kill(await pid(), "SIGTERM");
    } catch {
      /* already stopped */
    }
    await new Promise((r) => setTimeout(r, 300));
    await rm(base, { recursive: true, force: true });
  });
  await Promise.all(
    clients.map((c) => c.register([{ path: root, name: "empty" }], "", "rg")),
  );
  await until(
    async () => (await clients[0].status()).roots[0]?.state === "ready",
    "packaged daemon didn't index empty checkout",
  );
  const original = await pid();
  assert.notEqual(original, process.pid);
  assert.equal((await clients[1].status()).roots[0].checkout, root);
  process.kill(original, "SIGKILL");
  await until(async () => {
    try {
      return (
        (await pid()) !== original &&
        (await clients[0].status()).roots[0]?.state === "ready" &&
        (await clients[1].status()).roots[0]?.state === "ready"
      );
    } catch {
      return false;
    }
  }, "windows did not reconnect to a replacement owner");
  const diagnostic = await readFile(path.join(directory, "daemon.log"), "utf8");
  assert.doesNotMatch(diagnostic, /already owned|owner.lock|API key/);
});

test("embedding deadline uses 30 minute quiet period bounded by 60 minute age", () => {
  assert.equal(
    embeddingDueAt({ firstChanged: 0, lastChanged: 0 }),
    EMBEDDING_QUIET_MS,
  );
  assert.equal(
    embeddingDueAt({ firstChanged: 0, lastChanged: 45 * 60000 }),
    EMBEDDING_MAX_AGE_MS,
  );
});
