/**
 * 调用图构建器
 *
 * 从调用站点构建 semantic_edges 表的 'call' 类型边。
 * Phase 1: 本地调用解析（同文件内符号查找）
 */

import type Database from 'better-sqlite3';
import type { CallSite } from './treeSitterCalls.js';
import type { SemanticEdge } from './types.js';

export interface BuildCallGraphInput {
  db: Database.Database;
  files: Array<{
    path: string;
    hash: string;
    callSites: CallSite[];
  }>;
}

interface SymbolRow {
  path: string;
  hash: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number | null;
}

/**
 * 查询指定文件的所有符号定义
 */
function queryLocalSymbols(db: Database.Database, filePath: string): SymbolRow[] {
  const stmt = db.prepare<[string]>(`
    SELECT path, hash, name, kind, start_line, end_line
    FROM semantic_symbols
    WHERE path = ?
      AND kind IN ('function', 'method', 'class', 'interface')
    ORDER BY start_line
  `);

  return stmt.all(filePath) as SymbolRow[];
}

/**
 * 匹配调用站点到符号定义
 *
 * 策略：
 * 1. 精确匹配函数名
 * 2. 如果有多个同名符号，选择最近的（作用域启发式）
 */
function matchCallToSymbol(call: CallSite, symbols: SymbolRow[]): SymbolRow | null {
  // 过滤匹配名称的符号
  const candidates = symbols.filter((s) => s.name === call.calleeName);

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  // 多个候选：选择定义位置最接近调用位置的（简单启发式）
  // 优先选择在调用之前定义的符号
  const before = candidates.filter((s) => s.start_line < call.line);
  if (before.length > 0) {
    return before[before.length - 1]; // 最近的前置定义
  }

  // 如果没有前置定义，选择第一个（可能是类方法等）
  return candidates[0];
}

/**
 * 构建调用图（Phase 1: 本地调用解析）
 *
 * 从调用站点提取边，仅解析同文件内的调用关系。
 */
export function buildCallGraph(input: BuildCallGraphInput): SemanticEdge[] {
  const edges: SemanticEdge[] = [];

  for (const file of input.files) {
    // 查询本文件的所有符号定义
    const localSymbols = queryLocalSymbols(input.db, file.path);

    if (localSymbols.length === 0) {
      // 文件没有符号定义，跳过
      continue;
    }

    // 处理每个调用站点
    for (const call of file.callSites) {
      const target = matchCallToSymbol(call, localSymbols);

      if (target) {
        edges.push({
          sourcePath: file.path,
          sourceHash: file.hash,
          targetPath: target.path, // Phase 1: 始终是同文件
          targetHash: target.hash,
          kind: 'call',
          symbolName: call.calleeName,
          sourceLine: call.line,
          targetLine: target.start_line,
          provider: 'tree-sitter',
        });
      }
      // 未匹配的调用：可能是跨文件调用、外部库调用、动态调用等
      // Phase 1 暂不处理
    }
  }

  return edges;
}

/**
 * 批量构建并存储调用图
 */
export function buildAndStoreCallGraph(
  db: Database.Database,
  files: Array<{
    path: string;
    hash: string;
    callSites: CallSite[];
  }>,
): number {
  if (files.length === 0) {
    return 0;
  }

  const edges = buildCallGraph({ db, files });

  // 使用现有的 replaceSemanticEdges 函数存储
  const sourcePaths = [...new Set(files.map((f) => f.path))];

  const now = Date.now();
  const deleteBySource = db.prepare('DELETE FROM semantic_edges WHERE source_path = ?');
  const insert = db.prepare(`
    INSERT INTO semantic_edges (
      source_path,
      source_hash,
      target_path,
      target_hash,
      kind,
      symbol_name,
      source_line,
      target_line,
      provider,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const path of sourcePaths) {
      deleteBySource.run(path);
    }
    for (const edge of edges) {
      insert.run(
        edge.sourcePath,
        edge.sourceHash,
        edge.targetPath,
        edge.targetHash,
        edge.kind,
        edge.symbolName,
        edge.sourceLine,
        edge.targetLine,
        edge.provider,
        now,
      );
    }
  });

  tx();

  return edges.length;
}
