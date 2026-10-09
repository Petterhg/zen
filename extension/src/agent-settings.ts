import {
  Definitions,
  parseAgentMarkdown,
  agentMarkdown,
} from "./definitions.js";
import { Automation } from "./automation.js";
import { BUILTIN_TOOLS, commandTool, toolRevision } from "./tool-registry.js";
import { readFile, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { RESEARCH_MODELS } from "./subagents.js";

/** Dedicated settings surface. Secrets and provider calls remain in the host. */
export class AgentSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  constructor(
    private context: vscode.ExtensionContext,
    private configureKeys: () => Promise<void>,
    private togetherKey: () => Promise<string | undefined>,
    private definitions: Definitions,
    private automation: Automation,
    private changed: () => void,
    private builtinCatalog: () => {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[],
  ) {}
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel(
      "zen.agentSettings",
      "Zen · Agent settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [media],
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message))
        return;
      const data = message as Record<string, unknown>;
      try {
        if (data.type === "ready") await this.publish();
        else if (data.type === "configureKeys") {
          await this.configureKeys();
          await this.publish(false);
        } else if (data.type === "save") {
          await this.definitions.saveAgents(data.agents, String(data.revision));
          this.changed();
          await this.publish();
          void panel.webview.postMessage({
            type: "saved",
            text: "Saved. New runs use these definitions; tool permissions update during active runs.",
          });
        } else if (data.type === "saveTool") {
          await this.definitions.saveTool(
            JSON.parse(String(data.definition)),
            String(data.revision),
          );
          await this.publish();
        } else if (data.type === "deleteTool") {
          await this.definitions.deleteTool(
            String(data.name),
            String(data.revision),
          );
          await this.publish();
        } else if (data.type === "savePolicy") {
          await this.definitions.savePolicy(
            {
              ...this.definitions.policy,
              disabled: data.disabled as string[],
              mainTools: data.mainTools as string[],
            },
            String(data.revision),
          );
          await this.publish();
        } else if (data.type === "grant") {
          await this.definitions.reload();
          if (data.revision !== this.definitions.revision)
            throw new Error(
              "Definition changed. Reload before granting execution.",
            );
          const tool = this.definitions.tools[String(data.name)];
          if (!tool) throw new Error("Tool no longer exists.");
          const answer = await vscode.window.showWarningMessage(
            `Allow ${tool.name} to run local commands?`,
            {
              modal: true,
              detail: `Command: ${JSON.stringify(tool.runtime.command)}\nThis is NOT sandboxed. It can access files and network as your account. The worktree only isolates intended code edits. Provider keys are not inherited, but this is not a security boundary. Only enable code you trust.`,
            },
            "Allow local execution",
          );
          if (answer === "Allow local execution")
            await this.definitions.savePolicy(
              {
                ...this.definitions.policy,
                commandGrants: {
                  ...this.definitions.policy.commandGrants,
                  [tool.name]: toolRevision(tool),
                },
              },
              String(data.revision),
            );
          await this.publish();
        } else if (data.type === "revoke") {
          const grants = { ...this.definitions.policy.commandGrants };
          delete grants[String(data.name)];
          await this.definitions.savePolicy(
            { ...this.definitions.policy, commandGrants: grants },
            String(data.revision),
          );
          await this.publish();
        } else if (data.type === "definitions") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(this.definitions.folder),
          );
        } else if (data.type === "import") {
          const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "Agent or tool definition": ["md", "json"] },
          });
          if (!files?.[0]) return;
          const text = await readFile(files[0].fsPath, "utf8");
          if (files[0].fsPath.endsWith(".md")) {
            const agent = parseAgentMarkdown(text);
            const id = await vscode.window.showInputBox({
              prompt: "New agent ID (lowercase letters, numbers, hyphens)",
              value: "imported-agent",
            });
            if (!id) return;
            if (Object.hasOwn(this.definitions.agents, id))
              throw new Error("Agent ID already exists.");
            await this.definitions.saveAgents(
              {
                ...this.definitions.agents,
                [id]: { ...agent, enabled: false, orientation: false },
              },
              this.definitions.revision,
            );
          } else {
            const tool = commandTool(JSON.parse(text));
            if (Object.hasOwn(this.definitions.tools, tool.name))
              throw new Error(
                "Tool already exists. Edit it explicitly instead.",
              );
            await this.definitions.saveTool(tool, this.definitions.revision);
          }
          this.changed();
          await this.publish();
        } else if (data.type === "export") {
          const entries = [
            ...Object.keys(this.definitions.agents).map((id) => ({
              label: id + ".md",
              text: agentMarkdown(this.definitions.agents[id]),
            })),
            ...Object.values(this.definitions.tools).map((t) => ({
              label: t.name + ".json",
              text: JSON.stringify(t, null, 2),
            })),
          ];
          const chosen = await vscode.window.showQuickPick(entries);
          if (!chosen) return;
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(chosen.label),
          });
          if (uri) await writeFile(uri.fsPath, chosen.text, { mode: 0o600 });
        } else if (data.type === "testTool") {
          const name = String(data.name);
          const tool = this.definitions.tools[name];
          if (!tool) throw new Error("Save the tool before testing.");
          const profile = {
            ...Object.values(this.definitions.agents)[0],
            tools: [name],
            workspace: "isolated-worktree" as const,
          };
          // Test uses main assignment temporarily only through its captured profile and explicit host gate.
          if (!this.definitions.policy.mainTools.includes(name))
            throw new Error(
              "Assign this tool to Main and save before testing.",
            );
          const controller = new AbortController();
          const disposal = panel.onDidDispose(() => controller.abort());
          const environment = await this.automation.prepare(
            "main",
            profile,
            [],
            controller.signal,
          );
          try {
            const executable = environment.tools.find((t) => t.name === name);
            if (!executable)
              throw new Error("Tool is disabled or not approved.");
            const output = await executable.execute(
              JSON.parse(String(data.input)),
              controller.signal,
            );
            void panel.webview.postMessage({
              type: "testResult",
              output: JSON.stringify(output, null, 2),
              history: this.automation.history,
            });
          } finally {
            disposal.dispose();
            await environment.dispose();
          }
        }
      } catch (error) {
        void panel.webview.postMessage({
          type: "error",
          text:
            error instanceof Error
              ? error.message
              : "Could not save agent settings.",
        });
      }
    });
    void (async () => {
      const nonce = randomBytes(18).toString("base64");
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(media, "agents.html"),
      );
      if (this.panel !== panel) return;
      panel.webview.html = Buffer.from(bytes)
        .toString("utf8")
        .replaceAll("{{cspSource}}", panel.webview.cspSource)
        .replaceAll("{{nonce}}", nonce)
        .replaceAll(
          "{{css}}",
          panel.webview
            .asWebviewUri(vscode.Uri.joinPath(media, "agents.css"))
            .toString(),
        )
        .replaceAll(
          "{{js}}",
          panel.webview
            .asWebviewUri(vscode.Uri.joinPath(media, "agents.js"))
            .toString(),
        );
    })().catch(() =>
      vscode.window.showErrorMessage("Could not open Zen Agent settings."),
    );
  }
  private async publish(profiles = true): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    await this.definitions.reload();
    const togetherReady = Boolean(await this.togetherKey());
    if (this.panel !== panel) return;
    void panel.webview.postMessage({
      type: "settings",
      ...(profiles
        ? {
            agents: this.definitions.agents,
            tools: this.definitions.tools,
            builtin: BUILTIN_TOOLS,
            contracts: this.builtinCatalog().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
              runtime: { type: "builtin" },
            })),
            policy: this.definitions.policy,
          }
        : {}),
      revision: this.definitions.revision,
      models: RESEARCH_MODELS,
      togetherReady,
      grants: Object.values(this.definitions.tools)
        .filter((t) => this.definitions.granted(t))
        .map((t) => t.name),
      history: this.automation.history,
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
