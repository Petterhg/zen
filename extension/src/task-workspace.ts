import path from "node:path";
import { assistanceViolation } from "./assistance.js";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { WorkspaceDiscovery, discoveryExcluded } from "./discovery.js";
import type { BackendTool } from "./backend.js";
const exec = promisify(execFile);
const git = async (cwd: string, args: string[], signal?: AbortSignal) =>
  (
    await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd, signal, maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
    )
  ).stdout;
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
export async function textFile(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
      throw new Error("Only regular text files up to 2 MB are supported.");
    const data = await readFile(file);
    if (data.includes(0))
      throw new Error("Binary files are not supported by change review.");
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (e) {
    if (absent(e)) return;
    throw e;
  }
}
export interface FileChange {
  path: string;
  before?: string;
  after?: string;
  version?: number;
}
export interface ChangeSet {
  id: string;
  root: string;
  files: FileChange[];
  status: "pending" | "accepted" | "rejected";
}
export interface BufferSnapshot {
  path: string;
  text: string;
  version: number;
}
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
/** Separate Git index/checkout. Commands remain explicitly approved local processes. */
export class TaskWorkspace {
  private baseline = "";
  private initialized = false;
  readonly folder: string;
  readonly id = randomUUID();
  constructor(
    readonly root: string,
    storage: string,
    private buffers: BufferSnapshot[],
    private allowed: () => boolean,
    private assistance: () => number = () => 100,
  ) {
    this.folder = path.join(storage, this.id);
  }
  private guard(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.allowed())
      throw new Error("Workspace access or assistance was revoked.");
  }
  async initialize(signal: AbortSignal): Promise<void> {
    this.guard(signal);
    const canonical = await realpath(this.root);
    const repo = (
      await git(canonical, ["rev-parse", "--show-toplevel"], signal)
    ).trim();
    if ((await realpath(repo)) !== canonical)
      throw new Error(
        "Open the Git repository root before starting an implementer.",
      );
    await mkdir(path.dirname(this.folder), { recursive: true, mode: 0o700 });
    this.initialized = true;
    await git(
      this.root,
      ["worktree", "add", "--detach", this.folder, "HEAD"],
      signal,
    );
    this.guard(signal);
    const changed = new Set(
      [
        ...(
          await git(
            this.root,
            ["diff", "--name-only", "-z", "HEAD", "--"],
            signal,
          )
        ).split("\0"),
        ...(
          await git(
            this.root,
            ["ls-files", "--others", "--exclude-standard", "-z"],
            signal,
          )
        ).split("\0"),
        ...this.buffers.map((b) => b.path),
      ].filter(Boolean),
    );
    const overlay: string[] = [];
    for (const file of changed) {
      this.guard(signal);
      try {
        await this.permitted(file, signal);
        const source =
          this.buffers.find((b) => b.path === file)?.text ??
          (await textFile(path.join(this.root, file)));
        if (source === undefined)
          await rm(path.join(this.folder, file), { force: true });
        else {
          await mkdir(path.dirname(path.join(this.folder, file)), {
            recursive: true,
          });
          await writeFile(path.join(this.folder, file), source);
        }
        overlay.push(file);
      } catch (error) {
        this.guard(signal);
        if (
          this.buffers.some((b) => b.path === file) &&
          !discoveryExcluded(file)
        )
          throw error;
        // Ignored/private/generated files are never copied from the human checkout.
      }
    }
    for (let i = 0; i < overlay.length; i += 100)
      await git(
        this.folder,
        ["add", "-A", "--", ...overlay.slice(i, i + 100)],
        signal,
      );
    this.baseline = (await git(this.folder, ["write-tree"], signal)).trim();
  }
  async permitted(file: string, signal: AbortSignal): Promise<void> {
    this.guard(signal);
    if (
      !file ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      file.includes("\0") ||
      file.split("/").some((p) => !p || p === "." || p === "..") ||
      discoveryExcluded(file)
    )
      throw new Error("Path is excluded or outside the task workspace.");
    for (const root of [this.root, this.folder]) {
      let cursor = root;
      for (const part of file.split("/")) {
        cursor = path.join(cursor, part);
        try {
          if ((await lstat(cursor)).isSymbolicLink())
            throw new Error("Symlink paths are not writable task targets.");
        } catch (e) {
          if (!absent(e)) throw e;
        }
      }
    }
    // Validate both the original workspace policy and the task checkout policy.
    for (const root of [this.root, this.folder]) {
      const discovery = new WorkspaceDiscovery(
        [{ name: "task", path: root }],
        "rg",
      );
      await discovery.permitTarget(path.join(root, file), signal);
    }
  }
  tools(): BackendTool[] {
    const read = async (args: Record<string, unknown>, signal: AbortSignal) => {
      const file = String(args.path ?? "");
      await this.permitted(file, signal);
      const source = await textFile(path.join(this.folder, file));
      if (source === undefined)
        throw new Error("File does not exist in the task checkout.");
      const lines = source.split("\n"),
        start = Math.max(1, Number(args.start_line ?? 1)),
        end = Math.min(
          lines.length,
          start + 399,
          Number(args.end_line ?? start + 399),
        );
      return {
        path: file,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        lines: lines
          .slice(start - 1, end)
          .map((l, i) => `${i + start}: ${l}`)
          .join("\n"),
        workspace: "isolated task checkout",
      };
    };
    const readSchema = object(
      {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      ["path"],
    );
    const discover = () =>
      new WorkspaceDiscovery([{ name: "task", path: this.folder }], "rg");
    return [
      {
        name: "read_file",
        volatile: true,
        description:
          "Read numbered current text from the isolated task checkout (including this worker's changes).",
        parameters: readSchema,
        execute: read,
      },
      {
        name: "read_files",
        volatile: true,
        description: "Read up to eight ranges in the isolated task checkout.",
        parameters: object(
          {
            files: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: readSchema,
            },
          },
          ["files"],
        ),
        execute: async (a, s) => ({
          files: await Promise.all(
            (a.files as Record<string, unknown>[]).map((f) => read(f, s)),
          ),
        }),
      },
      {
        name: "find_files",
        volatile: true,
        description:
          "Find files in the isolated task checkout. Results are paged and partial.",
        parameters: object(
          {
            query: { type: "string" },
            scope: { type: "string" },
            offset: { type: "integer", minimum: 0 },
          },
          ["query"],
        ),
        execute: async (a, s) => {
          this.guard(s);
          const d = discover(),
            page = await d.page(
              {
                query: String(a.query),
                scope: a.scope as string | undefined,
                offset: Number(a.offset ?? 0),
                limit: 80,
              },
              s,
            );
          const paths = [];
          for (const f of page.files) {
            const relative = d.label(f);
            try {
              await this.permitted(relative, s);
              paths.push(relative);
            } catch {
              this.guard(s);
            }
          }
          return { ...page, files: undefined, paths };
        },
      },
      {
        name: "workspace_overview",
        description: "Shallow directory map of this task checkout.",
        parameters: object({ scope: { type: "string" } }, []),
        execute: async (a, s) => {
          this.guard(s);
          return discover().overview(a.scope as string | undefined, s);
        },
      },
      {
        name: "search_text",
        volatile: true,
        description:
          "Literal text search in permitted files in the task checkout; bounded to 200 files and 40 matches. Follow source paths; this is not complete caller coverage.",
        parameters: object(
          {
            query: { type: "string", minLength: 1 },
            scope: { type: "string" },
          },
          ["query"],
        ),
        execute: async (a, s) => {
          this.guard(s);
          const d = discover(),
            page = await d.page(
              { scope: a.scope as string | undefined, limit: 200 },
              s,
            ),
            matches = [];
          for (const f of page.files) {
            try {
              const relative = d.label(f);
              await this.permitted(relative, s);
              const source = await textFile(f);
              for (const [i, line] of (source ?? "").split("\n").entries())
                if (line.includes(String(a.query))) {
                  matches.push({
                    path: relative,
                    line: i + 1,
                    text: line.slice(0, 400),
                  });
                  if (matches.length >= 40) return { matches, complete: false };
                }
            } catch {
              this.guard(s);
            }
          }
          return { matches, complete: page.complete };
        },
      },
      {
        name: "git_diff",
        volatile: true,
        description:
          "Read this task's diff against its captured starting files, excluding the human's pre-existing changes.",
        parameters: object({ path: { type: "string" } }, ["path"]),
        execute: async (a, s) => {
          await this.permitted(String(a.path), s);
          return {
            diff: (
              await git(
                this.folder,
                [
                  "diff",
                  "--no-ext-diff",
                  "--no-textconv",
                  this.baseline,
                  "--",
                  String(a.path),
                ],
                s,
              )
            ).slice(0, 24000),
          };
        },
      },
      {
        name: "apply_patch",
        volatile: true,
        description:
          "Replace one exact, unique text span in an isolated task file. Does NOT modify the human's editor. Use create/delete for whole files. Read current content first. All resulting changes require human review/acceptance.",
        parameters: object(
          {
            path: { type: "string" },
            operation: {
              type: "string",
              enum: ["replace", "create", "delete"],
            },
            oldText: { type: "string", maxLength: 240000 },
            newText: { type: "string", maxLength: 240000 },
          },
          ["path", "operation", "oldText", "newText"],
        ),
        execute: async (a, s) => {
          const file = String(a.path);
          await this.permitted(file, s);
          if (/(?:^|\/)\.(?:gitignore|pairignore|ignore)$/.test(file))
            throw new Error("A worker cannot change its own ignore policy.");
          const target = path.join(this.folder, file),
            current = await textFile(target),
            old = String(a.oldText),
            next = String(a.newText);
          const proposed =
            a.operation === "delete"
              ? undefined
              : a.operation === "create"
                ? next
                : current?.replace(old, () => next);
          const existing = await this.changes(s);
          let baseline: string | undefined;
          try {
            baseline = await git(
              this.folder,
              ["show", `${this.baseline}:${file}`],
              s,
            );
          } catch (error) {
            if (
              !/does not exist|exists on disk, but not in/.test(
                String((error as { stderr?: string }).stderr),
              )
            )
              throw error;
          }
          const edits = [
            ...existing.files
              .filter((f) => f.path !== file)
              .map((f) => ({
                oldText: f.before ?? "",
                newText: f.after ?? "",
              })),
            { oldText: baseline ?? "", newText: proposed ?? "" },
          ];
          const violation = assistanceViolation(
            { summary: "Implementation", edits },
            this.assistance(),
          );
          if (violation) throw new Error(violation);
          this.guard(s);
          if (a.operation === "create") {
            if (current !== undefined || old !== "")
              throw new Error(
                "Create requires an absent file and empty oldText.",
              );
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, next, { flag: "wx" });
          } else if (a.operation === "delete") {
            if (current === undefined || current !== old || next !== "")
              throw new Error(
                "Delete requires the full current text and empty newText.",
              );
            await rm(target);
          } else {
            if (
              current === undefined ||
              !old ||
              current.indexOf(old) < 0 ||
              current.indexOf(old) !== current.lastIndexOf(old)
            )
              throw new Error(
                "oldText must match one exact unique span; re-read this file.",
              );
            await writeFile(
              target,
              current.replace(old, () => next),
            );
          }
          return {
            path: file,
            status: "changed_in_task_worktree",
            appliedToEditor: false,
          };
        },
      },
    ];
  }
  async changes(signal: AbortSignal): Promise<ChangeSet> {
    this.guard(signal);
    const paths = new Set(
      [
        ...(
          await git(
            this.folder,
            ["diff", "--name-only", "-z", this.baseline, "--"],
            signal,
          )
        ).split("\0"),
        ...(
          await git(
            this.folder,
            ["ls-files", "--others", "--exclude-standard", "-z"],
            signal,
          )
        ).split("\0"),
      ].filter(Boolean),
    );
    if (paths.size > 100)
      throw new Error(
        "Task changed more than 100 files. Split implementation into smaller tasks.",
      );
    const files: FileChange[] = [];
    let bytes = 0;
    for (const file of paths) {
      await this.permitted(file, signal);
      let before: string | undefined;
      try {
        before = await git(
          this.folder,
          ["show", `${this.baseline}:${file}`],
          signal,
        );
      } catch (e) {
        if (
          !/does not exist|exists on disk, but not in/.test(
            String((e as { stderr?: string }).stderr),
          )
        )
          throw e;
      }
      if (
        before !== undefined &&
        (before.includes("\0") ||
          before.includes("\ufffd") ||
          Buffer.byteLength(before) > 2_000_000)
      )
        throw new Error(
          "Original file is not supported UTF-8 text up to 2 MB.",
        );
      const after = await textFile(path.join(this.folder, file));
      if (before === after) continue;
      bytes += Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
      if (bytes > 4_000_000)
        throw new Error("Change review exceeds 4 MB. Split this task.");
      files.push({
        path: file,
        before,
        after,
        version: this.buffers.find((b) => b.path === file)?.version,
      });
    }
    return { id: this.id, root: this.root, files, status: "pending" };
  }
  async dispose(): Promise<void> {
    if (this.initialized) {
      try {
        await git(this.root, ["worktree", "remove", "--force", this.folder]);
      } catch (error) {
        if (
          !/not a working tree/.test(
            String((error as { stderr?: string }).stderr),
          )
        )
          throw error;
        await rm(this.folder, { recursive: true, force: true });
      }
      this.initialized = false;
    } else await rm(this.folder, { recursive: true, force: true });
  }
}
