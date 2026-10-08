import path from "node:path";
import { readFile, stat, realpath } from "node:fs/promises";
import { CodeIndex, type IndexFilter } from "./code-index.js";
import { isPrivatePath } from "./tool-policy.js";
import type { Embed } from "./embeddings.js";
import { digest } from "./code-chunks.js";
import { WorkspaceDiscovery, type DiscoveryRoot } from "./discovery.js";
import type { RootStatus, SharedRoot } from "./shared-index-protocol.js";
export const indexEligible = (file: string) =>
  /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|c|h|cpp|cs|rb|php|swift|sql|tf|hcl|yaml|yml|json|toml|md|mdx|sh|txt)$/.test(
    file,
  ) &&
  !/(?:^|\/)(?:package-lock\.json|yarn\.lock|poetry\.lock)|\.min\.[jt]s$|\.d\.ts$/.test(
    file,
  );
interface Entry {
  root: SharedRoot;
  clients: Map<string, string>;
  packages: Set<string>;
  status: RootStatus;
  rg: string;
  pending: Set<string>;
  full: boolean;
  job?: Promise<void>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
/** One saved-source scan per canonical checkout, shared by all connected windows. */
export class SharedIndexCoordinator {
  private roots = new Map<string, Entry>();
  private clients = new Map<string, Set<string>>();
  private closed = false;
  private active = 0;
  private registration: Promise<unknown> = Promise.resolve();
  constructor(
    private index: CodeIndex,
    private embedding: (checkout: string) => Embed,
    private changed: () => void,
  ) {}
  key(checkout: string) {
    return this.roots.get(checkout)?.clients.values().next().value;
  }
  register(
    client: string,
    roots: DiscoveryRoot[],
    key: string,
    rg: string,
    signal = new AbortController().signal,
  ): Promise<SharedRoot[]> {
    const next = this.registration.then(() =>
      this.registerRoots(client, roots, key, rg, signal),
    );
    this.registration = next.catch(() => {});
    return next;
  }
  private async registerRoots(
    client: string,
    roots: DiscoveryRoot[],
    key: string,
    rg: string,
    signal: AbortSignal,
  ): Promise<SharedRoot[]> {
    signal.throwIfAborted();
    if (
      roots.length > 64 ||
      roots.some(
        (r) =>
          !r ||
          typeof r.path !== "string" ||
          !path.isAbsolute(r.path) ||
          typeof r.name !== "string" ||
          r.name.length > 200,
      )
    )
      throw new Error("Invalid checkout registration.");
    const canonical: SharedRoot[] = [];
    for (const root of roots) {
      const resolved = await realpath(root.path);
      if (isPrivatePath(root.path) || isPrivatePath(resolved))
        throw new Error("Checkout is excluded from AI context.");
      if (!(await stat(resolved)).isDirectory())
        throw new Error("Checkout must be a directory.");
      signal.throwIfAborted();
      canonical.push({ name: root.name, path: resolved, checkout: resolved });
    }
    this.unregister(client);
    this.clients.set(client, new Set(canonical.map((r) => r.checkout)));
    for (const root of canonical) {
      let entry = this.roots.get(root.checkout);
      if (!entry) {
        const totals = await this.index.stats(root.checkout);
        signal.throwIfAborted();
        entry = {
          root,
          clients: new Map(),
          packages: new Set(),
          rg,
          pending: new Set(),
          full: true,
          status: {
            checkout: root.checkout,
            repository: root.name,
            state: "starting",
            ...totals,
            coverageKnown: true,
            embedded: 0,
            reused: 0,
            updatedAt: Date.now(),
          },
        };
        this.roots.set(root.checkout, entry);
      }
      const idle = !entry.clients.size;
      entry.clients.set(client, key);
      // Always revalidate source after an idle/restart; another window joining active work does not restart it.
      if (idle && !entry.job && !entry.timer) this.schedule(entry, true);
    }
    this.changed();
    return canonical;
  }
  unregister(client: string) {
    for (const checkout of this.clients.get(client) ?? []) {
      const entry = this.roots.get(checkout);
      if (!entry) continue;
      entry.clients.delete(client);
      if (!entry.clients.size) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.controller?.abort();
        entry.full = true;
      }
    }
    this.clients.delete(client);
  }
  private entry(client: string, checkout: string) {
    if (!this.clients.get(client)?.has(checkout))
      throw new Error("Checkout is not registered by this window.");
    const entry = this.roots.get(checkout);
    if (!entry) throw new Error("Checkout unavailable.");
    return entry;
  }
  statuses(client: string) {
    return [...(this.clients.get(client) ?? [])].map((c) => ({
      ...this.entry(client, c).status,
    }));
  }
  async scopes(client: string) {
    return Promise.all(
      [...(this.clients.get(client) ?? [])].map(async (c) => ({
        ...this.entry(client, c).root,
        ...(await this.index.stats(c)),
        services: await this.index.services(c),
      })),
    );
  }
  refresh(client: string, checkout: string, file?: string, full = false) {
    const entry = this.entry(client, checkout);
    if (file) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        throw new Error("Invalid changed path.");
      entry.pending.add(file);
    }
    // Policy/branch changes invalidate in-flight vectors immediately.
    if (full) entry.controller?.abort();
    this.schedule(entry, full);
  }
  async search(
    client: string,
    checkout: string,
    query: string,
    vector: number[],
    filter: IndexFilter,
    signal: AbortSignal,
  ) {
    this.entry(client, checkout);
    signal.throwIfAborted();
    const hits = await this.index.search(
      query,
      vector,
      { ...filter, checkout },
      40,
    );
    const valid = [];
    const entry = this.entry(client, checkout);
    for (const hit of hits) {
      signal.throwIfAborted();
      try {
        const source = await this.source(entry, hit.path, signal);
        if (source !== undefined && digest(source) === hit.hash)
          valid.push(hit);
        else this.refresh(client, checkout, hit.path);
      } catch {
        signal.throwIfAborted();
        await this.index.remove(hit.path, checkout);
      }
    }
    signal.throwIfAborted();
    this.entry(client, checkout);
    return valid;
  }
  private schedule(entry: Entry, full: boolean) {
    entry.full ||= full;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.start(entry);
    }, 250);
  }
  private publish(entry: Entry, state: string, error?: string) {
    entry.status = { ...entry.status, state, error, updatedAt: Date.now() };
    this.changed();
  }
  private start(entry: Entry) {
    if (this.closed || entry.job || !entry.clients.size) return;
    if (this.active >= 2) {
      this.schedule(entry, false);
      return;
    }
    this.active++;
    const controller = new AbortController();
    entry.controller = controller;
    entry.job = this.run(entry, controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) {
          entry.full = false;
          entry.pending.clear();
          this.publish(
            entry,
            "error",
            e instanceof Error ? e.message : "Code indexing failed.",
          );
        }
      })
      .finally(() => {
        this.active--;
        entry.job = undefined;
        entry.controller = undefined;
        if (
          !this.closed &&
          entry.clients.size &&
          (entry.full || entry.pending.size)
        )
          this.schedule(entry, false);
      });
  }
  private discovery(entry: Entry) {
    return new WorkspaceDiscovery([entry.root], entry.rg);
  }
  private service(entry: Entry, file: string) {
    const candidates = [...entry.packages]
      .filter((p) => p !== "." && (file === p || file.startsWith(p + "/")))
      .sort((a, b) => b.length - a.length);
    return (
      candidates[0] ??
      /^(?:services|packages|apps)\/[^/]+/.exec(file)?.[0] ??
      "."
    );
  }
  private async source(entry: Entry, file: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!entry.clients.size) throw new Error("Indexing is paused.");
    if (!indexEligible(file)) return undefined;
    const resolved = await this.discovery(entry).resolve(
      path.join(entry.root.path, file),
      signal,
    );
    if ((await stat(resolved)).size > 180000) return undefined;
    const text = await readFile(resolved, "utf8");
    signal.throwIfAborted();
    return Buffer.byteLength(text) > 180000 || text.includes("\0")
      ? undefined
      : text;
  }
  private async update(entry: Entry, file: string, signal: AbortSignal) {
    signal.throwIfAborted();
    entry.status.currentFile = file;
    this.publish(entry, entry.status.state);
    let text: string | undefined;
    try {
      text = await this.source(entry, file, signal);
    } catch {
      signal.throwIfAborted();
      await this.index.remove(file, entry.root.checkout);
      return;
    }
    if (text === undefined) {
      await this.index.remove(file, entry.root.checkout);
      return;
    }
    const hash = digest(text);
    const result = await this.index.update(
      {
        checkout: entry.root.checkout,
        repository: entry.root.name,
        path: file,
        text,
        language: path.extname(file).slice(1),
        service: this.service(entry, file),
      },
      signal,
      async () => {
        try {
          const current = await this.source(entry, file, signal);
          return current !== undefined && digest(current) === hash;
        } catch {
          return false;
        }
      },
      this.embedding(entry.root.checkout),
    );
    entry.status.embedded += result.embedded;
    entry.status.reused += result.reused;
    if (result.stale) entry.pending.add(file);
  }
  private async run(entry: Entry, signal: AbortSignal) {
    const full = entry.full;
    entry.full = false;
    entry.status = {
      ...entry.status,
      embedded: 0,
      reused: 0,
      processed: 0,
      total: undefined,
      currentFile: undefined,
    };
    this.publish(entry, full ? "scanning" : "updating");
    if (full) {
      const files = new Set<string>();
      entry.packages.clear();
      for await (const absolute of this.discovery(entry).walk(signal)) {
        const file = path
          .relative(entry.root.path, absolute)
          .split(path.sep)
          .join("/");
        if (
          /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(
            file,
          )
        )
          entry.packages.add(path.posix.dirname(file));
        if (indexEligible(file)) files.add(file);
      }
      for (const old of await this.index.paths(entry.root.checkout))
        if (!files.has(old)) await this.index.remove(old, entry.root.checkout);
      entry.status.total = files.size;
      this.publish(entry, "indexing");
      for (const file of files) {
        await this.update(entry, file, signal);
        entry.status.processed = (entry.status.processed ?? 0) + 1;
        this.publish(entry, "indexing");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await this.index.pruneCache();
    }
    while (entry.pending.size) {
      const file = entry.pending.values().next().value!;
      entry.pending.delete(file);
      await this.update(entry, file, signal);
    }
    signal.throwIfAborted();
    Object.assign(entry.status, await this.index.stats(entry.root.checkout), {
      coverageKnown: true,
      currentFile: undefined,
    });
    this.publish(entry, "ready");
  }
  // Embedding credentials are connection-scoped and never persisted by the service.
  async close() {
    this.closed = true;
    for (const e of this.roots.values()) {
      clearTimeout(e.timer);
      e.controller?.abort();
    }
    await Promise.all([...this.roots.values()].map((e) => e.job));
    await this.index.close();
  }
}
