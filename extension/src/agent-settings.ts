import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { researchAgents, agentRegistry, RESEARCH_MODELS } from "./subagents.js";

/** Dedicated settings surface. Secrets and provider calls remain in the host. */
export class AgentSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  constructor(
    private context: vscode.ExtensionContext,
    private configureKeys: () => Promise<void>,
    private togetherKey: () => Promise<string | undefined>,
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
          const current = vscode.workspace
            .getConfiguration("pairCode")
            .inspect("subagents")?.globalValue;
          if (data.revision !== JSON.stringify(current ?? null))
            throw new Error(
              "Agent settings changed in another view. Reload saved settings before saving your edits.",
            );
          const agents = researchAgents({ version: 2, agents: data.agents });
          await vscode.workspace
            .getConfiguration("pairCode")
            .update(
              "subagents",
              agentRegistry(agents),
              vscode.ConfigurationTarget.Global,
            );
          await this.publish();
          void panel.webview.postMessage({
            type: "saved",
            text: "Saved. Applies to new work; current speech and foreground research continue.",
          });
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
    let agents, error;
    try {
      agents = researchAgents(
        vscode.workspace.getConfiguration("pairCode").inspect("subagents")
          ?.globalValue,
      );
    } catch {
      agents = researchAgents(undefined);
      error =
        "Stored profiles are invalid. Correct them here and save to replace them.";
    }
    const togetherReady = Boolean(await this.togetherKey());
    if (this.panel !== panel) return;
    void panel.webview.postMessage({
      type: "settings",
      ...(profiles ? { agents } : {}),
      revision: JSON.stringify(
        vscode.workspace.getConfiguration("pairCode").inspect("subagents")
          ?.globalValue ?? null,
      ),
      models: RESEARCH_MODELS,
      togetherReady,
      error,
    });
  }
  dispose(): void {
    this.panel?.dispose();
  }
}
