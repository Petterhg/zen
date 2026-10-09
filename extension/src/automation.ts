import * as vscode from "vscode";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { assistanceViolation } from "./assistance.js";
import { Definitions } from "./definitions.js";
import { TaskWorkspace, textFile, type ChangeSet } from "./task-workspace.js";
import {
  executeCommand,
  gatedTool,
  toolRevision,
  type ToolEvent,
} from "./tool-registry.js";
import type { BackendTool } from "./backend.js";
import type { ResearchAgent } from "./subagents.js";
import { WorkspaceDiscovery } from "./discovery.js";
import { redactTrace } from "./trace.js";

export interface WorkerEnvironment {
  tools: BackendTool[];
  finish(): Promise<string | undefined>;
  dispose(): Promise<void>;
}
/** Host-owned permissions, task checkouts and review. No webview receives credentials. */
export class Automation implements vscode.Disposable {
  private changes = new Map<string, ChangeSet>();
  private documents = new Map<string, string>();
  private controllers = new Set<AbortController>();
  readonly history: ToolEvent[] = [];
  private provider = vscode.workspace.registerTextDocumentContentProvider(
    "zen-change",
    {
      provideTextDocumentContent: (uri) =>
        this.documents.get(uri.toString()) ?? "Change is no longer available.",
    },
  );
  constructor(
    readonly definitions: Definitions,
    private storage: string,
    private access: () => boolean,
    private assistance: () => number,
    private changed: () => void,
  ) {}
  summaries() {
    return [...this.changes.values()].map((c) => ({
      id: c.id,
      status: c.status,
      files: c.files.map((f) => f.path),
    }));
  }
  private event(event: ToolEvent) {
    this.history.push(redactTrace(event) as ToolEvent);
    if (this.history.length > 60) this.history.shift();
  }
  cancel() {
    for (const c of this.controllers) c.abort();
    this.changes.clear();
    this.documents.clear();
    this.changed();
  }
  private root(locator?: string): string {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const matching =
      locator &&
      roots.filter(
        (r) =>
          locator === r.name ||
          locator.startsWith(r.name + "/") ||
          locator === r.uri.fsPath ||
          locator.startsWith(r.uri.fsPath + path.sep),
      );
    if (matching && matching.length === 1) return matching[0].uri.fsPath;
    if (roots.length === 1) return roots[0].uri.fsPath;
    throw new Error(
      "Choose a repository root as scope in this multi-root workspace.",
    );
  }
  async prepare(
    id: string,
    profile: ResearchAgent | undefined,
    pool: BackendTool[],
    parent: AbortSignal,
    scope?: string,
  ): Promise<WorkerEnvironment> {
    await this.definitions.reload();
    parent.throwIfAborted();
    const assigned = (
      profile?.tools ?? this.definitions.policy.mainTools
    ).filter(
      (name) =>
        this.definitions.enabled(name) &&
        (id !== "main" ||
          this.assistance() > 0 ||
          (name !== "apply_patch" &&
            !Object.hasOwn(this.definitions.tools, name))) &&
        (!Object.hasOwn(this.definitions.tools, name) ||
          this.definitions.granted(this.definitions.tools[name])),
    );
    const custom = assigned.filter((name) =>
      Object.hasOwn(this.definitions.tools, name),
    );
    const isolated =
      profile?.workspace === "isolated-worktree" ||
      (!profile && (custom.length > 0 || assigned.includes("apply_patch")));
    if ((custom.length || assigned.includes("apply_patch")) && !isolated)
      throw new Error(
        "Command and patch tools require an isolated-worktree agent.",
      );
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    const signal = controller.signal;
    let workspace: TaskWorkspace | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const permission = (name: string) => {
      const current =
        id === "main"
          ? this.definitions.policy.mainTools
          : this.definitions.agents[id]?.enabled
            ? this.definitions.agents[id].tools
            : [];
      return (
        !signal.aborted &&
        this.access() &&
        assigned.includes(name) &&
        current.includes(name) &&
        this.definitions.enabled(name)
      );
    };
    const revisions = new Map(
      custom.map((name) => [name, toolRevision(this.definitions.tools[name])]),
    );
    const commandsAllowed = () =>
      custom.every(
        (name) =>
          permission(name) &&
          this.definitions.tools[name] &&
          this.definitions.granted(this.definitions.tools[name]) &&
          toolRevision(this.definitions.tools[name]) === revisions.get(name),
      );
    const dispose = async () => {
      clearInterval(timer);
      parent.removeEventListener("abort", abort);
      controller.abort();
      this.controllers.delete(controller);
      await workspace?.dispose();
    };
    try {
      if (isolated) {
        if (!this.access() || this.assistance() === 0)
          throw new Error(
            "Assistance is guidance only; implementer tools are unavailable.",
          );
        if (!commandsAllowed())
          throw new Error(
            "Approve assigned command tools in Tools settings first.",
          );
        const root = this.root(scope);
        const stillOpen = () =>
          (vscode.workspace.workspaceFolders ?? []).some(
            (f) => f.uri.fsPath === root,
          );
        workspace = new TaskWorkspace(
          root,
          this.storage,
          vscode.workspace.textDocuments
            .filter(
              (d) =>
                d.uri.scheme === "file" &&
                d.uri.fsPath.startsWith(root + path.sep),
            )
            .map((d) => ({
              path: path.relative(root, d.uri.fsPath),
              text: d.getText(),
              version: d.version,
            })),
          () =>
            this.access() &&
            this.assistance() > 0 &&
            stillOpen() &&
            !signal.aborted,
          this.assistance,
        );
        await workspace.initialize(signal);
        // Source tools must observe worker edits, never the original index/buffers.
        pool = [
          ...pool.filter((t) =>
            [
              "web_search",
              "fetch_page",
              "delegate_to_agents",
              "agent_run",
              "recall_pairing_context",
              "remember_pairing_context",
            ].includes(t.name),
          ),
          ...workspace.tools(),
        ];
        for (const name of custom) {
          const tool = this.definitions.tools[name];
          pool.push({
            name,
            description: tool.description,
            parameters: tool.inputSchema,
            volatile: true,
            execute: async (args) =>
              executeCommand(tool, args, workspace!.folder, signal, (text) =>
                this.event({ name, status: "running", message: text }),
              ),
          });
        }
      }
      // Permission changes cancel local processes as well as hiding their results.
      let checking = false;
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.definitions
          .reload()
          .then(() => {
            if (
              !this.access() ||
              (isolated && this.assistance() === 0) ||
              !commandsAllowed() ||
              (id !== "main" && !this.definitions.agents[id]?.enabled)
            )
              controller.abort();
          })
          .catch(() => controller.abort())
          .finally(() => {
            checking = false;
          });
      }, 500);
      const tools = pool
        .filter((t) => permission(t.name))
        .map((tool) =>
          gatedTool(
            {
              ...tool,
              execute: async (args, s) => {
                await this.definitions.reload();
                s.throwIfAborted();
                signal.throwIfAborted();
                if (!permission(tool.name) || !commandsAllowed())
                  throw new Error("Tool permission was revoked.");
                return tool.execute(args, AbortSignal.any([s, signal]));
              },
            },
            () => permission(tool.name) && commandsAllowed(),
            (e) => this.event(e),
          ),
        );
      return {
        tools,
        dispose,
        finish: async () => {
          signal.throwIfAborted();
          if (!workspace) return;
          const change = await workspace.changes(signal);
          signal.throwIfAborted();
          if (!this.access()) throw new Error("Workspace access was revoked.");
          if (!change.files.length) return;
          const violation = assistanceViolation(
            {
              summary: "Task changes",
              edits: change.files.map((f) => ({
                oldText: f.before ?? "",
                newText: f.after ?? "",
              })),
            },
            this.assistance(),
          );
          if (violation) throw new Error(violation);
          this.changes.set(change.id, change);
          while (this.changes.size > 40)
            this.changes.delete(this.changes.keys().next().value!);
          this.changed();
          return change.id;
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
  async review(id?: string): Promise<void> {
    const pending = [...this.changes.values()].filter(
      (c) => c.status === "pending",
    );
    const change = id
      ? this.changes.get(id)
      : pending.length === 1
        ? pending[0]
        : (
            await vscode.window.showQuickPick(
              pending.map((c) => ({
                label: `${c.files.length} changed files`,
                description: c.files.map((f) => f.path).join(", "),
                change: c,
              })),
            )
          )?.change;
    if (!change || change.status !== "pending") return;
    const pick = await vscode.window.showQuickPick(
      [
        ...change.files.map((f) => ({
          label: f.path,
          description:
            f.before === undefined
              ? "New file"
              : f.after === undefined
                ? "Deleted file"
                : "Modified file",
          action: f.path,
        })),
        {
          label: "Accept all changes",
          description: "Apply to editor with undo",
          action: "accept",
        },
        {
          label: "Reject changes",
          description: "Keep your files unchanged",
          action: "reject",
        },
      ],
      { title: "Review implementation" },
    );
    if (!pick) return;
    if (pick.action === "accept") {
      await this.accept(change);
      return;
    }
    if (pick.action === "reject") {
      change.status = "rejected";
      this.changed();
      return;
    }
    const file = change.files.find((f) => f.path === pick.action)!;
    const before = vscode.Uri.from({
        scheme: "zen-change",
        path: `/${change.id}/before/${file.path}`,
      }),
      after = vscode.Uri.from({
        scheme: "zen-change",
        path: `/${change.id}/after/${file.path}`,
      });
    this.documents.set(before.toString(), file.before ?? "");
    this.documents.set(after.toString(), file.after ?? "");
    await vscode.commands.executeCommand(
      "vscode.diff",
      before,
      after,
      `${file.path} · proposed change`,
    );
  }
  async accept(change: ChangeSet): Promise<void> {
    if (
      !this.access() ||
      this.assistance() === 0 ||
      change.status !== "pending"
    )
      throw new Error(
        "Change acceptance is unavailable in guidance-only or private mode.",
      );
    if (
      !(vscode.workspace.workspaceFolders ?? []).some(
        (f) => f.uri.fsPath === change.root,
      )
    )
      throw new Error("The original workspace is no longer open.");
    const violation = assistanceViolation(
      {
        summary: "Task changes",
        edits: change.files.map((f) => ({
          oldText: f.before ?? "",
          newText: f.after ?? "",
        })),
      },
      this.assistance(),
    );
    if (violation) throw new Error(violation);
    const discovery = new WorkspaceDiscovery(
      [{ name: "review", path: change.root }],
      "rg",
    );
    const signal = new AbortController().signal;
    const docs: { doc: vscode.TextDocument; version: number; text: string }[] =
      [];
    const edit = new vscode.WorkspaceEdit();
    for (const file of change.files) {
      const target = path.join(change.root, file.path);
      await discovery.permitTarget(target, signal);
      let parent = target;
      while (parent !== change.root) {
        try {
          if ((await lstat(parent)).isSymbolicLink())
            throw new Error(
              "Review target became a symlink. Request a fresh implementation.",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        parent = path.dirname(parent);
      }
      const uri = vscode.Uri.file(target);
      if (file.before === undefined) {
        if (
          (await textFile(target)) !== undefined ||
          vscode.workspace.textDocuments.some(
            (d) => d.uri.toString() === uri.toString(),
          )
        )
          throw new Error(
            `${file.path} now exists. Request a fresh implementation.`,
          );
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), file.after ?? "");
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (
          doc.getText() !== file.before ||
          (file.version !== undefined && doc.version !== file.version)
        )
          throw new Error(
            `${file.path} changed since the task started. Nothing was applied; request a fresh implementation.`,
          );
        docs.push({ doc, version: doc.version, text: doc.getText() });
        if (file.after === undefined)
          edit.deleteFile(uri, { ignoreIfNotExists: false });
        else
          edit.replace(
            uri,
            new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            ),
            file.after,
          );
      }
    }
    if (
      !this.access() ||
      this.assistance() === 0 ||
      docs.some(
        (d) => d.doc.version !== d.version || d.doc.getText() !== d.text,
      )
    )
      throw new Error("Context changed during review. Nothing was applied.");
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error(
        "The editor could not apply the change set. Inspect files and Undo before retrying.",
      );
    change.status = "accepted";
    this.changed();
  }
  dispose() {
    this.cancel();
    this.provider.dispose();
  }
}
