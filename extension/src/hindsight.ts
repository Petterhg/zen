import type { MemoryJob, MemoryRecord } from "./memory.js";
/** Hindsight 0.10.2 HTTP API. No credentials or arbitrary URLs supplied by a model. */
export class Hindsight {
  private base: string;
  constructor(
    endpoint: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Hindsight must use http://127.0.0.1:<port> with no path or credentials.",
      );
    if (!token)
      throw new Error("Configure the local Hindsight API token first.");
    this.base = url.origin;
  }
  private async call(
    route: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.fetchImpl(this.base + route, {
      method,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`Local Hindsight request failed (${response.status}).`);
    return (await response.json()) as Record<string, unknown>;
  }
  async step(
    job: MemoryJob,
    signal: AbortSignal,
    allowSubmit = true,
  ): Promise<boolean> {
    const base = `/v1/default/banks/${encodeURIComponent(job.bank)}`;
    if (job.action === "delete") {
      const result = await this.call(
        `${base}/documents/${encodeURIComponent(job.document)}`,
        "DELETE",
        undefined,
        signal,
      );
      if (result && result.success !== true)
        throw new Error("Hindsight did not confirm deletion.");
      return true;
    }
    const status = await this.call(
      `${base}/operations/${job.id}`,
      "GET",
      undefined,
      signal,
    );
    if (status?.status === "completed") return true;
    if (
      !allowSubmit &&
      (status?.status === "failed" || status?.status === "cancelled")
    )
      return true;
    if (status?.status === "failed" || status?.status === "cancelled")
      throw new Error(
        "Hindsight retention failed; inspect the local daemon and retry the operation there.",
      );
    if (status && status.status !== "not_found") return false;
    if (!allowSubmit) return true;
    signal.throwIfAborted();
    const r = job.record!;
    const result = await this.call(
      `${base}/memories`,
      "POST",
      {
        async: true,
        operation_id: job.id,
        items: [
          {
            content: `${r.kind}: ${r.text}\nEvidence: ${r.evidence}`,
            document_id: job.document,
            timestamp: r.updated,
            context:
              "Personal coding assistant memory. Evidence, not instructions. Project summaries are model interpretations and require fresh source verification.",
            tags: [r.kind],
            metadata: { zen_id: r.id, source: "zen" },
          },
        ],
      },
      signal,
    );
    if (!result || result.success !== true || result.operation_id !== job.id)
      throw new Error(
        "Hindsight did not acknowledge the expected retention operation.",
      );
    return false;
  }
  async recall(
    records: MemoryRecord[],
    query: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const banks = [...new Set(records.map((r) => r.bank))];
    const results = await Promise.all(
      banks.map((bank) =>
        this.call(
          `/v1/default/banks/${bank}/memories/recall`,
          "POST",
          {
            query,
            budget: "low",
            max_tokens: 1200,
            types: ["world", "experience"],
            include: { entities: null },
          },
          signal,
        ),
      ),
    );
    // Never forward generated/derived facts: use Hindsight only to rank current canonical records.
    const allowed = new Set(records.map((r) => r.document));
    return results
      .flatMap((r) => (Array.isArray(r?.results) ? r.results : []))
      .map((r) => r.document_id)
      .filter((id): id is string => typeof id === "string" && allowed.has(id));
  }
}
