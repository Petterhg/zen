import { PersonalMemory } from "./memory-service.js";
import { IndexService } from "./index-service.js";
import { configurationRequiresCancellation } from "./settings-policy.js";
import { ResearchBriefs } from "./research-briefs.js";
import { RequestTargets } from "./request-target.js";
import { decideEffort, type Effort } from "./task-policy.js";
import { explorationTool } from "./exploration.js";
import {
  bufferReferences,
  codeReference,
  SpokenCodeFocus,
  type CodeReference,
} from "./code-pointing.js";
import {
  assistanceLevel,
  assistanceViolation,
  voiceAssistanceInstructions,
} from "./assistance.js";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createLiveSession,
  requestBackend,
  requestInline,
  DEFAULT_MODELS,
} from "./backend.js";
import {
  canApplyProposal,
  conciseVoiceContent,
  createProposal,
  editorVoiceContext,
  TranscriptHistory,
  FocusTimeline,
  parseBackendResult,
  type BackendResult,
  type EditorContext,
  type Proposal,
  type Provider,
} from "./core.js";

import { localKey } from "./local-keys.js";
import { voiceInstructions } from "./prompts.js";
import { workspaceTools } from "./workspace-tools.js";
import type { ResearchArticle } from "./research.js";
import { isPrivatePath, publicWebUrl } from "./tool-policy.js";
import { TraceJournal } from "./trace.js";

interface LiveEvent {
  type: string;
  event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  offset_ms?: number;
  delegation?: { id: string; target: string };
  error?: { message?: string };
}
interface PanelMessage {
  type: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  event?: LiveEvent;
  sessionToken?: number;
  text?: string;
  provider?: Provider;
  mode?: string;
  contextId?: number;
  endMs?: number;
  seconds?: number;
  final?: boolean;
  enabled?: boolean;
  level?: number;
}

class Companion implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private trace: TraceJournal;
  private editor?: vscode.TextEditor;
  private history = new TranscriptHistory();
  private conversationMode: "voice" | "chat" = "voice";
  async beginConversation(): Promise<void> {
    if (this.conversationMode === "voice") await this.startVoice();
    else this.publishTranscript();
  }
  private publishTranscript(): void {
    this.post({ type: "transcript", entries: this.history.snapshot() });
  }
  private focus = new FocusTimeline();
  private targets = new RequestTargets();
  private lastEditEvent?: { status: string; file?: string };
  private recentFiles: string[] = [];
  private research: ResearchArticle[] = [];
  private researchBriefs = new ResearchBriefs();
  private codeIndex: IndexService;
  private memory: PersonalMemory;
  private resumedCheckpoint?: { scope: string; id: string };
  private proposalCheckpointId?: string;
  private inlineJob?: AbortController;
  private backendRunning = false;
  private activeDelegation?: string;
  private codeRefs: CodeReference[] = [];
  private spokenFocus = new SpokenCodeFocus();
  private referenceSignature = "";
  private sharedReferenceContent = "";
  private pointed?: CodeReference;
  private pointing = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    after: {
      contentText: "  Pair is pointing here",
      color: new vscode.ThemeColor("editorInfo.foreground"),
      fontStyle: "italic",
    },
  });
  private proposal?: Proposal;
  private backendJob?: AbortController;
  private sessionJob?: AbortController;
  private jobRevision = 0;
  private sessionToken = 0;
  private panelReady = false;
  private checkpointAvailabilityRevision = 0;
  private pendingVoiceStart = false;
  private contextTimer?: ReturnType<typeof setTimeout>;
  private seenDelegations = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private proposalChanges = new vscode.EventEmitter<void>();
  private lensChanges = new vscode.EventEmitter<void>();
  private status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  private voiceMute = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  private voiceEnd = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );

  async startVoice(): Promise<void> {
    this.conversationMode = "voice";
    this.post({ type: "conversationMode", mode: "voice" });
    this.pendingVoiceStart = true;
    await vscode.commands.executeCommand("pairCode.open");
    if (this.panelReady && this.pendingVoiceStart) {
      this.pendingVoiceStart = false;
      this.voiceControl("start");
    }
  }
  async chooseAssistance(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "Voice only",
          description: "Explain; never write code",
          level: 0,
        },
        {
          label: "One small step",
          description: "Small suggestions, together",
          level: 25,
        },
        {
          label: "Work together",
          description: "Draft a focused change",
          level: 60,
        },
        {
          label: "Draft it for me",
          description: "Implement, then explain",
          level: 100,
        },
      ],
      {
        title: "How should your pair help?",
        placeHolder: "The workboard slider allows finer adjustment",
      },
    );
    if (selected)
      await this.configuration().update(
        "assistanceLevel",
        selected.level,
        vscode.ConfigurationTarget.Global,
      );
  }
  voiceControl(action: "start" | "mute" | "end"): void {
    this.post({
      type: "voiceControl",
      action,
      sessionToken: this.sessionToken,
    });
  }
  private updateVoiceStatus(state: string): void {
    void vscode.commands.executeCommand("setContext", "zen.voiceState", state);
    const connected = state === "listening" || state === "muted";
    this.status.text = connected
      ? "$(mic) Zen · " + (state === "muted" ? "Muted" : "Listening")
      : "$(circle-outline) Zen";
    this.voiceMute.text = state === "muted" ? "$(mic) Unmute" : "$(mute) Mute";
    if (connected) {
      this.voiceMute.show();
      this.voiceEnd.show();
    } else {
      this.voiceMute.hide();
      this.voiceEnd.hide();
    }
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Pair Code Diagnostics");
    this.disposables.push(output, this.pointing);
    this.trace = new TraceJournal(
      vscode.Uri.joinPath(context.globalStorageUri, "traces").fsPath,
      () =>
        (context.extensionMode === vscode.ExtensionMode.Development ||
          Boolean(process.env.PAIR_CODE_PROJECT_ROOT)) &&
        this.configuration().get("traceEnabled", true),
      () => output.appendLine("Local trace could not be written."),
    );
    this.trace.record({
      type: "extension.started",
      extensionVersion: context.extension.packageJSON.version,
    });
    output.appendLine(`Local session trace: ${this.trace.file}`);
    this.memory = new PersonalMemory(context, () =>
      this.invalidateMemoryContext(),
    );
    this.disposables.push(this.memory);
    this.codeIndex = new IndexService(
      context,
      () => this.key("openai"),
      () =>
        this.configuration().get("indexEnabled", true) &&
        this.configuration().get("shareEditorContext", true),
      (status) => this.post({ type: "indexStatus", ...status }),
    );
    this.disposables.push(this.codeIndex);
    this.editor = vscode.window.activeTextEditor;
    this.updateVoiceStatus("disconnected");
    this.status.command = "pairCode.open";
    this.status.tooltip = "Open your pair programmer";
    this.status.show();
    this.voiceMute.command = "pairCode.toggleVoiceMute";
    this.voiceMute.tooltip = "Mute or unmute the pairing microphone";
    this.voiceEnd.command = "pairCode.endVoice";
    this.voiceEnd.text = "$(debug-stop) End voice";
    this.voiceEnd.tooltip = "Disconnect voice pairing";
    this.disposables.push(
      this.status,
      this.voiceMute,
      this.voiceEnd,
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme: "file" },
        {
          onDidChange: this.proposalChanges.event,
          provideInlineCompletionItems: async (
            document,
            position,
            inlineContext,
            token,
          ) => {
            const proposal = this.proposal;
            if (proposal) {
              if (
                !canApplyProposal(
                  proposal,
                  document.uri.toString(),
                  document.version,
                  document.getText(),
                )
              )
                return [];
              const item = new vscode.InlineCompletionItem(
                proposal.newText,
                new vscode.Range(
                  document.positionAt(proposal.start),
                  document.positionAt(proposal.end),
                ),
                {
                  command: "pairCode.nativeAccepted",
                  title: "Accept Pair Edit",
                  arguments: [proposal],
                },
              );
              item.isInlineEdit = true;
              item.showInlineEditMenu = true;
              item.showRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length),
              );
              return {
                items: [item],
                commands: [
                  { command: "pairCode.accept", title: "Accept · ⌘Enter" },
                  { command: "pairCode.reject", title: "Reject" },
                ],
              };
            }
            const mode = this.configuration().get<string>(
              "inlineSuggestions",
              "manual",
            );
            if (
              mode === "off" ||
              this.assistance() === 0 ||
              (mode === "manual" &&
                inlineContext.triggerKind !==
                  vscode.InlineCompletionTriggerKind.Invoke) ||
              inlineContext.selectedCompletionInfo ||
              this.backendRunning ||
              this.proposal
            )
              return [];
            this.inlineJob?.abort();
            const controller = new AbortController();
            this.inlineJob = controller;
            const cancellation = token.onCancellationRequested(() =>
              controller.abort(),
            );
            const version = document.version;
            try {
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (
                controller.signal.aborted ||
                token.isCancellationRequested ||
                document.version !== version
              )
                return [];
              const captured = this.snapshot();
              if (
                !captured ||
                captured.uri !== document.uri.toString() ||
                captured.selection ||
                captured.cursor?.offset !== document.offsetAt(position)
              )
                return [];
              const provider = this.configuration().get<Provider>(
                "backend",
                "groq",
              );
              const key = await this.key(provider);
              if (!key) return [];
              const insertion = await requestInline({
                onTrace: (event) =>
                  this.trace.record({ ...event, type: "inline." + event.type }),
                provider,
                model: this.configuration().get(
                  `${provider}Model`,
                  DEFAULT_MODELS[provider],
                ),
                apiKey: key,
                assistanceLevel: this.assistance(),
                context: captured,
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(3500),
                ]),
              });
              if (
                !insertion ||
                controller.signal.aborted ||
                token.isCancellationRequested ||
                document.version !== version ||
                vscode.window.activeTextEditor?.document !== document ||
                !vscode.window.activeTextEditor.selection.active.isEqual(
                  position,
                )
              )
                return [];
              return [
                new vscode.InlineCompletionItem(
                  insertion,
                  new vscode.Range(position, position),
                ),
              ];
            } catch {
              return [];
            } finally {
              cancellation.dispose();
            }
          },
        },
      ),
      this.proposalChanges,
      this.lensChanges,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme === "file") this.editor = editor;
        else if (!vscode.window.visibleTextEditors.length)
          this.editor = undefined;
        if (this.editor)
          this.recentFiles = [
            vscode.workspace.asRelativePath(this.editor.document.uri),
            ...this.recentFiles.filter(
              (f) =>
                f !==
                vscode.workspace.asRelativePath(this.editor!.document.uri),
            ),
          ].slice(0, 8);
        if (this.proposal?.uri === editor?.document.uri.toString())
          void this.showProposal();
        this.scheduleContext();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (
          event.textEditor === vscode.window.activeTextEditor &&
          event.textEditor.document.uri.scheme === "file"
        )
          this.editor = event.textEditor;
        this.scheduleContext();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          /(?:^|[\\/])(?:\.pairignore|\.gitignore|\.ignore)$/.test(
            event.document.uri.fsPath,
          )
        )
          this.researchBriefs.clear();
        else this.researchBriefs.invalidate();
        if (this.codeRefs.some((r) => r.uri === event.document.uri.toString()))
          this.clearPointing();
        if (this.proposal?.uri === event.document.uri.toString()) {
          this.post({ type: "proposalStale" });
          this.proposalChanges.fire();
          this.lensChanges.fire();
          void vscode.commands.executeCommand(
            "setContext",
            "pairCode.hasProposal",
            false,
          );
          void vscode.commands.executeCommand(
            "editor.action.inlineSuggest.hide",
          );
        }
        this.scheduleContext();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() =>
        this.scheduleContext(),
      ),
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleContext()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pairCode")) {
          if (
            event.affectsConfiguration("pairCode.memoryEnabled") ||
            event.affectsConfiguration("pairCode.memoryHindsightEnabled") ||
            event.affectsConfiguration("pairCode.memoryEndpoint") ||
            event.affectsConfiguration("pairCode.shareEditorContext")
          )
            this.memory.changed();
          if (
            event.affectsConfiguration("pairCode.memoryEnabled") &&
            !this.configuration().get("memoryEnabled", true)
          ) {
            this.invalidateMemoryContext();
          }
          if (
            configurationRequiresCancellation((name) =>
              event.affectsConfiguration(name),
            )
          ) {
            this.inlineJob?.abort();
            this.clearPointing();
            this.cancel();
          }
          if (
            event.affectsConfiguration("pairCode.shareEditorContext") &&
            !this.configuration().get("shareEditorContext", true)
          ) {
            this.reject();
            this.focus = new FocusTimeline();
            this.invalidateMemoryContext();
            this.researchBriefs.clear();
            this.updateVoiceStatus("disconnected");
            this.post({ type: "stopVoice" });
          }
          if (event.affectsConfiguration("pairCode.inlineSuggestions")) {
            this.inlineJob?.abort();
            if (
              this.configuration().get<string>(
                "inlineSuggestions",
                "manual",
              ) === "off"
            )
              void vscode.commands.executeCommand(
                "editor.action.inlineSuggest.hide",
              );
          }
          if (event.affectsConfiguration("pairCode.assistanceLevel")) {
            this.inlineJob?.abort();
            if (this.assistance() === 0) this.reject(false);
            this.publishAssistance();
          }
          void this.publishConfiguration();
          this.scheduleContext();
        }
      }),
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        {
          onDidChangeCodeLenses: this.lensChanges.event,
          provideCodeLenses: (document) => {
            const proposal = this.proposal;
            if (
              !proposal ||
              document.uri.toString() !== proposal.uri ||
              document.version !== proposal.version
            )
              return [];
            const range = new vscode.Range(
              document.positionAt(proposal.start),
              document.positionAt(proposal.start),
            );
            return [
              new vscode.CodeLens(range, {
                command: "pairCode.accept",
                title: "✓ Accept  ⌘Enter",
              }),
              new vscode.CodeLens(range, {
                command: "pairCode.reject",
                title: "✕ Reject",
              }),
            ];
          },
        },
      ),
    );
  }
  private post(message: object): void {
    const data = message as Record<string, unknown>;
    if (data.type === "liveAppend" && this.conversationMode === "chat") return;
    if (
      [
        "liveAppend",
        "answer",
        "error",
        "proposal",
        "proposalApplied",
        "proposalRejected",
      ].includes(String(data.type))
    )
      this.trace.record({
        type: "application." + data.type,
        sessionToken: this.sessionToken,
        taskRevision: this.jobRevision,
        ...Object.fromEntries(
          Object.entries(data).filter(
            ([key]) => !["type", "newText", "oldText"].includes(key),
          ),
        ),
        ...(data.type === "proposal"
          ? {
              oldChars: data.oldChars ?? String(data.oldText ?? "").length,
              newChars: data.newChars ?? String(data.newText ?? "").length,
            }
          : {}),
      });
    void this.view?.webview.postMessage(message);
  }
  refreshIndex(): void {
    this.codeIndex.refresh();
  }
  async showTrace(): Promise<void> {
    this.trace.record({ type: "trace.opened" });
    await this.trace.flush();
    await vscode.window.showTextDocument(vscode.Uri.file(this.trace.file), {
      preview: true,
    });
  }
  private configuration() {
    return vscode.workspace.getConfiguration("pairCode");
  }
  private async key(
    provider: "openai" | "firecrawl" | Provider,
  ): Promise<string | undefined> {
    const environment = {
      openai: "OPENAI_API_KEY",
      groq: "GROQ_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      firecrawl: "FIRECRAWL_API_KEY",
    };
    return (
      (await this.context.secrets.get(`pairCode.${provider}`)) ||
      process.env[environment[provider]] ||
      (this.context.extensionMode === vscode.ExtensionMode.Development ||
      process.env.PAIR_CODE_PROJECT_ROOT
        ? await localKey(
            process.env.PAIR_CODE_PROJECT_ROOT
              ? vscode.Uri.joinPath(
                  vscode.Uri.file(process.env.PAIR_CODE_PROJECT_ROOT),
                  ".env",
                ).fsPath
              : vscode.Uri.joinPath(this.context.extensionUri, "..", ".env")
                  .fsPath,
            environment[provider],
          )
        : undefined)
    );
  }
  private assistance(): number {
    return assistanceLevel(this.configuration().get("assistanceLevel"));
  }
  private publishAssistance(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "zen.assistanceLevel",
      this.assistance(),
    );
    this.post({
      type: "liveAppend",
      sessionToken: this.sessionToken,
      delegationId: null,
      mode: "instructions",
      passiveKey: "assistanceStyle",
      content: voiceAssistanceInstructions(this.assistance()),
    });
  }
  private async publishConfiguration(): Promise<void> {
    void this.publishConversationAvailability();
    void vscode.commands.executeCommand(
      "setContext",
      "zen.assistanceLevel",
      this.assistance(),
    );
    this.post({ type: "indexStatus", ...this.codeIndex.status });
    const config = this.configuration();
    const provider = config.get<Provider>("backend", "groq");
    this.post({
      type: "configuration",
      provider,
      model: config.get(`${provider}Model`),
      voiceModel: "gpt-live-1",
      openaiReady: Boolean(await this.key("openai")),
      backendReady: Boolean(await this.key(provider)),
      shareContext: config.get("shareEditorContext", true),
      followPair: config.get("followPair", true),
      inlineMode: config.get("inlineSuggestions", "manual"),
      assistanceLevel: this.assistance(),
    });
  }
  private snapshot(): EditorContext | undefined {
    const editor = this.editor;
    if (
      !editor ||
      !this.configuration().get("shareEditorContext", true) ||
      !vscode.workspace.isTrusted
    )
      return undefined;
    const document = editor.document;
    if (
      document.uri.scheme !== "file" ||
      !vscode.workspace.getWorkspaceFolder(document.uri) ||
      isPrivatePath(document.uri.fsPath)
    )
      return undefined;
    const full = document.getText();
    const cursor = document.offsetAt(editor.selection.active);
    const selection = document.getText(editor.selection);
    if (selection.length > 12000) return undefined;
    const textStart = Math.max(
      0,
      Math.min(
        editor.selection.isEmpty
          ? cursor - 5000
          : document.offsetAt(editor.selection.start) - 2000,
        Math.max(0, full.length - 12000),
      ),
    );
    const text = full.slice(
      textStart,
      textStart + Math.max(12000, selection.length + 2000),
    );
    return {
      uri: document.uri.toString(),
      file: vscode.workspace.asRelativePath(document.uri),
      language: document.languageId,
      version: document.version,
      text,
      selection,
      textStart,
      cursor: {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
        offset: cursor,
      },
      visibleLines: editor.visibleRanges
        .slice(0, 3)
        .map((r) => ({ start: r.start.line + 1, end: r.end.line + 1 })),
      recentFiles: this.recentFiles,
      ...(this.proposal?.uri === document.uri.toString()
        ? {
            pendingEdit: {
              start: this.proposal.start,
              end: this.proposal.end,
              oldText: this.proposal.oldText.slice(0, 12000),
              newText: this.proposal.newText.slice(0, 12000),
              truncated:
                this.proposal.oldText.length > 12000 ||
                this.proposal.newText.length > 12000,
              status: canApplyProposal(
                this.proposal,
                document.uri.toString(),
                document.version,
                full,
              )
                ? ("awaiting_acceptance" as const)
                : ("stale" as const),
            },
          }
        : {}),
      selectionStart: document.offsetAt(editor.selection.start),
      selectionEnd: document.offsetAt(editor.selection.end),
      diagnostics: vscode.languages
        .getDiagnostics(document.uri)
        .slice(0, 8)
        .map(
          (diagnostic) =>
            `${diagnostic.range.start.line + 1}: ${diagnostic.message}`,
        ),
    };
  }
  private clearPointing(): void {
    for (const editor of vscode.window.visibleTextEditors)
      editor.setDecorations(this.pointing, []);
    this.pointed = undefined;
    this.codeRefs = [];
    this.referenceSignature = "";
    this.spokenFocus.reset();
  }
  private refreshReferences(context?: EditorContext): void {
    const signature = context ? `${context.uri}:${context.version}` : "none";
    if (signature === this.referenceSignature) return;
    this.clearPointing();
    this.referenceSignature = signature;
    if (context) this.codeRefs = bufferReferences(context);
    this.shareReferences();
  }
  private shareReferences(): void {
    const content = conciseVoiceContent(
      `Current verified code names for pointing (replaces older map): ${
        this.codeRefs
          .slice(0, 12)
          .map((r) => `${r.label} [say ${r.mentions.slice(0, 2).join(" / ")}]`)
          .join("; ") || "none"
      }. Use these exact names; delegate before explaining code not covered here. Names alone do not establish implementation behavior.`,
    );
    if (content === this.sharedReferenceContent) return;
    this.sharedReferenceContent = content;
    this.post({
      type: "liveAppend",
      sessionToken: this.sessionToken,
      delegationId: null,
      mode: "thinking",
      passiveKey: "codeReferences",
      content,
    });
  }
  private pointSpeech(event: LiveEvent): void {
    const snapshot = this.snapshot();
    this.refreshReferences(snapshot);
    if (!snapshot || this.proposal) return; // Preview lines are not yet real buffer locations.
    const refs = this.codeRefs.filter(
      (r) => r.uri === snapshot.uri && r.version === snapshot.version,
    );
    const ref = this.spokenFocus.append(event, refs);
    if (!ref || this.pointed === ref) return;
    const editor = this.editor;
    if (
      !editor ||
      editor.document.getText().slice(ref.start, ref.end) !== ref.quote
    )
      return;
    const range = new vscode.Range(
      editor.document.positionAt(ref.start),
      editor.document.positionAt(ref.end),
    );
    editor.setDecorations(this.pointing, [
      { range, hoverMessage: `Pair is discussing ${ref.label}` },
    ]);
    if (
      this.configuration().get("followPair", true) &&
      !editor.visibleRanges.some((r) => r.contains(range))
    )
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    this.pointed = ref;
    this.trace.record({
      type: "editor.pointed",
      file: snapshot.file,
      version: ref.version,
      label: ref.label,
      line: range.start.line + 1,
      transcriptEndMs: event.end_ms,
    });
  }
  private scheduleContext(): void {
    this.inlineJob?.abort();
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => this.publishContext(), 600);
  }
  private async publishConversationAvailability(): Promise<void> {
    const revision = ++this.checkpointAvailabilityRevision;
    const scope = await this.memory.scope(this.snapshot()?.uri);
    const checkpoint = await this.memory.checkpoint(scope);
    if (revision === this.checkpointAvailabilityRevision)
      this.post({
        type: "conversationAvailable",
        available: Boolean(checkpoint),
      });
  }
  private publishContext(urgent = false): void {
    void this.publishConversationAvailability();
    const snapshot = this.snapshot();
    this.refreshReferences(snapshot);
    const contextId = this.focus.record(snapshot);
    this.post({
      type: "context",
      workspace: vscode.workspace.name ?? "Your workspace",
      urgent,
      contextId,
      file: snapshot?.file ?? "No shared file",
      selectionLines: snapshot?.selection
        ? snapshot.selection.split("\n").length
        : 0,
      version: snapshot?.version,
      voiceContext: editorVoiceContext(snapshot),
    });
  }
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    const nonce = randomBytes(18).toString("hex");
    const media = (name: string) =>
      view.webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, "media", name),
        )
        .toString();
    const template = await readFile(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.html")
        .fsPath,
      "utf8",
    );
    view.webview.html = template
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", view.webview.cspSource)
      .replaceAll("{{css}}", media("panel.css"))
      .replaceAll("{{js}}", media("panel.js"))
      .replaceAll("{{protocol}}", media("live-protocol.js"));
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: PanelMessage) => {
        void this.handleMessage(message);
      }),
      view.onDidDispose(() => {
        this.cancel();
        this.sessionJob?.abort();
        this.sessionToken++;
        this.view = undefined;
        this.panelReady = false;
        this.pendingVoiceStart = false;
        this.updateVoiceStatus("disconnected");
      }),
    );
  }
  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      if (
        message.type === "conversationMode" &&
        (message.mode === "chat" || message.mode === "voice")
      ) {
        if (message.mode === "chat" && this.conversationMode !== "chat") {
          this.sessionToken++;
          this.sessionJob?.abort();
          this.sessionJob = undefined;
          this.pendingVoiceStart = false;
          this.cancel();
          this.clearPointing();
          this.updateVoiceStatus("disconnected");
        }
        this.conversationMode = message.mode;
        this.post({ type: "conversationMode", mode: this.conversationMode });
        this.publishTranscript();
        return;
      }
      if (
        message.type === "voiceState" &&
        message.sessionToken === this.sessionToken &&
        ["disconnected", "connecting", "listening", "muted"].includes(
          message.text ?? "",
        )
      ) {
        this.updateVoiceStatus(message.text!);
        return;
      }
      if (
        [
          "toggleTheme",
          "toggleWorkboard",
          "applyLayout",
          "manageMemory",
          "resumePairing",
          "freshPairing",
        ].includes(message.type)
      ) {
        await vscode.commands.executeCommand(`pairCode.${message.type}`);
        return;
      }
      if (message.type === "refreshIndex") {
        this.refreshIndex();
        return;
      }
      if (message.type === "showTrace") {
        await this.showTrace();
        return;
      }
      if (message.type === "clearResearch") {
        this.research = [];
        return;
      }
      if (message.type === "openSource" && typeof message.text === "string") {
        const url = publicWebUrl(message.text);
        if (!this.research.some((article) => article.url === url))
          throw new Error("This source is no longer in the research view.");
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      if (
        message.type === "shareContext" &&
        typeof message.enabled === "boolean"
      ) {
        await this.configuration().update(
          "shareEditorContext",
          message.enabled,
          vscode.ConfigurationTarget.Global,
        );
        return;
      }

      if (
        message.type === "followPair" &&
        typeof message.enabled === "boolean"
      ) {
        await this.configuration().update(
          "followPair",
          message.enabled,
          vscode.ConfigurationTarget.Global,
        );
        return;
      }
      if (
        message.type === "assistanceLevel" &&
        typeof message.level === "number" &&
        Number.isFinite(message.level)
      ) {
        await this.configuration().update(
          "assistanceLevel",
          assistanceLevel(message.level),
          vscode.ConfigurationTarget.Global,
        );
        return;
      }
      if (message.type === "liveUsage") {
        this.trace.record({
          type: "voice.usage",
          sessionToken: message.sessionToken,
          seconds: message.seconds,
          final: message.final,
        });
        return;
      }
      if (message.type === "ready") {
        this.post({ type: "researchHistory", articles: this.research });
        await this.publishConfiguration();
        this.post({ type: "conversationMode", mode: this.conversationMode });
        this.publishTranscript();
        this.publishContext();
        this.panelReady = true;
        if (this.pendingVoiceStart) {
          this.pendingVoiceStart = false;
          this.voiceControl("start");
        }
        return;
      }
      if (
        message.type === "contextAcknowledged" &&
        message.sessionToken === this.sessionToken &&
        typeof message.contextId === "number" &&
        typeof message.endMs === "number"
      ) {
        this.focus.acknowledge(message.contextId, message.endMs);
        this.trace.record({
          type: "voice.contextAcknowledged",
          sessionToken: this.sessionToken,
          contextId: message.contextId,
          endMs: message.endMs,
        });
        return;
      }
      if (
        message.type === "inlineMode" &&
        ["off", "manual", "automatic"].includes(message.mode ?? "")
      ) {
        await this.configuration().update(
          "inlineSuggestions",
          message.mode,
          vscode.ConfigurationTarget.Global,
        );
        return;
      }
      if (message.type === "configure") {
        await this.configureKeys();
        return;
      }
      if (
        message.type === "provider" &&
        ["groq", "cerebras"].includes(message.provider ?? "")
      ) {
        this.cancel();
        await this.configuration().update(
          "backend",
          message.provider,
          vscode.ConfigurationTarget.Global,
        );
        return;
      }
      if (message.type === "accept") {
        await this.accept();
        return;
      }
      if (message.type === "reject") {
        this.reject();
        return;
      }
      if (message.type === "cancel") {
        this.cancel();
        return;
      }
      if (
        message.type === "typed" &&
        typeof message.text === "string" &&
        message.text.trim()
      ) {
        if (this.conversationMode !== "chat") return;
        this.trace.record({ type: "conversation.typed", text: message.text });
        this.history.entries.push({
          role: "user",
          text: message.text.slice(0, 12000),
        });
        this.publishTranscript();
        await this.runBackend();
        this.publishTranscript();
        return;
      }
      if (message.type === "disconnect") {
        this.sessionToken++;
        this.sessionJob?.abort();
        this.cancel();
        this.updateVoiceStatus("disconnected");
        this.clearPointing();
        return;
      }
      if (
        message.type === "rpc" &&
        message.method === "createSession" &&
        typeof message.params?.sdp === "string"
      ) {
        if (this.conversationMode !== "voice")
          throw new Error("Switch to Voice before starting the microphone.");
        const key = await this.key("openai");
        if (!key) throw new Error("Configure your OpenAI API key first.");
        this.sessionJob?.abort();
        this.sessionJob = new AbortController();
        const token = ++this.sessionToken;
        this.cancel();
        this.seenDelegations.clear();
        this.clearPointing();
        const startupContext = this.snapshot();
        this.focus = new FocusTimeline();
        this.focus.seed(this.focus.record(startupContext));
        const previousHistory = this.history.snapshot();
        this.history.beginSession();
        this.trace.record({
          type: "voice.creating",
          sessionToken: token,
          file: startupContext?.file,
          version: startupContext?.version,
          historyMessages: previousHistory.length,
        });
        const startupMemories = await this.memory.reference(
          "coding preferences explanation pace",
          await this.memory.scope(startupContext?.uri),
        );
        const resumed = await this.resumeReference(
          await this.memory.scope(startupContext?.uri),
        );
        const result = await createLiveSession({
          apiKey: key,
          sdp: message.params.sdp,
          voice: this.configuration().get("voice", "marin"),
          instructions: voiceInstructions(
            Boolean(await this.key("firecrawl")),
            this.assistance(),
          ),
          editorContext: editorVoiceContext(startupContext),
          history: previousHistory,
          sessionReference: resumed,
          memory: startupMemories.map((r) => ({ kind: r.kind, text: r.text })),
          signal: this.sessionJob.signal,
        });
        if (token !== this.sessionToken) return;
        this.post({
          type: "rpcResult",
          id: message.id,
          result: { ...result, sessionToken: token },
        });
        return;
      }
      if (
        message.type === "liveEvent" &&
        message.sessionToken === this.sessionToken &&
        message.event
      ) {
        const event = message.event;
        this.trace.record({
          ...event,
          type: "voice.event",
          eventType: event.type,
          sessionToken: this.sessionToken,
        });
        if (event.type === "session.started") {
          this.researchBriefs.clear();
          this.targets.reset();
          this.sharedReferenceContent = "";
          this.publishAssistance();
          this.updateVoiceStatus("listening");
          this.clearPointing(); // Resend the map now that Live accepts appends.
          this.publishContext();
        }
        if (
          event.type === "session.input_transcript.delta" ||
          event.type === "session.output_transcript.delta"
        ) {
          this.history.append(event);
          this.publishTranscript();
        }
        if (event.type === "session.output_transcript.delta") {
          this.targets.endTurn();
          this.pointSpeech(event);
        }
        if (event.type === "session.input_transcript.delta") {
          this.targets.append(event, this.snapshot());
          this.spokenFocus.reset();
          this.publishContext(true);
        }
        if (event.type === "session.ended") this.clearPointing();
        if (
          event.type === "session.delegation.created" &&
          event.delegation?.target === "client" &&
          !this.seenDelegations.has(event.delegation.id)
        ) {
          this.seenDelegations.add(event.delegation.id);
          if (this.seenDelegations.size > 2000)
            this.seenDelegations.delete(
              this.seenDelegations.values().next().value!,
            );
          await this.runBackend(event.delegation.id, event.offset_ms);
        }
      }
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : "The pairing operation failed.";
      if (message.type === "rpc")
        this.post({ type: "rpcResult", id: message.id, error: text });
      else this.post({ type: "error", message: text });
    }
  }
  private async runBackend(
    delegationId?: string,
    offsetMs?: number,
  ): Promise<void> {
    this.backendJob?.abort();
    this.spokenFocus.reset();
    const controller = new AbortController();
    this.backendJob = controller;
    const revision = ++this.jobRevision;
    const token = this.sessionToken;
    const assistance = this.assistance();
    let context = this.snapshot();
    this.inlineJob?.abort();
    this.backendRunning = true;
    this.activeDelegation = delegationId;
    const provider = this.configuration().get<Provider>("backend", "groq");
    this.post({ type: "backendStatus", state: "working", provider });
    try {
      const key = await this.key(provider);
      if (!key) throw new Error(`Configure your ${provider} API key first.`);
      // Give fragments already in transit a brief opportunity to arrive; this is not turn detection.
      if (delegationId)
        await new Promise((resolve) => setTimeout(resolve, 180));
      if (controller.signal.aborted || revision !== this.jobRevision) return;
      const history = this.history.snapshot(offsetMs);
      if (delegationId && offsetMs !== undefined) {
        const captured = this.targets.resolve(offsetMs);
        if (captured) context = captured.context;
      }
      if (context) {
        // Preview acceptance is current application state, not delayed spoken reference data.
        const current = this.snapshot();
        context.pendingEdit =
          current?.uri === context.uri ? current.pendingEdit : undefined;
        delete context.focusChanged;
      }
      if (!history.some((entry) => entry.role === "user" && entry.text.trim()))
        throw new Error(
          "No user transcript has arrived yet. Please repeat your request.",
        );
      this.trace.record({
        type: "backend.started",
        assistanceLevel: assistance,
        taskRevision: revision,
        sessionToken: token,
        delegationId,
        offsetMs,
        provider,
        file: context?.file,
        version: context?.version,
        focusChanged: context?.focusChanged,
        researchBriefs: this.researchBriefs.snapshot().briefs.length,
        latestUser: history.filter((e) => e.role === "user").at(-1)?.text,
      });
      this.post({
        type: "liveAppend",
        sessionToken: token,
        delegationId: delegationId ?? null,
        mode: "thinking",
        content:
          "Silent task reference: backend work is running for the latest human request. This is background state, not a spoken update. Wait for the result; answer status only if the human asks.",
      });
      const memoryScope = await this.memory.scope(context?.uri);
      const latestHuman =
        history.filter((e) => e.role === "user").at(-1)?.text ?? "";
      const memoryReference = await this.memory.reference(
        latestHuman,
        memoryScope,
      );
      controller.signal.throwIfAborted();
      this.post({ type: "taskIntent", text: latestHuman.slice(0, 320) });
      const configuredEffort = this.configuration().get<string>(
        "reasoningEffort",
        "auto",
      );
      const effort =
        configuredEffort === "auto"
          ? await decideEffort({
              apiKey: await this.key("openai"),
              history,
              editor: context?.file,
              signal: controller.signal,
              onTrace: (event) =>
                this.trace.record({ ...event, taskRevision: revision }),
            })
          : (configuredEffort as Effort);
      const readTools = [
        ...workspaceTools(
          () => this.configuration().get("shareEditorContext", true),
          await this.key("firecrawl"),
        ),
        ...this.codeIndex.tools(),
      ];
      const explorer = explorationTool({
        researchReference: this.researchBriefs.snapshot(),
        onReport: (report, question, scope) => {
          if (
            !controller.signal.aborted &&
            revision === this.jobRevision &&
            token === this.sessionToken &&
            this.configuration().get("shareEditorContext", true)
          )
            this.researchBriefs.remember(question, scope, report);
        },
        timeoutMs:
          this.configuration().get<number>("backendTimeoutSeconds", 600) * 1000,
        provider,
        model: this.configuration().get(
          `${provider}Model`,
          DEFAULT_MODELS[provider],
        ),
        apiKey: key,
        context,
        tools: readTools,
        effort,
        onTrace: (event) =>
          this.trace.record({ ...event, taskRevision: revision }),
        onResearch: (article) => {
          this.research = [
            article,
            ...this.research.filter((a) => a.url !== article.url),
          ].slice(0, 8);
          this.post({ type: "research", article });
        },
        onProgress: (tool) =>
          this.post({
            type: "backendStatus",
            state: "working",
            provider,
            tool,
          }),
      });
      let result = await requestBackend({
        conversationMode: this.conversationMode,
        provider,
        model: this.configuration().get(
          `${provider}Model`,
          DEFAULT_MODELS[provider],
        ),
        apiKey: key,
        history,
        context,
        signal: controller.signal,
        effort,
        timeoutMs:
          this.configuration().get<number>("backendTimeoutSeconds", 600) * 1000,
        taskState: {
          personalMemory: memoryReference,
          previousPairing: await this.resumeReference(memoryScope),
          researchReference: this.researchBriefs.snapshot(),
          lastEditEvent: this.lastEditEvent,
          pendingPreview: this.proposal
            ? { file: this.proposal.uri, version: this.proposal.version }
            : null,
        },
        assistanceLevel: assistance,
        tools: [
          ...readTools,
          ...this.memory.tools(latestHuman, memoryScope),
          explorer,
          ...(context
            ? [
                {
                  name: "code_focus",
                  description:
                    "Register an exact unique code quote in the captured editor with its name and spoken aliases. Optional: use only for existing code, never future or proposed code. Use before explaining unfamiliar code so the editor can point as each name is spoken. Does not edit or move the human cursor. Current editor only.",
                  parameters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      quote: { type: "string" },
                      label: { type: "string" },
                      mentions: {
                        type: "array",
                        maxItems: 8,
                        items: { type: "string" },
                      },
                    },
                    required: ["quote", "label", "mentions"],
                  },
                  execute: async (
                    args: Record<string, unknown>,
                    signal: AbortSignal,
                  ) => {
                    signal.throwIfAborted();
                    const current = this.snapshot();
                    if (
                      !current ||
                      current.uri !== context!.uri ||
                      current.version !== context!.version ||
                      revision !== this.jobRevision
                    )
                      return {
                        registered: false,
                        reason:
                          "Target is not currently visible or has changed. Continue without pointing; the coding task is still valid.",
                      };
                    if (
                      typeof args.quote !== "string" ||
                      typeof args.label !== "string" ||
                      !Array.isArray(args.mentions) ||
                      args.mentions.some((m: unknown) => typeof m !== "string")
                    )
                      throw new Error("Invalid code focus arguments.");
                    let ref: CodeReference;
                    try {
                      ref = codeReference(
                        context!,
                        args.quote,
                        args.label,
                        args.mentions as string[],
                      );
                    } catch {
                      return {
                        registered: false,
                        reason:
                          "Quote is absent or ambiguous in existing buffer. Do not retry this quote or register proposed code; continue the task without pointing.",
                      };
                    }
                    this.refreshReferences(current);
                    this.codeRefs = [
                      ...this.codeRefs.filter((r) => r.start !== ref.start),
                      ref,
                    ].slice(-32);
                    this.shareReferences();
                    return {
                      registered: true,
                      file: current.file,
                      label: ref.label,
                      mentions: ref.mentions,
                      version: ref.version,
                    };
                  },
                },
              ]
            : []),
        ],
        onResearch: (article) => {
          if (revision !== this.jobRevision || controller.signal.aborted)
            return;
          this.research = [
            article,
            ...this.research.filter((a) => a.url !== article.url),
          ].slice(0, 8);
          this.post({ type: "research", article });
        },
        onTrace: (event) =>
          this.trace.record({
            ...event,
            taskRevision: revision,
            sessionToken: token,
            delegationId,
          }),
        onProgress: (tool) => {
          if (revision !== this.jobRevision || controller.signal.aborted)
            return;
          this.post({
            type: "backendStatus",
            state: "working",
            provider,
            tool,
          });
          // Tool activity stays in the UI/trace; injecting it into Live caused
          // repetitive spoken reassurance even through thinking.append.
        },
      });
      if (
        controller.signal.aborted ||
        revision !== this.jobRevision ||
        token !== this.sessionToken
      )
        return;
      if (result.status === "cancelled") this.reject();
      if (assistanceViolation(result, this.assistance())) {
        this.trace.record({
          type: "backend.style_changed",
          taskRevision: revision,
          from: assistance,
          to: this.assistance(),
        });
        const summary =
          "The pairing style changed while I was preparing that draft. No preview was added; I’ll use the new style for your next request.";
        result = { status: "answer", summary, speech: summary, edits: [] };
      }
      const proposal = context ? createProposal(context, result) : undefined;
      if (!context && result.edits.length)
        throw new Error(
          "Open a small file or select code before asking for an edit.",
        );
      this.trace.record({
        type: "backend.completed",
        taskRevision: revision,
        sessionToken: token,
        delegationId,
        status: result.status,
        summary: result.summary,
        speech: result.speech,
        edits: result.edits.length,
      });
      const checkpointId =
        result.status === "cancelled"
          ? undefined
          : await this.memory.saveCheckpoint(
              memoryScope,
              latestHuman,
              result.summary,
              proposal
                ? "preview_unapplied"
                : result.status === "clarification"
                  ? "clarification"
                  : "answer",
              context?.uri,
              controller.signal,
            );
      if (
        controller.signal.aborted ||
        revision !== this.jobRevision ||
        token !== this.sessionToken
      )
        return;
      if (checkpointId) {
        this.resumedCheckpoint = undefined;
        this.post({ type: "checkpointCleared" });
        void this.publishConversationAvailability();
      }
      if (proposal) {
        this.reject(false);
        this.proposalCheckpointId = checkpointId;
        this.proposal = proposal;
        void vscode.commands.executeCommand(
          "setContext",
          "pairCode.hasProposal",
          true,
        );
        await this.showProposal();
        if (
          controller.signal.aborted ||
          revision !== this.jobRevision ||
          token !== this.sessionToken
        )
          return;
        this.post({
          type: "proposal",
          oldChars: proposal.oldText.length,
          newChars: proposal.newText.length,
          summary: proposal.summary,
          file: context?.file,
          stale: !vscode.workspace.textDocuments.some(
            (d) =>
              d.uri.toString() === proposal.uri &&
              canApplyProposal(proposal, proposal.uri, d.version, d.getText()),
          ),
        });
      }
      if (proposal)
        this.post({
          type: "liveAppend",
          sessionToken: token,
          delegationId: delegationId ?? null,
          mode: "thinking",
          content: conciseVoiceContent(
            "Unapplied preview description, not a completed edit: " +
              result.summary,
          ),
        });
      this.post({
        type: "answer",
        text: result.summary,
        status: result.status,
        speech: result.speech,
      });
      if (!delegationId)
        this.history.entries.push({
          role: "assistant",
          text: proposal
            ? `${result.summary}\n\nAn inline preview was prepared in ${context?.file}. No code has been applied; it awaits human acceptance.`
            : result.summary,
        });
      this.post({
        type: "liveAppend",
        sessionToken: token,
        delegationId: delegationId ?? null,
        content: conciseVoiceContent(
          proposal
            ? `Proposed change in ${context?.file}: ${result.speech || result.summary}`
            : (result.status === "cancelled"
                ? "The coding request is canceled. "
                : "Backend result: ") + (result.speech || result.summary),
        ),
        mode: "commentary",
      });
      this.post({ type: "backendStatus", state: "idle", provider });
    } catch (error) {
      if (controller.signal.aborted || revision !== this.jobRevision) {
        this.trace.record({
          type: "backend.canceled",
          taskRevision: revision,
          sessionToken: token,
        });
        return;
      }
      const text =
        error instanceof Error ? error.message : "The code backend failed.";
      this.trace.record({
        type: "backend.failed",
        taskRevision: revision,
        sessionToken: token,
        delegationId,
        error: text,
        code: (error as { code?: string }).code,
      });
      this.post({ type: "error", message: text });
      this.post({ type: "backendStatus", state: "idle", provider });
      if (delegationId)
        this.post({
          type: "liveAppend",
          sessionToken: token,
          delegationId,
          content: conciseVoiceContent(
            `The application could not complete this backend request: ${text} No code was changed. This is an internal failure, not evidence that the question is too broad.`,
          ),
          mode: "commentary",
        });
    } finally {
      if (revision === this.jobRevision) {
        this.backendRunning = false;
        this.activeDelegation = undefined;
      }
    }
  }
  private async resumeReference(
    scope: string | undefined,
  ): Promise<string | undefined> {
    const selected = this.resumedCheckpoint;
    if (!scope || selected?.scope !== scope) return;
    const checkpoint = await this.memory.checkpoint(scope);
    if (
      !checkpoint ||
      this.resumedCheckpoint !== selected ||
      checkpoint.id !== selected.id
    )
      return;
    return JSON.stringify({
      previousRequest: checkpoint.task,
      previousResult: checkpoint.summary,
      editOutcome: checkpoint.outcome,
      recordedAt: checkpoint.updated,
      file: checkpoint.source?.path,
      fileChanged: checkpoint.fileChanged,
      instructionBoundary:
        "Historical reference only. Re-read current code. No old task is authorized to run, no preview is restored, accepted_unsaved is a historical buffer event, not proof of saved work or tests. Ask what to continue if unclear. Current instructions win.",
    });
  }
  async resumePairing(): Promise<boolean> {
    if (
      (this.sessionJob && !this.sessionJob.signal.aborted) ||
      this.backendRunning
    ) {
      await vscode.window.showInformationMessage(
        "Disconnect pairing and finish or cancel the current request before resuming another session.",
      );
      return false;
    }
    const token = this.sessionToken,
      revision = this.jobRevision;
    const scope = await this.memory.scope(this.snapshot()?.uri);
    const checkpoint = await this.memory.checkpoint(scope);
    if (token !== this.sessionToken || revision !== this.jobRevision)
      return false;
    if (!checkpoint || !scope) {
      await vscode.window.showInformationMessage(
        "No available checkpoint for this repository. Check memory/context sharing and the current file.",
      );
      return false;
    }
    this.cancel();
    this.history.entries = [];
    this.researchBriefs.clear();
    this.lastEditEvent = undefined;
    this.focus = new FocusTimeline();
    this.reject(false);
    this.resumedCheckpoint = { scope, id: checkpoint.id };
    this.post({
      type: "checkpointLoaded",
      task: checkpoint.task,
      fileChanged: checkpoint.fileChanged,
    });
    this.publishTranscript();
    return true;
  }
  async freshPairing(): Promise<void> {
    const scope = await this.memory.scope(this.snapshot()?.uri);
    if (scope) this.memory.clearCheckpoints(scope);
    this.resumedCheckpoint = undefined;
    this.cancel();
    this.sessionJob?.abort();
    this.sessionToken++;
    this.history.entries = [];
    this.researchBriefs.clear();
    this.lastEditEvent = undefined;
    this.focus = new FocusTimeline();
    this.reject(false);
    this.updateVoiceStatus("disconnected");
    this.post({ type: "stopVoice" });
    this.post({ type: "checkpointCleared" });
    this.publishTranscript();
    void this.publishConversationAvailability();
  }
  private invalidateMemoryContext(): void {
    this.resumedCheckpoint = undefined;
    try {
      this.memory.clearCheckpoints();
    } catch {
      /* Privacy cancellation must still proceed. Status reports persistence failure. */
    }
    this.post({ type: "checkpointCleared" });
    this.publishTranscript();
    void this.publishConversationAvailability();
    this.cancel();
    this.sessionJob?.abort();
    this.sessionToken++;
    this.history.entries = [];
    this.updateVoiceStatus("disconnected");
    this.post({ type: "stopVoice" });
  }
  async manageMemory(): Promise<void> {
    await this.memory.manage();
  }
  cancel(): void {
    if (this.backendRunning)
      this.post({
        type: "liveAppend",
        sessionToken: this.sessionToken,
        delegationId: this.activeDelegation ?? null,
        mode: "thinking",
        content:
          "The application canceled the pending backend request. No generated edit was applied.",
      });
    this.backendRunning = false;
    this.activeDelegation = undefined;
    this.jobRevision++;
    this.backendJob?.abort();
    this.backendJob = undefined;
    this.post({ type: "backendStatus", state: "idle" });
  }
  private renderProposal(): void {
    this.lensChanges.fire();
    this.proposalChanges.fire();
  }
  async previewEdit(result: BackendResult): Promise<void> {
    const context = this.snapshot();
    if (!context)
      throw new Error("Open a shared file before requesting an edit.");
    const proposal = createProposal(
      context,
      parseBackendResult(JSON.stringify(result)),
    );
    if (!proposal) return;
    this.reject(false);
    this.proposal = proposal;
    await this.showProposal();
  }
  private async showProposal(): Promise<void> {
    this.clearPointing();
    const proposal = this.proposal;
    if (!proposal) return;
    const document = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === proposal.uri,
    );
    if (
      !document ||
      !canApplyProposal(
        proposal,
        proposal.uri,
        document.version,
        document.getText(),
      )
    ) {
      this.post({ type: "proposalStale" });
      return;
    }
    if (vscode.window.activeTextEditor?.document !== document) {
      this.renderProposal();
      return;
    }
    if (
      this.proposal !== proposal ||
      !canApplyProposal(
        proposal,
        proposal.uri,
        document.version,
        document.getText(),
      )
    )
      return;
    await vscode.commands.executeCommand(
      "setContext",
      "pairCode.hasProposal",
      true,
    );
    this.renderProposal();
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    this.publishContext();
  }
  nativeAccepted(proposal: Proposal): void {
    if (
      !this.proposal ||
      this.proposal.uri !== proposal.uri ||
      this.proposal.version !== proposal.version ||
      this.proposal.start !== proposal.start ||
      this.proposal.newText !== proposal.newText
    )
      return;
    const document = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === proposal.uri,
    );
    if (
      !document ||
      document.version !== proposal.version + 1 ||
      document
        .getText()
        .slice(proposal.start, proposal.start + proposal.newText.length) !==
        proposal.newText
    )
      return;
    this.finishAcceptance();
  }
  private finishAcceptance(): void {
    this.memory.checkpointOutcome(
      this.proposalCheckpointId,
      "accepted_unsaved",
    );
    this.lastEditEvent = {
      status: "accepted_unsaved",
      file: this.proposal?.uri,
    };
    this.history.entries.push({
      role: "assistant",
      text: `Application result: the human accepted the inline preview in ${this.proposal?.uri}; it was applied to the editor buffer and is unsaved.`,
    });
    this.trace.record({ type: "edit.accepted", file: this.proposal?.uri });
    this.reject(false);
    this.refreshReferences(this.snapshot());
    this.post({ type: "proposalApplied" });
    this.post({
      type: "liveAppend",
      sessionToken: this.sessionToken,
      delegationId: null,
      mode: "thinking",
      content:
        "The human accepted the proposal. The editor applied it successfully. It is unsaved and can be undone normally.",
    });
  }
  async accept(): Promise<void> {
    const proposal = this.proposal;
    if (!proposal) return;
    const document = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === proposal.uri,
    );
    if (
      !document ||
      !canApplyProposal(
        proposal,
        document.uri.toString(),
        document.version,
        document.getText(),
      )
    ) {
      this.post({ type: "proposalStale" });
      throw new Error(
        "The file changed after this proposal. Request a fresh edit; your work has been preserved.",
      );
    }
    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false,
    });
    // Recheck after awaiting editor activation; no await between validation and editor.edit.
    if (
      !canApplyProposal(
        proposal,
        document.uri.toString(),
        document.version,
        document.getText(),
      )
    )
      throw new Error("The proposal became stale. Request a fresh edit.");
    const applied = await editor.edit(
      (builder) =>
        builder.replace(
          new vscode.Range(
            document.positionAt(proposal.start),
            document.positionAt(proposal.end),
          ),
          proposal.newText,
        ),
      { undoStopBefore: true, undoStopAfter: true },
    );
    if (!applied) throw new Error("The editor could not apply this proposal.");
    this.finishAcceptance();
  }
  reject(notify = true): void {
    if (notify && this.proposal) {
      this.memory.checkpointOutcome(this.proposalCheckpointId, "rejected");
      this.lastEditEvent = { status: "rejected", file: this.proposal.uri };
      this.history.entries.push({
        role: "assistant",
        text: `Application result: the human rejected the inline preview in ${this.proposal.uri}; no proposed code was applied.`,
      });
      this.trace.record({ type: "edit.rejected", file: this.proposal.uri });
      this.post({
        type: "liveAppend",
        sessionToken: this.sessionToken,
        delegationId: null,
        mode: "thinking",
        content:
          "The human rejected the inline preview. No proposed code was applied. Do not report that edit as completed.",
      });
    }
    this.proposal = undefined;
    this.proposalCheckpointId = undefined;
    this.renderProposal();
    this.scheduleContext();
    void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
    void vscode.commands.executeCommand(
      "setContext",
      "pairCode.hasProposal",
      false,
    );
    if (notify) this.post({ type: "proposalRejected" });
  }
  async configureKeys(): Promise<void> {
    const provider = await vscode.window.showQuickPick(
      [
        {
          label: "OpenAI",
          value: "openai" as const,
          description: "GPT-Live voice",
        },
        { label: "Groq", value: "groq" as const, description: "Code backend" },
        {
          label: "Firecrawl",
          value: "firecrawl" as const,
          description: "Public web search and page reading",
        },
        {
          label: "Cerebras",
          value: "cerebras" as const,
          description: "Code backend",
        },
      ],
      {
        title: "Pair Code · API Key",
        placeHolder: "Stored in the editor’s encrypted SecretStorage",
      },
    );
    if (!provider) return;
    const value = await vscode.window.showInputBox({
      title: `Pair Code · ${provider.label} API Key`,
      password: true,
      prompt: "Paste the key. Leave empty to remove the saved key.",
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim())
      await this.context.secrets.store(
        `pairCode.${provider.value}`,
        value.trim(),
      );
    else await this.context.secrets.delete(`pairCode.${provider.value}`);
    await this.publishConfiguration();
  }
  async suggest(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: "Pair with This Code",
      placeHolder: "Simplify this function without changing behavior…",
    });
    if (!text?.trim()) return;
    await vscode.commands.executeCommand("pairCode.open");
    this.trace.record({ type: "conversation.typed", text });
    this.history.entries.push({ role: "user", text });
    this.post({ type: "typedEcho", text });
    await this.runBackend();
  }
  dispose(): void {
    void vscode.commands.executeCommand("setContext", "zen.available", false);
    clearTimeout(this.contextTimer);
    this.cancel();
    this.inlineJob?.abort();
    this.sessionJob?.abort();
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<{
  previewEdit: (result: BackendResult) => Promise<void>;
}> {
  const companion = new Companion(context);
  await vscode.commands.executeCommand(
    "setContext",
    "zen.available",
    vscode.workspace.isTrusted,
  );
  context.subscriptions.push(
    companion,
    vscode.window.registerWebviewViewProvider("pairCode.companion", companion, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pairCode.startVoice", () =>
      companion.startVoice(),
    ),
    vscode.commands.registerCommand("pairCode.chooseAssistance", () =>
      companion.chooseAssistance(),
    ),
    vscode.commands.registerCommand("pairCode.toggleVoiceMute", () =>
      companion.voiceControl("mute"),
    ),
    vscode.commands.registerCommand("pairCode.endVoice", () =>
      companion.voiceControl("end"),
    ),
    vscode.commands.registerCommand("pairCode.resumePairing", async () => {
      if (await companion.resumePairing()) await companion.beginConversation();
    }),
    vscode.commands.registerCommand("pairCode.freshPairing", async () => {
      await companion.freshPairing();
      await companion.beginConversation();
    }),
    vscode.commands.registerCommand("pairCode.manageMemory", () =>
      companion.manageMemory(),
    ),
    vscode.commands.registerCommand("pairCode.toggleTheme", async () => {
      const light = [
        vscode.ColorThemeKind.Light,
        vscode.ColorThemeKind.HighContrastLight,
      ].includes(vscode.window.activeColorTheme.kind);
      await vscode.workspace
        .getConfiguration("workbench")
        .update(
          "colorTheme",
          light ? "Zen Dark" : "Zen Light",
          vscode.ConfigurationTarget.Global,
        );
    }),
    vscode.commands.registerCommand("pairCode.toggleWorkboard", () =>
      vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar"),
    ),
    vscode.commands.registerCommand("pairCode.applyLayout", async () => {
      const defaults = context.extension.packageJSON.contributes
        .configurationDefaults as Record<string, unknown>;
      // A deliberate appearance action, preserving the currently selected light/dark theme.
      for (const [key, value] of Object.entries(defaults)) {
        if (key === "workbench.colorTheme") continue;
        await vscode.workspace
          .getConfiguration()
          .update(key, value, vscode.ConfigurationTarget.Global);
      }
    }),
    vscode.commands.registerCommand("pairCode.refreshIndex", () =>
      companion.refreshIndex(),
    ),
    vscode.commands.registerCommand("pairCode.showTrace", () =>
      companion.showTrace(),
    ),
    vscode.commands.registerCommand("pairCode.inline", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"),
    ),
    vscode.commands.registerCommand("pairCode.open", () =>
      vscode.commands.executeCommand("pairCode.companion.focus"),
    ),
    vscode.commands.registerCommand("pairCode.configure", () =>
      companion.configureKeys(),
    ),
    vscode.commands.registerCommand(
      "pairCode.nativeAccepted",
      (proposal: Proposal) => companion.nativeAccepted(proposal),
    ),
    vscode.commands.registerCommand("pairCode.accept", () =>
      companion.accept(),
    ),
    vscode.commands.registerCommand("pairCode.reject", () =>
      companion.reject(),
    ),
    vscode.commands.registerCommand("pairCode.cancel", () =>
      companion.cancel(),
    ),
    vscode.commands.registerCommand("pairCode.suggest", () =>
      companion.suggest(),
    ),
  );
  if (!context.globalState.get("pairCode.firstLayout")) {
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand("pairCode.open");
    const terminal = vscode.window.createTerminal({ name: "Terminal" });
    terminal.show(true);
    await context.globalState.update("pairCode.firstLayout", true);
  }
  return { previewEdit: (result) => companion.previewEdit(result) };
}
