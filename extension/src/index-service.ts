import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { CodeIndex, type IndexHit } from "./code-index.js";
import { CodeChunker, digest } from "./code-chunks.js";
import { openAIEmbed, type Embed } from "./embeddings.js";
import { WorkspaceDiscovery, type DiscoveryRoot } from "./discovery.js";
import type { BackendTool } from "./backend.js";
import { voiceContent } from "./live-protocol.js";
const eligible = (f: string) =>
  /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|c|h|cpp|cs|rb|php|swift|sql|tf|hcl|yaml|yml|json|toml|md|mdx|sh|txt)$/.test(
    f,
  ) &&
  !/(?:^|\/)(?:package-lock\.json|yarn\.lock|poetry\.lock)|\.min\.[jt]s$|\.d\.ts$/.test(
    f,
  );
const policyFile = (f: string) =>
  /(?:^|[\\/])(?:\.gitignore|\.pairignore|\.ignore|HEAD|index|exclude|package\.json|pyproject\.toml|Cargo\.toml)$/.test(
    f,
  );
interface RootIndex {
  root: DiscoveryRoot;
  index: Promise<CodeIndex>;
  packages: Set<string>;
}
export interface IndexStatus {
  state: string;
  files: number;
  embedded: number;
  reused: number;
  error?: string;
}
/** Coordinates background indexing only. Retrieval never waits for a complete repository scan. */
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
  status: IndexStatus = { state: "starting", files: 0, embedded: 0, reused: 0 };
  constructor(
    private context: vscode.ExtensionContext,
    key: () => Promise<string | undefined>,
    private enabled: () => boolean,
    private changed: (status: IndexStatus) => void,
  ) {
    this.embed = openAIEmbed(key);
    this.chunker = new CodeChunker(
      path.join(context.extensionPath, "dist/grammars"),
    );
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
      vscode.workspace.onDidChangeTextDocument((e) => event(e.document.uri)),
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
    this.status = { ...this.status, state, error };
    this.changed(this.status);
  }
  private guard() {
    if (!this.enabled() || !vscode.workspace.isTrusted)
      throw new Error("Code indexing/context sharing is disabled.");
  }
  private discovery(root: DiscoveryRoot) {
    const rg = path.join(
      vscode.env.appRoot,
      "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    return new WorkspaceDiscovery([root], existsSync(rg) ? rg : "rg");
  }
  private schedule(file?: string, full = false) {
    if (file) this.pending.add(file);
    this.full ||= full;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), 1300);
  }
  refresh(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.queryCache.clear();
    this.schedule(undefined, true);
    if (!this.enabled()) this.publish("paused");
  }
  private start() {
    if (this.job || !this.enabled() || !vscode.workspace.isTrusted) {
      if (!this.enabled()) this.publish("paused");
      return;
    }
    const signal = this.lifetime.signal;
    this.job = this.run(signal)
      .catch((e) => {
        if (!signal.aborted) {
          this.full = false;
          this.pending.clear();
          this.publish(
            "error",
            e instanceof Error ? e.message : "Code indexing failed.",
          );
        }
      })
      .finally(() => {
        this.job = undefined;
        if (!this.lifetime.signal.aborted && (this.full || this.pending.size))
          this.schedule();
      });
  }
  private async initialize() {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === "file",
    );
    for (const [root, entry] of this.roots)
      if (!folders.some((f) => f.uri.fsPath === root)) {
        await (await entry.index).close();
        this.roots.delete(root);
      }
    for (const f of folders)
      if (!this.roots.has(f.uri.fsPath)) {
        const root = { name: f.name, path: f.uri.fsPath };
        const index = CodeIndex.open(
          path.join(
            this.context.globalStorageUri.fsPath,
            "indexes",
            digest(root.path),
          ),
          this.embed,
          this.chunker,
        );
        this.roots.set(root.path, { root, index, packages: new Set() });
        try {
          await index;
        } catch (e) {
          this.roots.delete(root.path);
          throw e;
        }
      }
  }
  private service(entry: RootIndex, file: string): string {
    const rel = path.relative(entry.root.path, file).split(path.sep).join("/");
    const conventional = /^(?:services|packages|apps)\/[^/]+/.exec(rel)?.[0];
    const candidates = [...entry.packages]
      .filter((p) => p !== "." && (rel === p || rel.startsWith(p + "/")))
      .sort((a, b) => b.length - a.length);
    return candidates[0] ?? conventional ?? ".";
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
  private async update(entry: RootIndex, file: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const index = await entry.index;
    const relative = path
      .relative(entry.root.path, file)
      .split(path.sep)
      .join("/");
    let text: string | undefined;
    try {
      text = await this.source(entry, file, signal);
    } catch {
      signal.throwIfAborted();
      this.guard();
      await index.remove(relative);
      return;
    }
    if (text === undefined) {
      await index.remove(relative);
      return;
    }
    const hash = digest(text);
    const result = await index.update(
      {
        path: relative,
        text,
        service: this.service(entry, file),
        language: path.extname(file).slice(1),
      },
      signal,
      async () => {
        try {
          const latest = await this.source(entry, file, signal);
          return latest !== undefined && digest(latest) === hash;
        } catch {
          return false;
        }
      },
    );
    this.status.embedded += result.embedded;
    this.status.reused += result.reused;
    if (result.stale) this.pending.add(file);
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
  private async drain(signal: AbortSignal) {
    for (const file of [...this.pending].slice(0, 16)) {
      this.pending.delete(file);
      const entry = this.rootFor(file);
      if (entry) await this.update(entry, file, signal);
    }
  }
  private async run(signal: AbortSignal) {
    this.guard();
    await this.initialize();
    signal.throwIfAborted();
    this.publish("indexing");
    const full = this.full;
    this.full = false;
    if (full)
      for (const entry of this.roots.values()) {
        const discovered = new Set<string>();
        entry.packages.clear();
        for await (const file of this.discovery(entry.root).walk(signal)) {
          if (
            /\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(file)
          )
            entry.packages.add(
              path
                .relative(entry.root.path, path.dirname(file))
                .split(path.sep)
                .join("/") || ".",
            );
          if (eligible(file)) discovered.add(file);
        }
        const index = await entry.index;
        for (const previous of await index.paths())
          if (!discovered.has(path.join(entry.root.path, previous)))
            await index.remove(previous);
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        const files = [...discovered].sort(
          (a, b) => Number(b === active) - Number(a === active),
        );
        let done = 0;
        for (const file of files) {
          signal.throwIfAborted();
          await this.drain(signal);
          await this.update(entry, file, signal);
          if (++done % 10 === 0) this.publish("indexing");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await index.pruneCache();
      }
    while (this.pending.size) {
      signal.throwIfAborted();
      await this.drain(signal);
    }
    this.status.files = 0;
    for (const entry of this.roots.values())
      this.status.files += (await (await entry.index).paths()).length;
    this.publish("ready");
  }
  tools(): BackendTool[] {
    const string = { type: "string" };
    return [
      {
        name: "search_code",
        description:
          "Search local indexed code by meaning plus exact words. Filters repository (workspace root name), service (relative directory e.g. services/copilot), directory scope, and language (extension e.g. py). Defaults across open repositories; explicitly broaden service for caller/impact questions. Results include parent ranges and fresh source hashes. Index coverage may be incomplete; use search_text/read_files/symbol_usages for verification. Does not search the web.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: string,
            repository: string,
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
            repositories: await Promise.all(
              [...this.roots.values()].map(async (e) => ({
                repository: e.root.name,
                files: (await (await e.index).paths()).length,
                services: await (await e.index).services(),
              })),
            ),
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
    for (const name of ["repository", "service", "scope", "language"])
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
      const rows = await (await entry.index).search(query, vector, filter, 40);
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
        repository: entry.root.name,
        ...hit,
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
      const m = match as { path: string; startLine: number };
      const k = m.path + ":" + m.startLine;
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
    clearTimeout(this.timer);
    this.lifetime.abort();
    this.disposables.forEach((d) => d.dispose());
    await this.job;
    for (const e of this.roots.values())
      try {
        await (await e.index).close();
      } catch {
        /* Already reported by index status. */
      }
  }
}
