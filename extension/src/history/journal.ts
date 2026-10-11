import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, lstat, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import { connect } from "@tursodatabase/database";

export interface KeyVault {
  get(name: string): PromiseLike<string | undefined>;
  store(name: string, value: string): PromiseLike<void>;
}
export interface HistoryRecord {
  id: string;
  replicaId: string;
  sequence: number;
  time: string;
  type: string;
  data: Record<string, unknown>;
  previous: string;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const keyName = (id: string) => `zen.history.v1.${id}`;
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(
      "History storage must be a private, non-symlink directory.",
    );
}
function seal(key: Buffer, aad: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function unseal(key: Buffer, aad: string, encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
/** Each editor session writes its own journal. Readers aggregate streams without a shared writer lock. */
export class HistoryJournal {
  private sequence = 0;
  private previous = "";
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private closed = false;
  private constructor(
    readonly id: string,
    readonly repositoryId: string,
    private db: Awaited<ReturnType<typeof connect>>,
    private key: Buffer,
  ) {}
  static async create(
    directory: string,
    repositoryId: string,
    vault: KeyVault,
  ): Promise<HistoryJournal> {
    await privateDirectory(directory);
    const id = randomUUID();
    const key = randomBytes(32);
    await vault.store(keyName(id), key.toString("hex"));
    if ((await vault.get(keyName(id))) !== key.toString("hex"))
      throw new Error("History encryption key could not be verified.");
    const file = path.join(directory, `${id}.db`);
    const db = await connect(file);
    try {
      await chmod(file, 0o600);
      await db.exec(
        "CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)",
      );
      return new HistoryJournal(id, repositoryId, db, key);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  get status(): { durable: number; error?: string } {
    return { durable: this.sequence, error: this.failure?.message };
  }
  append(type: string, data: Record<string, unknown>): Promise<HistoryRecord> {
    // Capture values at the event boundary, not later when the queue drains.
    const captured = JSON.parse(JSON.stringify(data)) as Record<
      string,
      unknown
    >;
    const id = randomUUID();
    const time = new Date().toISOString();
    const task = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error("History journal is closed.");
      const record: HistoryRecord = {
        id,
        time,
        type,
        data: captured,
        replicaId: this.id,
        sequence: this.sequence + 1,
        previous: this.previous,
      };
      const plain = JSON.stringify(record);
      if (Buffer.byteLength(plain) > 4 * 1024 * 1024)
        throw new Error(
          "History event exceeds the supported 4 MiB limit; recording has stopped.",
        );
      const body = seal(
        this.key,
        `${this.repositoryId}:${this.id}:${record.sequence}:${id}`,
        plain,
      );
      await this.db.run(
        "INSERT INTO events VALUES (?, ?, ?)",
        record.sequence,
        id,
        body,
      );
      this.sequence = record.sequence;
      this.previous = digest(plain);
      return record;
    });
    this.queue = task.catch((error: unknown) => {
      this.failure =
        error instanceof Error ? error : new Error("History recording failed.");
    });
    return task;
  }
  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    await this.db.close();
    this.key.fill(0);
  }
  static async read(
    directory: string,
    repositoryId: string,
    vault: KeyVault,
  ): Promise<HistoryRecord[]> {
    await privateDirectory(directory);
    const records: HistoryRecord[] = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[\da-f-]{36}\.db$/.test(name)) continue;
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("Unsafe history journal file.");
      const id = name.slice(0, -3);
      const secret = await vault.get(keyName(id));
      if (!secret || !/^[\da-f]{64}$/.test(secret))
        throw new Error("A history encryption key is unavailable.");
      const key = Buffer.from(secret, "hex");
      const db = await connect(file, { readonly: true, fileMustExist: true });
      try {
        let sequence = 0,
          previous = "";
        for (const row of await db.all(
          "SELECT sequence, id, body FROM events ORDER BY sequence",
        )) {
          const plain = unseal(
            key,
            `${repositoryId}:${id}:${row.sequence}:${row.id}`,
            String(row.body),
          );
          const record = JSON.parse(plain) as HistoryRecord;
          if (
            record.sequence !== ++sequence ||
            record.id !== row.id ||
            record.replicaId !== id ||
            record.previous !== previous
          )
            throw new Error("History journal integrity check failed.");
          previous = digest(plain);
          records.push(record);
        }
      } finally {
        key.fill(0);
        await db.close();
      }
    }
    // Wall-clock order is for display only, not causality between writers.
    return records.sort(
      (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
    );
  }
}
