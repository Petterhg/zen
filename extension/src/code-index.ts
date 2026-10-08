import type { Database } from "@tursodatabase/database";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodeChunker, digest, INDEX_VERSION } from "./code-chunks.js";
import { EMBEDDING_DIMENSIONS, type Embed } from "./embeddings.js";
export interface IndexedFile {
  checkout?: string;
  repository?: string;
  path: string;
  text: string;
  service: string;
  language: string;
}
export interface IndexHit {
  checkout?: string;
  repository?: string;
  id: string;
  path: string;
  service: string;
  language: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentStart: number;
  parentEnd: number;
  text: string;
  hash: string;
  distance?: number;
  score?: number;
}
export interface IndexFilter {
  checkout?: string;
  repository?: string;
  service?: string;
  scope?: string;
  language?: string;
}
export class IndexBusyError extends Error {
  constructor(public readonly ownerPid?: number) {
    super(
      `This checkout index is already owned by another Zen window${ownerPid ? ` (process ${ownerPid})` : ""}. Waiting for that window to release it.`,
    );
    this.name = "IndexBusyError";
  }
}
/** One owner and serialized DB operations: Turso transactions never interleave. */
export class CodeIndex {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private db: Database,
    private lock: string | undefined,
    private embed: Embed,
    private chunker: CodeChunker,
  ) {}
  static async open(
    directory: string,
    embed: Embed,
    chunker: CodeChunker,
    kernelOwned = false,
  ): Promise<CodeIndex> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = kernelOwned ? undefined : path.join(directory, "owner.lock");
    if (lock) {
      try {
        await mkdir(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let alive = true;
        let ownerPid: number | undefined;
        try {
          const pid = Number(await readFile(path.join(lock, "pid"), "utf8"));
          if (!Number.isInteger(pid) || pid < 1)
            throw new Error("Invalid index lock.");
          ownerPid = pid;
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw new IndexBusyError(ownerPid);
        await rm(lock, { recursive: true, force: true });
        await mkdir(lock);
      }
      await writeFile(path.join(lock, "pid"), String(process.pid), {
        mode: 0o600,
      });
    }
    let db: Database | undefined;
    try {
      const { connect } = await import("@tursodatabase/database");
      db = await connect(path.join(directory, `shared2-${INDEX_VERSION}.db`));
      await db.exec(`CREATE TABLE IF NOT EXISTS files(checkout TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, service TEXT NOT NULL, language TEXT NOT NULL, repository TEXT NOT NULL, PRIMARY KEY(checkout,path));
        CREATE TABLE IF NOT EXISTS embeddings(hash TEXT PRIMARY KEY, vector BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, checkout TEXT NOT NULL, repository TEXT NOT NULL, path TEXT NOT NULL, service TEXT NOT NULL, language TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, startLine INTEGER NOT NULL, endLine INTEGER NOT NULL, parentStart INTEGER NOT NULL, parentEnd INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, embedding BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS chunk_scope ON chunks(checkout,service,path);
        CREATE INDEX IF NOT EXISTS chunk_path ON chunks(checkout,path);`);
      return new CodeIndex(db, lock, embed, chunker);
    } catch (error) {
      await db?.close();
      if (lock) await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
  async stats(checkout = ""): Promise<{ files: number; chunks: number }> {
    return this.serial(async () => {
      const [files] = await this.db.all(
        "SELECT COUNT(*) AS n FROM files WHERE checkout=?",
        checkout,
      );
      const [chunks] = await this.db.all(
        "SELECT COUNT(*) AS n FROM chunks WHERE checkout=?",
        checkout,
      );
      return { files: Number(files.n), chunks: Number(chunks.n) };
    });
  }
  async services(checkout = ""): Promise<string[]> {
    return this.serial(async () =>
      (
        await this.db.all(
          "SELECT DISTINCT service FROM files WHERE checkout=? ORDER BY service",
          checkout,
        )
      ).map((r: { service: string }) => r.service),
    );
  }
  async paths(checkout = ""): Promise<string[]> {
    return this.serial(async () =>
      (
        await this.db.all("SELECT path FROM files WHERE checkout=?", checkout)
      ).map((r: { path: string }) => r.path),
    );
  }
  async remove(file: string, checkout = ""): Promise<void> {
    await this.serial(async () => {
      await this.db.exec("BEGIN");
      try {
        await this.db.run(
          "DELETE FROM chunks WHERE checkout=? AND path=?",
          checkout,
          file,
        );
        await this.db.run(
          "DELETE FROM files WHERE checkout=? AND path=?",
          checkout,
          file,
        );
        await this.db.exec("COMMIT");
      } catch (e) {
        await this.db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  async update(
    file: IndexedFile,
    signal: AbortSignal,
    current: () => Promise<boolean> = async () => true,
    embed: Embed = this.embed,
  ): Promise<{ embedded: number; reused: number; stale?: boolean }> {
    signal.throwIfAborted();
    const checkout = file.checkout ?? "";
    const repository = file.repository ?? "";
    const hash = digest(file.text);
    const old = await this.serial(() =>
      this.db.get(
        "SELECT hash,service,language,repository FROM files WHERE checkout=? AND path=?",
        checkout,
        file.path,
      ),
    );
    if (
      old?.hash === hash &&
      old.service === file.service &&
      old.language === file.language &&
      old.repository === repository
    )
      return { embedded: 0, reused: 0 };
    const chunks = await this.chunker.chunks(file.path, file.text);
    const inputs = chunks.map(
      (c) =>
        `File: ${file.path}\nService: ${file.service}\nLanguage: ${file.language}\nSymbol: ${c.symbol}\nContext: ${c.header}\n\n${c.text}`,
    );
    const hashes = inputs.map((t) => digest(INDEX_VERSION + "\n" + t));
    const vectors = new Map<string, number[]>();
    await this.serial(async () => {
      for (const h of new Set(hashes)) {
        const row = await this.db.get(
          "SELECT vector_extract(vector) AS value FROM embeddings WHERE hash=?",
          h,
        );
        if (row) vectors.set(h, JSON.parse(row.value));
      }
    });
    const missing = [...new Set(hashes)].filter((h) => !vectors.has(h));
    let embedded = 0;
    for (let i = 0; i < missing.length; i += 16) {
      signal.throwIfAborted();
      if (!(await current())) return { embedded, reused: 0, stale: true };
      const batch = missing.slice(i, i + 16);
      const values = await embed(
        batch.map((h) => inputs[hashes.indexOf(h)]),
        signal,
      );
      if (
        values.length !== batch.length ||
        values.some(
          (v) =>
            v.length !== EMBEDDING_DIMENSIONS ||
            v.some((n) => !Number.isFinite(n)),
        )
      )
        throw new Error("Embedding dimensions do not match index.");
      batch.forEach((h, j) => vectors.set(h, values[j]));
      embedded += values.length;
    }
    signal.throwIfAborted();
    if (!(await current())) return { embedded, reused: 0, stale: true };
    return this.serial(async () => {
      signal.throwIfAborted();
      if (!(await current())) return { embedded, reused: 0, stale: true };
      await this.db.exec("BEGIN");
      try {
        await this.db.run(
          "DELETE FROM chunks WHERE checkout=? AND path=?",
          checkout,
          file.path,
        );
        for (const h of missing)
          await this.db.run(
            "INSERT OR IGNORE INTO embeddings VALUES (?,vector32(?))",
            h,
            JSON.stringify(vectors.get(h)),
          );
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          await this.db.run(
            "INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,vector32(?))",
            digest(`${checkout}:${file.path}:${i}:${hash}`),
            checkout,
            repository,
            file.path,
            file.service,
            file.language,
            c.symbol,
            c.kind,
            c.startLine,
            c.endLine,
            c.parentStart,
            c.parentEnd,
            c.text,
            hash,
            JSON.stringify(vectors.get(hashes[i])),
          );
        }
        await this.db.run(
          "INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?)",
          checkout,
          file.path,
          hash,
          file.service,
          file.language,
          repository,
        );
        signal.throwIfAborted();
        await this.db.exec("COMMIT");
      } catch (e) {
        await this.db.exec("ROLLBACK");
        throw e;
      }
      return { embedded, reused: chunks.length - embedded };
    });
  }
  async search(
    query: string,
    vector: number[],
    filter: IndexFilter,
    limit = 30,
  ): Promise<IndexHit[]> {
    if (
      vector.length !== EMBEDDING_DIMENSIONS ||
      vector.some((n) => !Number.isFinite(n))
    )
      throw new Error("Query embedding does not match index.");
    const terms =
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu)
        ?.slice(0, 12) ?? [];
    const conditions: string[] = [],
      args: string[] = [];
    if (filter.checkout !== undefined) {
      conditions.push("checkout=?");
      args.push(filter.checkout);
    } else {
      conditions.push("checkout=?");
      args.push("");
    }
    if (filter.repository) {
      conditions.push("repository=?");
      args.push(filter.repository);
    }
    if (filter.service) {
      conditions.push("service=?");
      args.push(filter.service);
    }
    if (filter.language) {
      conditions.push("language=?");
      args.push(filter.language);
    }
    if (filter.scope && filter.scope !== ".") {
      const scope = filter.scope.replace(/\/$/, "");
      conditions.push("(path=? OR substr(path,1,?)=?)");
      args.push(scope, String(scope.length + 1), scope + "/");
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const columns =
      "id,checkout,repository,path,service,language,symbol,kind,startLine,endLine,parentStart,parentEnd,text,hash";
    return this.serial(async () => {
      const semantic = (await this.db.all(
        `SELECT ${columns}, vector_distance_cos(embedding,vector32(?)) AS distance FROM chunks${where} ORDER BY distance LIMIT ?`,
        JSON.stringify(vector),
        ...args,
        limit,
      )) as IndexHit[];
      const lexical = terms.length
        ? ((await this.db.all(
            `SELECT ${columns} FROM chunks${where}${where ? " AND " : " WHERE "} (${terms.map(() => "instr(lower(symbol || ' ' || path || ' ' || text),?)>0").join(" OR ")}) LIMIT 200`,
            ...args,
            ...terms,
          )) as IndexHit[])
        : [];
      const rank = (h: IndexHit) =>
        terms.reduce(
          (sum, t) =>
            sum +
            (h.symbol.toLowerCase().includes(t) ? 4 : 0) +
            (h.path.toLowerCase().includes(t) ? 2 : 0) +
            (h.text.toLowerCase().includes(t) ? 1 : 0),
          0,
        );
      lexical.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
      const merged = new Map<string, IndexHit>();
      for (const list of [semantic, lexical])
        list.forEach((h, i) => {
          const existing = merged.get(h.id);
          merged.set(h.id, {
            ...h,
            ...existing,
            score: (existing?.score ?? 0) + 1 / (60 + i + 1),
          });
        });
      return [...merged.values()]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    });
  }
  async pruneCache(): Promise<void> {
    // Cache remains useful across branch switches, but has a fixed maximum size.
    await this.serial(async () => {
      await this.db.exec(
        "DELETE FROM embeddings WHERE rowid NOT IN (SELECT rowid FROM embeddings ORDER BY rowid DESC LIMIT 100000)",
      );
    });
  }
  async close(): Promise<void> {
    await this.serial(() => this.db.close());
    if (this.lock) await rm(this.lock, { recursive: true, force: true });
  }
}
