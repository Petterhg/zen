import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import ignore, { type Ignore } from "ignore";
import { insideWorkspace, isPrivatePath } from "./tool-policy.js";
import { mapConcurrent } from "./concurrency.js";
import { ToolFailure } from "./tool-errors.js";
const exec = promisify(execFile);
const generated = new Set([
  ".worktrees",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".runtime",
  ".upstream",
  ".cache",
  ".tox",
  ".next",
  ".turbo",
]);
export const discoveryExcluded = (relative: string) =>
  isPrivatePath(relative) ||
  relative.split(/[\\/]/).some((part) => generated.has(part));
const excluded = discoveryExcluded;
export interface DiscoveryRoot {
  name: string;
  path: string;
}
export interface DiscoveryPage {
  files: string[];
  scope: string;
  complete: boolean;
  nextOffset?: number;
}
/** Inventory pages are streamed, never cached as a whole-repository promise. */
export class WorkspaceDiscovery {
  private rules = new Map<string, Promise<Ignore>>();
  constructor(
    readonly roots: DiscoveryRoot[],
    readonly rg: string,
  ) {}
  label(file: string): string {
    const root = this.roots.find((r) => this.within(r.path, file));
    if (!root) throw new Error("Path is outside the open workspace.");
    const relative = path.relative(root.path, file).split(path.sep).join("/");
    return this.roots.length > 1 ? `${root.name}/${relative}` : relative;
  }
  private within(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return (
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
    );
  }
  private rule(file: string): Promise<Ignore> {
    let result = this.rules.get(file);
    if (!result) {
      result = readFile(file, "utf8")
        .then((text) => ignore().add(text))
        .catch((error) => {
          this.rules.delete(file);
          if (error.code === "ENOENT") return ignore();
          throw new Error("Ignore policy could not be read.");
        });
      this.rules.set(file, result);
    }
    return result;
  }
  private async permitted(
    root: DiscoveryRoot,
    file: string,
    directory: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const relative = path.relative(root.path, file).split(path.sep).join("/");
    if (!relative) return;
    if (excluded(relative))
      throw new Error("This path is excluded from AI context.");
    const pair = await this.rule(path.join(root.path, ".pairignore"));
    const parts = relative.split("/");
    // Check ancestors too: an ignored parent cannot be reintroduced by a child negation.
    for (let i = 1; i <= parts.length; i++) {
      const item =
        parts.slice(0, i).join("/") +
        (i < parts.length || directory ? "/" : "");
      if (pair.ignores(item))
        throw new Error("This path is excluded by .pairignore.");
      for (const name of [".gitignore", ".ignore"]) {
        let ignored = false;
        for (let j = 0; j < i; j++) {
          const base = path.join(root.path, ...parts.slice(0, j));
          const local =
            parts.slice(j, i).join("/") +
            (i < parts.length || directory ? "/" : "");
          const result = (await this.rule(path.join(base, name))).test(local);
          if (result.ignored) ignored = true;
          if (result.unignored) ignored = false;
        }
        if (ignored)
          throw new Error("This path is excluded by workspace ignore rules.");
      }
    }
    // Include Git's global excludes and repository-specific exclude file.
    try {
      await exec(
        "git",
        ["check-ignore", "--no-index", "--quiet", "--", relative],
        { cwd: root.path, signal, timeout: 3000 },
      );
    } catch (error) {
      signal.throwIfAborted();
      const code = (error as { code?: number }).code;
      if (
        code === 1 ||
        (code === 128 &&
          /not a git repository/i.test(
            String((error as { stderr?: string }).stderr),
          ))
      )
        return; // not ignored / non-Git workspace
      throw new Error("Git ignore policy could not be checked.");
    }
    throw new Error("This path is excluded by Git ignore rules.");
  }
  async resolve(
    value: string,
    signal: AbortSignal,
    directory = false,
  ): Promise<string> {
    if (!value || value.length > 2000 || value.includes("\0"))
      throw new Error("Invalid workspace path.");
    signal.throwIfAborted();
    const candidates = path.isAbsolute(value)
      ? [value]
      : this.roots.flatMap((r) => {
          if (this.roots.length > 1)
            return value === r.name
              ? [r.path]
              : value.startsWith(`${r.name}/`)
                ? [path.join(r.path, value.slice(r.name.length + 1))]
                : [];
          return [path.join(r.path, value)];
        });
    const matches: string[] = [];
    for (const candidate of candidates) {
      const root = this.roots.find((r) => this.within(r.path, candidate));
      if (!root) continue;
      try {
        const resolved = await realpath(candidate);
        const base = await realpath(root.path);
        if (!this.within(base, resolved))
          throw new Error("This path escapes the open workspace.");
        const isDir = (await stat(resolved)).isDirectory();
        if (isDir !== directory)
          throw new Error(
            directory ? "Scope must be a directory." : "Path must be a file.",
          );
        await this.permitted(root, candidate, directory, signal);
        // Preserve alias AND target privacy/ignore policy for symlinks.
        const canonical = path.join(root.path, path.relative(base, resolved));
        if (canonical !== candidate)
          await this.permitted(root, canonical, directory, signal);
        if (!directory)
          await insideWorkspace(
            resolved,
            this.roots.map((r) => r.path),
          );
        matches.push(candidate);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    }
    signal.throwIfAborted();
    if (matches.length !== 1)
      throw new Error(
        "File is absent, ambiguous, or excluded; use find_files with a scope.",
      );
    return matches[0];
  }
  async overview(
    scope: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const bases = scope
      ? [await this.resolve(scope, signal, true)]
      : this.roots.map((r) => r.path);
    const entries: { path: string; kind: string }[] = [];
    let complete = true,
      overviewBytes = 0;
    for (const base of bases) {
      const root = this.roots.find((r) => this.within(r.path, base))!;
      for (const entry of (await readdir(base, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        signal.throwIfAborted();
        const file = path.join(base, entry.name);
        if (entry.isSymbolicLink()) continue;
        try {
          await this.permitted(root, file, entry.isDirectory(), signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && /excluded/.test(error.message))
            continue;
          throw error;
        }
        const entryBytes =
          Buffer.byteLength(JSON.stringify(this.label(file))) + 40;
        if (
          entries.length === 160 ||
          (overviewBytes + entryBytes > 20000 && entries.length > 0)
        ) {
          complete = false;
          break;
        }
        overviewBytes += entryBytes;
        entries.push({
          path: this.label(file),
          kind: entry.isDirectory() ? "directory" : "file",
        });
      }
    }
    return {
      roots: this.roots.map((r) => r.name),
      scope: scope ?? ".",
      entries,
      complete,
      instruction:
        "Inspect the relevant directory with scope; use find_files for source paths. This is a shallow map, not a dependency graph.",
    };
  }
  async page(
    input: { scope?: string; query?: string; offset?: number; limit?: number },
    signal: AbortSignal,
  ): Promise<DiscoveryPage> {
    signal.throwIfAborted();
    const bases = input.scope
      ? [await this.resolve(input.scope, signal, true)]
      : this.roots.map((r) => r.path);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 80)));
    if (
      !Number.isSafeInteger(offset) ||
      offset > 1_000_000 ||
      !Number.isFinite(limit)
    )
      throw new Error("Invalid page offset or size.");
    const files: string[] = [];
    let seen = 0,
      pageBytes = 0,
      overflow = false;
    for (const base of bases) {
      const root = this.roots.find((r) => this.within(r.path, base))!;
      const args = ["--files", "--null", ...this.args(root)];
      const relative = path.relative(root.path, base);
      if (relative) args.push("--", relative);
      await this.scan(args, root.path, signal, "\0", (record) => {
        const file = path.resolve(root.path, record);
        const rel = path.relative(root.path, file);
        if (
          !this.within(root.path, file) ||
          excluded(rel) ||
          !this.label(file)
            .toLowerCase()
            .includes((input.query ?? "").toLowerCase())
        )
          return true;
        if (seen++ < offset) return true;
        const bytes = Buffer.byteLength(JSON.stringify(this.label(file))) + 1;
        if (
          files.length >= limit ||
          (pageBytes + bytes > 20000 && files.length > 0)
        ) {
          overflow = true;
          return false;
        }
        files.push(file);
        pageBytes += bytes;
        return true;
      });
      if (overflow) break;
    }
    signal.throwIfAborted();
    const complete = !overflow;
    return {
      files: files.slice(0, limit),
      scope: input.scope ?? ".",
      complete,
      ...(complete ? {} : { nextOffset: offset + files.length }),
    };
  }
  /** A background index may stream the whole inventory without putting it in model context. */
  async *walk(signal: AbortSignal): AsyncGenerator<string> {
    for (const root of this.roots) {
      signal.throwIfAborted();
      const child = spawn(this.rg, ["--files", "--null", ...this.args(root)], {
        cwd: root.path,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr.resume();
      const finished = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 || code === 1
            ? resolve()
            : reject(new Error("Workspace inventory failed.")),
        );
      });
      void finished.catch(() => {});
      const abort = () => {
        child.kill();
      };
      signal.addEventListener("abort", abort, { once: true });
      let pending = "";
      try {
        child.stdout.setEncoding("utf8");
        for await (const part of child.stdout) {
          pending += part;
          let at: number;
          while ((at = pending.indexOf("\0")) >= 0) {
            const record = pending.slice(0, at);
            pending = pending.slice(at + 1);
            const file = path.resolve(root.path, record);
            signal.throwIfAborted();
            if (
              this.within(root.path, file) &&
              !excluded(path.relative(root.path, file))
            )
              yield file;
          }
        }
        await finished;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
        child.kill();
      }
    }
  }
  private args(root: DiscoveryRoot): string[] {
    const args = ["--hidden", "--no-require-git", "--sort", "path"];
    for (const name of [
      ".git",
      ".aws",
      ".ssh",
      "credentials",
      "id_rsa",
      "id_ed25519",
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      ...generated,
    ])
      args.push("-g", `!${name}`);
    const pair = path.join(root.path, ".pairignore");
    if (existsSync(pair)) args.push("--ignore-file", pair);
    return args;
  }
  /** Stream records, stopping immediately when the consumer has a full page. */
  private scan(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    delimiter: string,
    accept: (record: string) => boolean,
  ): Promise<boolean> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.rg, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let pending = "",
        settled = false;
      const finish = (complete: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        child.kill();
        if (error) reject(error);
        else resolve(complete);
      };
      const abort = () =>
        finish(false, signal.reason ?? new Error("Discovery cancelled."));
      const timer = setTimeout(
        () =>
          finish(
            false,
            new ToolFailure(
              "discovery_unavailable",
              "Workspace lookup timed out. Known-path reads still work; do not repeat this operation in this request.",
              "workspace.discovery",
            ),
          ),
        15000,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        pending += chunk;
        let end: number;
        try {
          while ((end = pending.indexOf(delimiter)) !== -1) {
            const record = pending.slice(0, end);
            pending = pending.slice(end + delimiter.length);
            if (!accept(record)) {
              finish(false);
              return;
            }
          }
        } catch {
          finish(
            false,
            new ToolFailure(
              "discovery_unavailable",
              "Workspace lookup returned unreadable output. Known-path reads still work.",
              "workspace.discovery",
            ),
          );
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", () =>
        finish(
          false,
          new ToolFailure(
            "discovery_unavailable",
            "Workspace lookup could not start. Known-path reads still work.",
            "workspace.discovery",
          ),
        ),
      );
      child.on("close", (code) =>
        finish(
          true,
          code === 0 || code === 1
            ? undefined
            : new ToolFailure(
                "discovery_unavailable",
                "Workspace lookup failed. Known-path reads still work.",
                "workspace.discovery",
              ),
        ),
      );
    });
  }
  async search(
    input: {
      query: string;
      scope?: string;
      pathFilter?: string;
      offset?: number;
      overlays?: { file: string; text: string; version: number }[];
    },
    signal: AbortSignal,
  ): Promise<{
    matches: {
      file: string;
      line: number;
      text: string;
      version?: number;
      source: string;
    }[];
    complete: boolean;
    nextOffset?: number;
    scope: string;
    skipped: number;
    coverage: string;
  }> {
    if (
      !input.query ||
      input.query.length > 2000 ||
      /[\r\n\0]/.test(input.query)
    )
      throw new Error(
        "Search requires one literal single-line query; use read_file for multiline inspection.",
      );
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
      throw new Error("Invalid match offset.");
    const bases = input.scope
      ? [await this.resolve(input.scope, signal, true)]
      : this.roots.map((r) => r.path);
    const candidates: {
      file: string;
      line: number;
      text: string;
      version?: number;
      source: string;
    }[] = [];
    const dirty = new Set<string>();
    let seen = 0,
      complete = true,
      skipped = 0;
    const accept = (match: (typeof candidates)[number]): boolean => {
      if (
        !bases.some((base) => this.within(base, match.file)) ||
        excluded(
          path.relative(
            this.roots.find((r) => this.within(r.path, match.file))!.path,
            match.file,
          ),
        )
      )
        return true;
      if (
        input.pathFilter &&
        !this.label(match.file).includes(input.pathFilter)
      )
        return true;
      if (seen++ < offset) return true;
      if (candidates.length === 40) return false;
      candidates.push(match);
      return true;
    };
    for (const overlay of (input.overlays ?? [])
      .slice()
      .sort((a, b) => a.file.localeCompare(b.file))) {
      signal.throwIfAborted();
      if (!bases.some((base) => this.within(base, overlay.file))) continue;
      try {
        await this.resolve(overlay.file, signal);
      } catch {
        signal.throwIfAborted();
        skipped++;
        continue;
      }
      dirty.add(path.resolve(overlay.file));
      if (Buffer.byteLength(overlay.text) > 180000) {
        skipped++;
        continue;
      }
      const lines = overlay.text.split("\n");
      for (let i = 0; i < lines.length; i++)
        if (
          lines[i].includes(input.query) &&
          !accept({
            file: overlay.file,
            line: i + 1,
            text: lines[i].slice(0, 400),
            version: overlay.version,
            source: "unsaved_buffer",
          })
        ) {
          complete = false;
          break;
        }
      if (!complete) break;
    }
    if (complete)
      for (const base of bases) {
        const root = this.roots.find((r) => this.within(r.path, base))!;
        const args = [
          "--json",
          "--fixed-strings",
          "--line-number",
          "--max-filesize",
          "180K",
          ...this.args(root),
          "-e",
          input.query,
        ];
        const relative = path.relative(root.path, base);
        if (relative) args.push("--", relative);
        complete = await this.scan(args, root.path, signal, "\n", (record) => {
          const event = JSON.parse(record);
          if (
            event.type !== "match" ||
            typeof event.data?.path?.text !== "string" ||
            typeof event.data?.lines?.text !== "string"
          )
            return true;
          const file = path.resolve(root.path, event.data.path.text);
          if (!this.within(root.path, file) || dirty.has(file)) return true;
          return accept({
            file,
            line: event.data.line_number,
            text: event.data.lines.text.replace(/\r?\n$/, "").slice(0, 400),
            source: "disk",
          });
        });
        if (!complete) break;
      }
    // Resolve only matched files; searching never opens hundreds of editor models.
    const safe = new Map<string, boolean>();
    await mapConcurrent(
      [...new Set(candidates.map((m) => m.file))],
      4,
      async (file) => {
        try {
          await this.resolve(file, signal);
          safe.set(file, true);
        } catch {
          signal.throwIfAborted();
          safe.set(file, false);
          skipped++;
        }
      },
    );
    signal.throwIfAborted();
    return {
      matches: candidates.filter((m) => safe.get(m.file)),
      scope: input.scope ?? ".",
      complete: complete && skipped === 0,
      ...(!complete ? { nextOffset: offset + candidates.length } : {}),
      skipped,
      coverage:
        "Literal text across eligible files in this scope. Unsaved buffers replace disk. Binary, ignored/generated, oversized (180 KB), unavailable or symlink-only files are unchecked; text matches are not a complete runtime dependency graph. Pagination offsets count matches, not files; edits may shift them.",
    };
  }
}
