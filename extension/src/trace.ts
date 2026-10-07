import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export interface TraceEvent {
  type: string;
  [key: string]: unknown;
}
export function redactTrace(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .slice(0, 12000)
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-|csk-|gsk_|fc-)[A-Za-z0-9_-]{12,}/g, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 100).map(redactTrace);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(authorization|apiKey|api_key|token|reasoning|reasoning_content)$/i.test(
              key,
            ),
        )
        .map(([key, data]) => [key, redactTrace(data)]),
    );
  return value;
}
/** Local debugging only: no credentials, source snapshots, or private reasoning. */
export class TraceJournal {
  readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private bytes = 0;
  private initialized = false;
  constructor(
    folder: string,
    private enabled: () => boolean,
    private onError: () => void = () => {},
  ) {
    this.file = path.join(
      folder,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`,
    );
  }
  record(event: TraceEvent): void {
    if (!this.enabled() || this.bytes > 5_000_000) return;
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        ...(redactTrace(event) as object),
      }) + "\n";
    this.bytes += Buffer.byteLength(line);
    this.queue = this.queue
      .then(async () => {
        if (!this.initialized) {
          await mkdir(path.dirname(this.file), {
            recursive: true,
            mode: 0o700,
          });
          this.initialized = true;
        }
        await appendFile(this.file, line, { mode: 0o600 });
      })
      .catch(() => this.onError());
  }
  async flush(): Promise<void> {
    await this.queue;
  }
}
