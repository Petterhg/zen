import Parser from "web-tree-sitter";
import path from "node:path";
import { createHash } from "node:crypto";
export const INDEX_VERSION = "v1-small-768-chunks1";
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface CodeChunk {
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentStart: number;
  parentEnd: number;
  text: string;
  header: string;
}
const grammars: Record<string, string> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};
const declarations =
  /^(function_definition|function_declaration|method_definition|method_declaration|class_definition|class_declaration|interface_declaration|type_alias_declaration|lexical_declaration|decorated_definition)$/;
let initialization: Promise<void> | undefined;
/** Syntax boundaries keep methods intact; fallback ranges cover every source line. */
export class CodeChunker {
  private languages = new Map<string, Promise<Parser.Language>>();
  constructor(private grammarDirectory: string) {}
  async chunks(file: string, source: string): Promise<CodeChunk[]> {
    const lines = source.split("\n");
    const result: CodeChunk[] = [];
    const emit = (
      start: number,
      end: number,
      symbol: string,
      kind: string,
      ps: number,
      pe: number,
      header: string,
    ) => {
      let first = start,
        bytes = 0;
      const flush = (last: number) => {
        const text = lines.slice(first, last).join("\n");
        // A huge generated/minified line is deliberately outside the index.
        if (text.trim() && Buffer.byteLength(text) <= 6000)
          result.push({
            symbol,
            kind,
            startLine: first + 1,
            endLine: last,
            parentStart: ps + 1,
            parentEnd: pe,
            text,
            header,
          });
        first = last;
        bytes = 0;
      };
      for (let i = start; i < end; i++) {
        const n = Buffer.byteLength(lines[i] ?? "") + 1;
        if (bytes + n > 3200 && i > first) flush(i);
        bytes += n;
      }
      if (first < end) flush(end);
    };
    const language = grammars[path.extname(file).toLowerCase()];
    if (language) {
      initialization ??= Parser.init();
      await initialization;
      let loading = this.languages.get(language);
      if (!loading) {
        loading = Parser.Language.load(
          path.join(this.grammarDirectory, `tree-sitter-${language}.wasm`),
        );
        this.languages.set(language, loading);
      }
      const parser = new Parser();
      let tree: Parser.Tree | null = null;
      try {
        parser.setLanguage(await loading);
        tree = parser.parse(source);
        const visit = (node: Parser.SyntaxNode, parent?: Parser.SyntaxNode) => {
          const start = node.startPosition.row;
          const end = Math.min(
            lines.length,
            node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0),
          );
          const name =
            node.childForFieldName("name")?.text ??
            parent?.childForFieldName("name")?.text ??
            "";
          const children = node.namedChildren.filter((c) =>
            declarations.test(c.type),
          );
          // Python class/function bodies wrap their declarations in a block.
          for (const c of node.namedChildren.filter((c) =>
            /^(block|class_body|statement_block|export_statement)$/.test(
              c.type,
            ),
          ))
            children.push(
              ...c.namedChildren.filter((n) => declarations.test(n.type)),
            );
          const isClass = /class/.test(node.type);
          const large = Buffer.byteLength(node.text) > 3200;
          if (
            children.length &&
            (node.id === tree!.rootNode.id || isClass || large)
          ) {
            children.sort((a, b) => a.startIndex - b.startIndex);
            let cursor = start;
            for (const child of children) {
              if (child.startPosition.row > cursor)
                emit(
                  cursor,
                  child.startPosition.row,
                  name,
                  "context",
                  start,
                  end,
                  lines[start]?.slice(0, 300) ?? "",
                );
              visit(child, node);
              cursor =
                child.endPosition.row + (child.endPosition.column > 0 ? 1 : 0);
            }
            if (cursor < end)
              emit(
                cursor,
                end,
                name,
                "context",
                start,
                end,
                lines[start]?.slice(0, 300) ?? "",
              );
          } else
            emit(
              start,
              end,
              name,
              node.type,
              parent?.startPosition.row ?? start,
              parent ? Math.min(lines.length, parent.endPosition.row + 1) : end,
              [
                parent && parent.id !== tree!.rootNode.id
                  ? lines[parent.startPosition.row]
                  : "",
                lines[start],
              ]
                .filter(Boolean)
                .join("\n")
                .slice(0, 600),
            );
        };
        visit(tree.rootNode);
      } finally {
        tree?.delete();
        parser.delete();
      }
    } else {
      // Markdown headings / HCL resource blocks / generic text remain searchable.
      const boundaries = [0];
      for (let i = 1; i < lines.length; i++)
        if (
          /^#{1,6} |^(?:resource|module|data|variable|output|provider)\s+"/.test(
            lines[i],
          )
        )
          boundaries.push(i);
      boundaries.push(lines.length);
      for (let i = 0; i < boundaries.length - 1; i++)
        emit(
          boundaries[i],
          boundaries[i + 1],
          "",
          "section",
          boundaries[i],
          boundaries[i + 1],
          lines[boundaries[i]].slice(0, 300),
        );
    }
    return result;
  }
}
