export type SemanticSymbolSource = 'tree-sitter' | 'ctags' | 'lsp';

export interface SemanticSymbol {
  path: string;
  hash: string;
  language: string;
  name: string;
  kind: string;
  source: SemanticSymbolSource;
  startLine: number;
  endLine: number | null;
  containerName?: string | null;
}

export type SemanticEdgeKind = 'definition' | 'reference' | 'call';

export interface SemanticEdge {
  sourcePath: string;
  sourceHash: string;
  targetPath: string;
  targetHash: string | null;
  kind: SemanticEdgeKind;
  symbolName: string;
  sourceLine: number;
  targetLine: number | null;
  provider: 'lsp' | 'tree-sitter';
}
