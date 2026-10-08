import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";

export const memoryHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface MemorySource {
  path: string;
  hash: string;
}
export interface MemoryRecord {
  id: string;
  document: string;
  bank: string;
  key: string;
  scope: string;
  kind: "preference" | "familiarity" | "project";
  text: string;
  evidence: string;
  sources: MemorySource[];
  updated: string;
}
export interface MemoryJob {
  id: string;
  action: "retain" | "delete";
  bank: string;
  document: string;
  record?: MemoryRecord;
  submitted?: boolean;
}
interface State {
  version: 1;
  owner: string;
  records: MemoryRecord[];
  jobs: MemoryJob[];
  blocked: string[];
  forgottenEvidence: string[];
}
/** Reject likely secrets, rather than storing a partly redacted preference. */
export function memoryText(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Memory text is missing or too long.");
  if (
    /\b(?:sk-|csk-|gsk_|fc-)[\w-]{12,}|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/i.test(
      value,
    )
  )
    throw new Error("Credential-like text cannot be retained in memory.");
  return value.trim();
}
/** One process owns the journal. Other windows fail closed instead of racing writes. */
export class MemoryStore {
  private state!: State;
  private durable?: State;
  private file: string;
  private lock: string;
  private closed = false;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.file = path.join(directory, "memory-v1.json");
    this.lock = path.join(directory, "owner.lock");
    try {
      this.acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = this.lock + ".recovery";
      // Serialize stale-owner recovery: two openers must not unlink each other's lock.
      try {
        mkdirSync(recovery, { mode: 0o700 });
      } catch {
        throw new Error(
          "Memory owner recovery is busy; retry opening this window.",
        );
      }
      try {
        let pid: number;
        try {
          pid = Number(readFileSync(this.lock, "utf8"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          this.acquire();
          this.load();
          return;
        }
        if (!Number.isInteger(pid) || pid < 1)
          throw new Error("Memory lock needs inspection.");
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          unlinkSync(this.lock);
          this.acquire();
          this.load();
          return;
        }
      } finally {
        rmdirSync(recovery);
      }
      throw new Error(
        "Memory is owned by another Zen window. Close that window before reopening this one.",
      );
    }
    this.load();
  }
  private acquire() {
    const fd = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  }
  private load(): void {
    try {
      try {
        this.state = JSON.parse(readFileSync(this.file, "utf8")) as State;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        this.state = {
          version: 1,
          owner: randomUUID(),
          records: [],
          jobs: [],
          blocked: [],
          forgottenEvidence: [],
        };
      }
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.records) ||
        !Array.isArray(this.state.jobs)
      )
        throw new Error("Unsupported memory journal; preserved for recovery.");
      this.save();
    } catch (e) {
      unlinkSync(this.lock);
      throw e;
    }
  }
  private save() {
    if (this.closed) throw new Error("Memory store is closed.");
    const temp = this.file + ".tmp";
    try {
      const fd = openSync(temp, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(this.state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
      this.durable = structuredClone(this.state);
    } catch (e) {
      if (this.durable) this.state = structuredClone(this.durable);
      throw e;
    }
  }

  list(scope?: string): MemoryRecord[] {
    return structuredClone(
      this.state.records.filter(
        (r) =>
          scope === undefined || r.scope === "personal" || r.scope === scope,
      ),
    );
  }
  remember(
    input: Omit<MemoryRecord, "id" | "document" | "bank" | "updated">,
    manual = false,
  ): MemoryRecord {
    const key = memoryText(input.key, 100).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(key))
      throw new Error("Use a short stable memory key.");
    const text = memoryText(input.text),
      evidence = memoryText(input.evidence, 2000);
    const id = memoryHash(input.scope + ":" + key);
    if (
      !manual &&
      (this.state.blocked.includes(id) ||
        this.state.forgottenEvidence.includes(memoryHash(evidence)))
    )
      throw new Error(
        "This memory was forgotten; only the user can restore it through Manage Memory.",
      );
    const previous = this.state.records.find((r) => r.id === id);
    if (
      previous?.text === text &&
      JSON.stringify(previous.sources) === JSON.stringify(input.sources)
    )
      return structuredClone(previous);
    if (!previous && this.state.records.length >= 2000)
      throw new Error("Memory is full. Review records with Manage Memory.");
    if (this.state.jobs.length > 4000)
      throw new Error(
        "Memory indexing backlog is full. Retry or disconnect Hindsight before retaining more.",
      );
    const record: MemoryRecord = {
      ...input,
      key,
      text,
      evidence,
      id,
      document: randomUUID(),
      bank: "zen-" + memoryHash(this.state.owner + input.scope).slice(0, 32),
      updated: new Date().toISOString(),
    };
    if (previous) this.remove(previous, false);
    this.state.records.push(record);
    this.state.jobs.push({
      id: randomUUID(),
      action: "retain",
      bank: record.bank,
      document: record.document,
      record,
    });
    this.save();
    return structuredClone(record);
  }
  private remove(record: MemoryRecord, block: boolean) {
    this.state.records = this.state.records.filter((r) => r.id !== record.id);
    // Remove unsubmitted work; a submitted operation must finish before its deletion.
    this.state.jobs = this.state.jobs.filter(
      (j) => j.document !== record.document || j.submitted,
    );
    this.state.jobs.push({
      id: randomUUID(),
      action: "delete",
      bank: record.bank,
      document: record.document,
    });
    if (block) {
      if (!this.state.blocked.includes(record.id))
        this.state.blocked.push(record.id);
      this.state.forgottenEvidence.push(memoryHash(record.evidence));
    }
  }
  forget(id: string) {
    const record = this.state.records.find((r) => r.id === id);
    if (!record) return;
    this.remove(record, true);
    this.save();
  }
  jobs(): MemoryJob[] {
    return structuredClone(this.state.jobs);
  }
  submitted(id: string) {
    const j = this.state.jobs.find((j) => j.id === id);
    if (j) {
      j.submitted = true;
      this.save();
    }
  }
  done(id: string) {
    this.state.jobs = this.state.jobs.filter((j) => j.id !== id);
    this.save();
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      unlinkSync(this.lock);
    }
  }
}

export function rankMemories(
  records: MemoryRecord[],
  query: string,
  preferred: string[] = [],
): MemoryRecord[] {
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
  const score = (r: MemoryRecord) =>
    [...words].filter((w) => `${r.key} ${r.text}`.toLowerCase().includes(w))
      .length *
      3 +
    (r.kind === "preference" ? 1 : 0) +
    (preferred.includes(r.document) ? 5 : 0);
  return records
    .filter((r) => score(r) > 0)
    .sort((a, b) => score(b) - score(a) || b.updated.localeCompare(a.updated))
    .slice(0, 8);
}
