import "vscode";
declare module "vscode" {
  interface TextDocumentChangeEvent {
    readonly detailedReason:
      | {
          readonly source: string;
          readonly metadata: Readonly<Record<string, unknown>>;
        }
      | undefined;
  }
}
