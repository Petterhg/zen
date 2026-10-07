// Subset of the proposed API in our pinned Code-OSS 1.135 runtime.
// See .upstream/code-oss/src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts.
import "vscode";
declare module "vscode" {
  interface InlineCompletionItem {
    isInlineEdit?: boolean;
    showInlineEditMenu?: boolean;
    showRange?: Range;
  }
  interface InlineCompletionItemProvider {
    readonly onDidChange?: Event<void>;
  }
}
