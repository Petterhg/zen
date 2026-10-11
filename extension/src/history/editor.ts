import * as vscode from "vscode";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { WorkspaceDiscovery } from "../discovery.js";
import type { Proposal } from "../core.js";
import { HistoryJournal, type HistoryRecord } from "./journal.js";
import { gitRoot, project } from "./project.js";
import { nativeOrigin, projectFile } from "./model.js";

/** Local opt-in recorder. Unsupported edits stay unknown; no timing-based attribution. */
export class EditorHistory implements vscode.Disposable {
  private journal?: HistoryJournal;
  private starting?: Promise<void>;
  private root?: string;
  private directory?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: string;
  private stopped = false;
  private snapshots = new Map<string, { text: string; version: number }>();
  private proposals = new WeakMap<
    Proposal,
    { id: string; requestId?: string; before: string }
  >();
  private subscriptions: vscode.Disposable[] = [];
  private inspection = "History has not been inspected.";
  private inspectionUri = vscode.Uri.parse("zen-history:/local-history.json");
  private inspectionChanges = new vscode.EventEmitter<vscode.Uri>();
  private clearInspection(): void {
    this.inspection =
      "History view cleared. Inspect again with current permissions.";
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "zen-history")
        this.inspectionChanges.fire(doc.uri);
    }
  }
  private status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    -100,
  );
  constructor(private context: vscode.ExtensionContext) {
    this.status.command = "pairCode.historyInspect";
    const ignoreWatcher = vscode.workspace.createFileSystemWatcher(
      "**/{.pairignore,.gitignore,.ignore}",
    );
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.stop().catch(() => {
          this.failure = "History stopped after a workspace change.";
          this.renderStatus();
        });
      }),
      this.inspectionChanges,
      vscode.workspace.registerTextDocumentContentProvider("zen-history", {
        onDidChange: this.inspectionChanges.event,
        provideTextDocumentContent: () =>
          this.enabled()
            ? this.inspection
            : "History is paused or unavailable.",
      }),
      ignoreWatcher,
      ignoreWatcher.onDidChange(() => this.clearInspection()),
      ignoreWatcher.onDidCreate(() => this.clearInspection()),
      ignoreWatcher.onDidDelete(() => this.clearInspection()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pairCode.shareEditorContext")) {
          this.snapshots.clear();
          this.clearInspection();
          this.renderStatus();
        }
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.observe(doc)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!event.contentChanges.length) return;
        const text = event.document.getText();
        const file = event.document.uri.fsPath;
        const version = event.document.version;
        const edits = event.contentChanges.map((edit) => ({
          start: edit.rangeOffset,
          end: edit.rangeOffset + edit.rangeLength,
          text: edit.text,
        }));
        const origin = nativeOrigin(
          event.detailedReason?.source,
          event.detailedReason?.metadata.kind,
          event.reason === vscode.TextDocumentChangeReason.Undo
            ? "undo"
            : event.reason === vscode.TextDocumentChangeReason.Redo
              ? "redo"
              : undefined,
        );
        this.enqueue(async () => {
          if (!(await this.permitted(file, event.document.uri.scheme))) {
            this.snapshots.delete(file);
            return;
          }
          const before = this.snapshots.get(file);
          if (!before) {
            await this.record("document.baseline", {
              file,
              text,
              version,
              coverage: "change observed without before snapshot",
            });
          } else {
            await this.record("document.changed", {
              file,
              beforeVersion: before.version,
              version,
              beforeText: before.text,
              text,
              edits,
              origin,
            });
          }
          this.snapshots.set(file, { text, version });
        });
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const file = doc.uri.fsPath,
          text = doc.getText(),
          version = doc.version;
        this.enqueue(async () => {
          if (await this.permitted(file, doc.uri.scheme))
            await this.record("document.saved", { file, text, version });
        });
      }),
    );
  }
  private enabled(): boolean {
    return (
      !this.stopped &&
      vscode.workspace.isTrusted &&
      vscode.workspace
        .getConfiguration("pairCode")
        .get("shareEditorContext", true)
    );
  }
  private async permitted(file: string, scheme = "file"): Promise<boolean> {
    if (!this.journal || !this.root || !this.enabled() || scheme !== "file")
      return false;
    const relative = path.relative(this.root, file);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.startsWith(`.zen${path.sep}`)
    )
      return false;
    try {
      // Reject symlink components, even when their target remains inside the repository.
      let current = this.root;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink()) return false;
      }
      await new WorkspaceDiscovery(
        [{ name: path.basename(this.root), path: this.root }],
        "rg",
      ).permitTarget(file, new AbortController().signal);
      return this.enabled();
    } catch {
      return false;
    }
  }
  private enqueue(work: () => Promise<void>): void {
    if (!this.journal || !this.enabled()) return;
    const task = this.queue.then(work);
    this.queue = task.catch(() => {
      this.failure =
        "History recording failed. Inspect status before continuing.";
      this.renderStatus();
    });
  }
  private async record(
    type: string,
    data: Record<string, unknown>,
  ): Promise<HistoryRecord> {
    if (!this.journal || this.failure)
      throw new Error(this.failure || "History is not recording.");
    try {
      const event = await this.journal.append(type, data);
      this.renderStatus();
      return event;
    } catch (error) {
      this.failure = "History recording failed. Recording coverage has a gap.";
      this.renderStatus();
      throw error;
    }
  }
  private observe(doc: vscode.TextDocument): void {
    const file = doc.uri.fsPath,
      text = doc.getText(),
      version = doc.version;
    this.enqueue(async () => {
      if (!(await this.permitted(file, doc.uri.scheme))) return;
      await this.record("document.baseline", { file, text, version });
      this.snapshots.set(file, { text, version });
    });
  }
  private renderStatus(): void {
    this.status.text = this.failure
      ? "$(warning) History gap"
      : this.enabled()
        ? "$(history) Recording"
        : "$(history) Paused";
    this.status.tooltip =
      "Local conversation and edit history. Click to inspect capture coverage.";
    if (this.journal || this.failure) this.status.show();
  }
  async restore(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !this.enabled()) return;
    try {
      const root = await gitRoot(folder.uri.fsPath);
      if (this.context.globalState.get(`history.enabled:${root}`, false)) {
        try {
          await this.start(root);
        } catch {
          this.failure =
            "Local history could not resume. Inspect status; capture is unavailable.";
          this.renderStatus();
        }
      }
    } catch {
      /* No Git root is a normal first launch. */
    }
  }
  async initialize(): Promise<void> {
    this.stopped = false;
    if (!this.enabled())
      throw new Error(
        "History requires a trusted workspace and shared editor context.",
      );
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Open a Git repository first.");
    const root = await gitRoot(folder.uri.fsPath);
    await project(root, true);
    await this.context.globalState.update(`history.enabled:${root}`, true);
    await this.start(root);
    void vscode.window.showInformationMessage(
      "Local history recording enabled. Commit .zen/project.json to preserve the repository identity across clones. Sharing is not enabled.",
    );
  }
  private async start(root: string): Promise<void> {
    if (this.starting) return this.starting;
    if (this.journal) return;
    this.starting = this.startSession(root);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async startSession(root: string): Promise<void> {
    this.failure = undefined;
    this.snapshots.clear();
    const metadata = await project(root);
    const directory = path.join(
      this.context.globalStorageUri.fsPath,
      "history",
      metadata.repositoryId,
    );
    const journal = await HistoryJournal.create(
      directory,
      metadata.repositoryId,
      this.context.secrets,
    );
    this.root = root;
    this.directory = directory;
    this.journal = journal;
    let actorId = this.context.globalState.get<string>("history.localActor");
    if (!actorId) {
      actorId = randomUUID();
      await this.context.globalState.update("history.localActor", actorId);
    }
    await this.record("session.started", {
      checkout: root,
      replica: journal.id,
      actorId,
      identity: "local device claim; not an authenticated person",
      coverage:
        "open permitted text buffers; no filesystem, worker, provider-wire or Git capture",
    });
    for (const doc of vscode.workspace.textDocuments) this.observe(doc);
    await this.flush();
    this.renderStatus();
  }
  async request(
    file: string | undefined,
    input: string,
    metadata: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (!this.journal || !this.enabled()) return;
    if (!file || !(await this.permitted(vscode.Uri.parse(file).fsPath))) return;
    try {
      await this.flush();
    } catch {
      return;
    }
    const requestId = randomUUID();
    try {
      await this.record("request.observed", {
        requestId,
        file: vscode.Uri.parse(file).fsPath,
        input,
        ...metadata,
        coverage: "host request; not full provider input or hidden reasoning",
      });
    } catch {
      return;
    }
    return requestId;
  }
  async proposal(proposal: Proposal, requestId?: string): Promise<void> {
    if (!this.journal) return;
    await this.flush();
    const file = vscode.Uri.parse(proposal.uri).fsPath;
    if (!(await this.permitted(file))) return;
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === proposal.uri,
    );
    if (!document || document.version !== proposal.version)
      throw new Error("Cannot record a stale proposal.");
    const id = randomUUID(),
      before = document.getText();
    await this.record("proposal.created", {
      proposalId: id,
      requestId,
      file,
      version: proposal.version,
      start: proposal.start,
      end: proposal.end,
      oldText: proposal.oldText,
      newText: proposal.newText,
      explanation: proposal.summary,
    });
    this.proposals.set(proposal, { id, requestId, before });
  }
  async prepareApply(proposal: Proposal): Promise<void> {
    if (!this.journal) return;
    await this.flush();
    const evidence = this.proposals.get(proposal);
    if (
      evidence &&
      (await this.permitted(vscode.Uri.parse(proposal.uri).fsPath))
    ) {
      await this.record("proposal.apply-prepared", {
        proposalId: evidence.id,
        file: vscode.Uri.parse(proposal.uri).fsPath,
        beforeVersion: proposal.version,
        expectedText:
          evidence.before.slice(0, proposal.start) +
          proposal.newText +
          evidence.before.slice(proposal.end),
      });
    }
  }
  async accepted(proposal: Proposal): Promise<void> {
    const evidence = this.proposals.get(proposal);
    if (!evidence) return;
    const doc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === proposal.uri,
    );
    const file = vscode.Uri.parse(proposal.uri).fsPath;
    if (!doc) return;
    const acceptedVersion = doc.version,
      acceptedText = doc.getText();
    if (!(await this.permitted(file))) return;
    const expected =
      evidence.before.slice(0, proposal.start) +
      proposal.newText +
      evidence.before.slice(proposal.end);
    if (acceptedVersion !== proposal.version + 1 || acceptedText !== expected)
      throw new Error(
        "Accepted proposal could not be verified against the complete buffer.",
      );
    await this.flush();
    await this.record("proposal.accepted", {
      proposalId: evidence.id,
      requestId: evidence.requestId,
      file,
      beforeVersion: proposal.version,
      version: acceptedVersion,
      text: expected,
      origin: { writer: "ai", operation: "accepted-proposal" },
      acceptor: "local-device-unverified",
      state: "applied-to-buffer; save not implied",
    });
    this.proposals.delete(proposal);
  }
  rejected(proposal: Proposal): void {
    const evidence = this.proposals.get(proposal);
    if (!evidence) return;
    this.enqueue(async () => {
      if (await this.permitted(vscode.Uri.parse(proposal.uri).fsPath))
        await this.record("proposal.rejected", { proposalId: evidence.id });
    });
    this.proposals.delete(proposal);
  }
  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw new Error(this.failure);
    await this.journal?.flush();
  }
  async inspect(): Promise<void> {
    await this.queue;
    this.clearInspection();
    const records =
      this.journal && this.directory && this.enabled()
        ? await HistoryJournal.read(
            this.directory,
            this.journal.repositoryId,
            this.context.secrets,
          )
        : [];
    const allowed: HistoryRecord[] = [];
    for (const record of records) {
      // Revalidate old evidence using current policy. Session paths are not displayed.
      if (
        typeof record.data.file === "string" &&
        (await this.permitted(record.data.file))
      )
        allowed.push(record);
    }
    if (!this.enabled()) allowed.length = 0;
    const report = {
      status:
        this.failure ||
        (this.journal
          ? this.enabled()
            ? "recording"
            : "paused"
          : "not initialized"),
      durable: this.journal?.status.durable || 0,
      repositoryId: this.journal?.repositoryId,
      localActorId: this.context.globalState.get("history.localActor"),
      identity: "local device claim; not an authenticated person",
      coverage:
        "Local open buffers, host requests and accepted single-file previews. Other edits remain unknown. No Git mappings, worker capture, provider wire input, sharing or hidden reasoning.",
      files: [
        ...new Set(
          allowed
            .filter((r) => r.replicaId === this.journal?.id)
            .map((r) => r.data.file)
            .filter((f): f is string => typeof f === "string"),
        ),
      ].map((file) => ({
        file,
        ...projectFile(
          allowed.filter((r) => r.replicaId === this.journal?.id),
          file,
        ),
      })),
      records: allowed,
    };
    this.inspection = JSON.stringify(report, null, 2);
    this.inspectionUri = vscode.Uri.parse(
      `zen-history:/local-history.json?inspection=${randomUUID()}`,
    );
    const doc = await vscode.workspace.openTextDocument(this.inspectionUri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearInspection();
    if (this.root)
      await this.context.globalState.update(
        `history.enabled:${this.root}`,
        false,
      );
    await this.starting?.catch(() => {});
    await this.queue;
    await this.journal?.close();
    this.journal = undefined;
    this.status.hide();
  }
  dispose(): void {
    this.stopped = true;
    this.subscriptions.forEach((item) => item.dispose());
    this.status.dispose();
    void this.queue.then(() => this.journal?.close()).catch(() => {});
  }
}
