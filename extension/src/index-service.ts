import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { type IndexHit } from "./code-index.js";
import { CodeChunker, digest } from "./code-chunks.js";
import { openAIEmbed, type Embed } from "./embeddings.js";
import { WorkspaceDiscovery, type DiscoveryRoot } from "./discovery.js";
import type { BackendTool } from "./backend.js";
import { voiceContent } from "./live-protocol.js";
import { SharedIndexClient } from "./shared-index-client.js";
import { type RootStatus } from "./shared-index-protocol.js";
import { indexEligible as eligible } from "./shared-index-coordinator.js";
import { retireLegacyIndexes } from "./index-migration.js";
const policyFile = (f: string) =>
  /(?:^|[\\/])(?:\.gitignore|\.pairignore|\.ignore|HEAD|index|exclude|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(
    f,
  );
interface RootIndex {
  root: DiscoveryRoot;
  checkout: string;
  packages: Set<string>;
}
export interface IndexStatus {
  state: string;
  files: number;
  chunks?: number;
  coverageKnown?: boolean;
  embedded: number;
  reused: number;
  error?: string;
  processed?: number;
  total?: number;
  repository?: string;
  currentFile?: string;
  updatedAt?: number;
  shared?: boolean;
  migrationDeferred?: boolean;
}
/** Window-local policy and dirty-buffer overlays; the daemon owns saved indexing. */
export class IndexService implements vscode.Disposable {
  private roots = new Map<string, RootIndex>();
  private pending = new Set<string>();
  private full = true;
  private timer?: ReturnType<typeof setTimeout>;
  private job?: Promise<void>;
  private lifetime = new AbortController();
  private disposables: vscode.Disposable[] = [];
  private embed: Embed;
  private chunker: CodeChunker;
  private queryCache = new Map<string, number[]>();
  private client: SharedIndexClient;
  private disposed = false;
  status: IndexStatus = {
    state: "starting",
    files: 0,
    embedded: 0,
    reused: 0,
    shared: true,
  };
  constructor(
    private context: vscode.ExtensionContext,
    private key: () => Promise<string | undefined>,
    private enabled: () => boolean,
    private changed: (status: IndexStatus) => void,
    options: { directory?: string; start?: () => Promise<void> } = {},
  ) {
    this.embed = openAIEmbed(key);
    this.chunker = new CodeChunker(
      path.join(context.extensionPath, "dist/grammars"),
    );
    this.client = new SharedIndexClient({
      directory: options.directory,
      daemonPath: path.join(
        context.extensionPath,
        "dist/shared-index-daemon.cjs",
      ),
      start: options.start,
      changed: (roots) => this.receiveStatus(roots),
      disconnected: () => {
        if (!this.disposed) {
          this.status.coverageKnown = false;
          this.publish("connecting");
        }
      },
    });
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const event = (uri: vscode.Uri) => {
      if (
        uri.scheme === "file" &&
        (eligible(uri.fsPath) || policyFile(uri.fsPath))
      )
        this.schedule(uri.fsPath, policyFile(uri.fsPath));
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(event),
      watcher.onDidChange(event),
      watcher.onDidDelete(event),
      vscode.workspace.onDidCloseTextDocument((d) => event(d.uri)),
      vscode.workspace.onDidSaveTextDocument((d) => event(d.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("pairCode.indexEnabled") ||
          e.affectsConfiguration("pairCode.shareEditorContext")
        )
          this.refresh();
      }),
    );
    this.schedule(undefined, true);
  }
  private publish(state: string, error?: string) {
    this.status = { ...this.status, state, error, updatedAt: Date.now() };
    this.changed(this.status);
  }
  private receiveStatus(roots: RootStatus[]) {
    if (this.disposed || !this.enabled() || !vscode.workspace.isTrusted) return;
    const allowed = roots.filter((r) => this.roots.has(r.checkout));
    if (!allowed.length) return;
    const active =
      allowed.find((r) =>
        ["scanning", "indexing", "updating", "starting"].includes(r.state),
      ) ??
      allowed.find((r) => r.state === "error") ??
      allowed[0];
    this.status = {
      ...this.status,
      shared: true,
      files: allowed.reduce((n, r) => n + r.files, 0),
      chunks: allowed.reduce((n, r) => n + r.chunks, 0),
      coverageKnown: allowed.every((r) => r.coverageKnown),
      embedded: allowed.reduce((n, r) => n + r.embedded, 0),
      reused: allowed.reduce((n, r) => n + r.reused, 0),
      processed: active.processed,
      total: active.total,
      repository: active.repository,
      currentFile: active.currentFile,
    };
    this.publish(active.state, active.error);
  }
  private guard() {
    if (!this.enabled() || !vscode.workspace.isTrusted)
      throw new Error("Code indexing/context sharing is disabled.");
  }
  private rg() {
    const binary = path.join(
      vscode.env.appRoot,
      "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    return existsSync(binary) ? binary : "rg";
  }
  private discovery(root: DiscoveryRoot) {
    return new WorkspaceDiscovery([root], this.rg());
  }
  private schedule(file?: string, full = false) {
    if (this.disposed) return;
    if (file) this.pending.add(file);
    this.full ||= full;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), 300);
  }
  refresh() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.queryCache.clear();
    this.full = true;
    if (!this.enabled() || !vscode.workspace.isTrusted) {
      void this.client.register([], "", this.rg()).catch(() => {});
      this.roots.clear();
      this.publish(!this.enabled() ? "paused" : "untrusted");
      return;
    }
    this.schedule(undefined, true);
  }
  private start() {
    if (this.disposed || this.job) return;
    if (!this.enabled() || !vscode.workspace.isTrusted) {
      this.publish(!this.enabled() ? "paused" : "untrusted");
      return;
    }
    const signal = this.lifetime.signal;
    this.job = this.sync(signal)
      .catch((e) => {
        if (!signal.aborted)
          this.publish(
            "error",
            e instanceof Error ? e.message : "Shared index failed.",
          );
      })
      .finally(() => {
        this.job = undefined;
        if (!this.disposed && (this.full || this.pending.size)) this.schedule();
      });
  }
  private async sync(signal: AbortSignal) {
    this.guard();
    signal.throwIfAborted();
    if (this.full || !this.roots.size) {
      this.full = false;
      this.publish("connecting");
      const migration = await retireLegacyIndexes(
        this.context.globalStorageUri.fsPath,
      );
      this.status.migrationDeferred = migration.deferred;
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(
        (f) => f.uri.scheme === "file",
      );
      const key = await this.key();
      signal.throwIfAborted();
      this.guard();
      const registered = await this.client.register(
        folders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
        key ?? "",
        this.rg(),
      );
      if (signal.aborted || !this.enabled() || !vscode.workspace.isTrusted) {
        await this.client.register([], "", this.rg());
        signal.throwIfAborted();
        this.guard();
      }
      this.roots.clear();
      for (let i = 0; i < registered.length; i++) {
        const root = registered[i];
        this.roots.set(root.checkout, {
          root: { name: root.name, path: folders[i].uri.fsPath },
          checkout: root.checkout,
          packages: new Set(),
        });
      }
    }
    for (const file of [...this.pending]) {
      this.pending.delete(file);
      const entry = this.rootFor(file);
      if (entry)
        await this.client.refresh(
          entry.checkout,
          path.relative(entry.root.path, file).split(path.sep).join("/"),
          policyFile(file),
        );
    }
    const result = await this.client.status();
    this.guard();
    signal.throwIfAborted();
    for (const scope of result.scopes) {
      const entry = this.roots.get(scope.checkout);
      if (entry) entry.packages = new Set(scope.services);
    }
    if (!result.roots.length) {
      this.status = {
        ...this.status,
        files: 0,
        chunks: 0,
        coverageKnown: true,
      };
      this.publish("ready");
    } else this.receiveStatus(result.roots);
  }
  private service(entry: RootIndex, file: string) {
    const rel = path.relative(entry.root.path, file).split(path.sep).join("/");
    const candidates = [...entry.packages]
      .filter((p) => p !== "." && (rel === p || rel.startsWith(p + "/")))
      .sort((a, b) => b.length - a.length);
    return (
      candidates[0] ??
      /^(?:services|packages|apps)\/[^/]+/.exec(rel)?.[0] ??
      "."
    );
  }
  private async source(
    entry: RootIndex,
    file: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    this.guard();
    signal.throwIfAborted();
    if (!eligible(file)) return undefined;
    const resolved = await this.discovery(entry.root).resolve(file, signal);
    const document = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === resolved,
    );
    let text: string;
    if (document) text = document.getText();
    else {
      if ((await stat(resolved)).size > 180000) return undefined;
      text = await readFile(resolved, "utf8");
    }
    this.guard();
    signal.throwIfAborted();
    if (Buffer.byteLength(text) > 180000 || text.includes("\0"))
      return undefined;
    return text;
  }
  private rootFor(file: string) {
    return [...this.roots.values()]
      .filter((e) => {
        const r = path.relative(e.root.path, file);
        return (
          r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)
        );
      })
      .sort((a, b) => b.root.path.length - a.root.path.length)[0];
  }
  tools(): BackendTool[] {
    const string = { type: "string" };
    return [
      {
        name: "search_code",
        description:
          "Search local indexed code by meaning plus exact words. Filters checkout (canonical absolute root path), repository (workspace root name), service (relative directory e.g. services/copilot), directory scope, and language (extension e.g. py). Defaults across open repositories; explicitly broaden service for caller/impact questions. Results include parent ranges and fresh source hashes. Index coverage may be incomplete; use search_text/read_files/symbol_usages for verification. Does not search the web.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: string,
            repository: string,
            checkout: string,
            service: string,
            scope: string,
            language: string,
            limit: { type: "integer", minimum: 1, maximum: 12 },
          },
          required: ["query"],
        },
        execute: async (args, signal) => this.search(args, signal),
      },
      {
        name: "index_status",
        description:
          "Read local code indexing state and available repository/service scopes; no source content.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          this.guard();
          return {
            ...this.status,
            repositories: (await this.client.status()).scopes.map((scope) => ({
              repository: scope.name,
              checkout: scope.checkout,
              files: scope.files,
              chunks: scope.chunks,
              services: scope.services,
            })),
            coverage:
              "Only permitted text sources; ignored/generated/oversized files are excluded. Semantic matches are not exhaustive callers.",
          };
        },
      },
    ];
  }
  async search(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.guard();
    const s = AbortSignal.any([signal, this.lifetime.signal]);
    s.throwIfAborted();
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > 1500)
      throw new Error("Provide a code search question up to 1500 characters.");
    for (const name of [
      "repository",
      "checkout",
      "service",
      "scope",
      "language",
    ])
      if (
        args[name] !== undefined &&
        (typeof args[name] !== "string" || String(args[name]).length > 2000)
      )
        throw new Error(`Invalid ${name} filter.`);
    const limit = Number(args.limit ?? 8);
    if (!Number.isInteger(limit) || limit < 1 || limit > 12)
      throw new Error("Search limit must be 1–12.");
    const scope = (args.scope as string | undefined)
      ?.replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    const scopedRoot = [...this.roots.values()].find(
      (e) => scope === e.root.name || scope?.startsWith(e.root.name + "/"),
    );
    const filter = {
      service: args.service as string | undefined,
      scope: scopedRoot
        ? scope!.slice(scopedRoot.root.name.length + 1) || "."
        : scope,
      language: args.language as string | undefined,
    };
    const entries = [...this.roots.values()].filter(
      (e) =>
        (!args.repository || e.root.name === args.repository) &&
        (!args.checkout || e.checkout === args.checkout) &&
        (!scopedRoot || e === scopedRoot),
    );
    if (!entries.length)
      return {
        matches: [],
        status: this.status,
        coverage:
          "Index is starting, disabled or the repository name did not match. Use workspace_overview/search_text meanwhile.",
      };
    let vector = this.queryCache.get(query);
    if (!vector) {
      [vector] = await this.embed([query], s);
      this.guard();
      this.queryCache.set(query, vector);
      if (this.queryCache.size > 100)
        this.queryCache.delete(this.queryCache.keys().next().value!);
    }
    const hits: { entry: RootIndex; hit: IndexHit }[] = [];
    for (const entry of entries) {
      const rows = await this.client.search(
        entry.checkout,
        query,
        vector,
        filter,
        s,
      );
      for (const hit of rows) hits.push({ entry, hit });
    }
    hits.sort((a, b) => (b.hit.score ?? 0) - (a.hit.score ?? 0));
    const matches: unknown[] = [];
    let skipped = 0;
    for (const { entry, hit } of hits) {
      s.throwIfAborted();
      let source: string | undefined;
      try {
        source = await this.source(
          entry,
          path.join(entry.root.path, hit.path),
          s,
        );
      } catch {
        s.throwIfAborted();
        this.guard();
        skipped++;
        continue;
      }
      if (source === undefined || digest(source) !== hit.hash) {
        skipped++;
        this.schedule(path.join(entry.root.path, hit.path));
        continue;
      }
      matches.push({
        ...hit,
        repository: entry.root.name,
        checkout: entry.checkout,
        text: voiceContent(hit.text, 1600),
        id: undefined,
        distance: undefined,
        score: undefined,
        path: this.roots.size > 1 ? entry.root.name + "/" + hit.path : hit.path,
      });
      if (matches.length >= limit) break;
    }
    // Fresh dirty buffers take precedence immediately while background vectors catch up.
    for (const document of vscode.workspace.textDocuments.filter(
      (d) => d.isDirty && d.uri.scheme === "file",
    )) {
      const entry = this.rootFor(document.uri.fsPath);
      if (!entry || !entries.includes(entry)) continue;
      const relative = path
        .relative(entry.root.path, document.uri.fsPath)
        .split(path.sep)
        .join("/");
      if (
        filter.service &&
        this.service(entry, document.uri.fsPath) !== filter.service
      )
        continue;
      if (
        filter.scope &&
        filter.scope !== "." &&
        relative !== filter.scope &&
        !relative.startsWith(filter.scope.replace(/\/$/, "") + "/")
      )
        continue;
      if (
        filter.language &&
        path.extname(relative).slice(1) !== filter.language
      )
        continue;
      let source: string | undefined;
      try {
        source = await this.source(entry, document.uri.fsPath, s);
      } catch {
        continue;
      }
      if (source === undefined) continue;
      const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
      const chunks = await this.chunker.chunks(relative, source);
      const selected = chunks
        .map((c) => ({
          c,
          score: terms.filter((t) =>
            (c.symbol + " " + c.text).toLowerCase().includes(t),
          ).length,
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      for (const { c } of selected)
        matches.unshift({
          repository: entry.root.name,
          checkout: entry.checkout,
          path:
            this.roots.size > 1 ? entry.root.name + "/" + relative : relative,
          ...c,
          text: voiceContent(c.text, 1600),
          header: undefined,
          unsaved: true,
          version: document.version,
          hash: digest(source),
        });
    }
    this.guard();
    s.throwIfAborted();
    const unique = new Map<string, unknown>();
    for (const match of matches) {
      const m = match as { checkout: string; path: string; startLine: number };
      const k = m.checkout + ":" + m.path + ":" + m.startLine;
      if (!unique.has(k)) unique.set(k, match);
    }
    return {
      matches: [...unique.values()].slice(0, limit),
      status: this.status.state,
      skippedStale: skipped,
      coverage:
        "Ranked excerpts of currently indexed sources, not an exhaustive dependency graph. Dirty buffers override stale disk results; snippets may be truncated. Use parentStart/parentEnd with read_file to expand, and symbol_usages/search_text for callers.",
    };
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.lifetime.abort();
    this.disposables.forEach((d) => d.dispose());
    this.client.close();
    await this.job;
    this.roots.clear();
  }
}
