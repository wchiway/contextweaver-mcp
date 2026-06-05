/**
 * list-symbols MCP Tool
 *
 * 查询 semantic_symbols 表，输出文件/目录的符号大纲
 */

import path from 'node:path';
import { z } from 'zod';
import { generateProjectId, initDb } from '../../db/index.js';
import { ensureIndexed, formatTextResponse, type ProgressCallback } from './shared.js';

export const listSymbolsSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  path_filter: z
    .string()
    .optional()
    .describe('Path filter (prefix match or glob pattern, e.g., "src/search" or "**/*.ts")'),
  kind_filter: z
    .string()
    .optional()
    .describe('Comma-separated symbol kinds to include (e.g., "function,class,interface")'),
  language: z
    .string()
    .optional()
    .describe('Language filter (e.g., "typescript", "python", "go")'),
  source: z
    .string()
    .optional()
    .describe('Symbol source filter ("tree-sitter" or "ctags")'),
  max_results: z
    .number()
    .min(1)
    .max(500)
    .default(100)
    .describe('Maximum number of symbols to return (default: 100, max: 500)'),
});

export type ListSymbolsInput = z.infer<typeof listSymbolsSchema>;

interface SymbolRow {
  path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number | null;
  container_name: string | null;
}

export async function handleListSymbols(
  args: ListSymbolsInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const rootPath = path.resolve(args.repo_path);
  const projectId = generateProjectId(rootPath);

  // 确保已索引（不需要向量索引）
  await ensureIndexed(rootPath, projectId, {
    onProgress,
    vectorIndex: false,
  });

  const db = initDb(projectId);
  try {
    // 构建 SQL WHERE 条件
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (args.language) {
      conditions.push('language = ?');
      params.push(args.language);
    }

    if (args.source) {
      conditions.push('source = ?');
      params.push(args.source);
    }

    if (args.kind_filter) {
      const kinds = args.kind_filter.split(',').map((k) => k.trim());
      const placeholders = kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      params.push(...kinds);
    }

    // 路径过滤：在 SQL 中处理以提高效率
    if (args.path_filter) {
      const filter = args.path_filter;
      if (filter.includes('*')) {
        // Glob 模式：转换为 LIKE 模式
        const likePattern = filter
          .replace(/\*\*/g, '%') // ** 匹配任意路径
          .replace(/\*/g, '%'); // * 匹配任意字符
        conditions.push('path LIKE ?');
        params.push(likePattern);
      } else {
        // 前缀匹配
        conditions.push('path LIKE ?');
        params.push(`${filter}%`);
      }
    }

    const sql = `
      SELECT path, name, kind, start_line, end_line, container_name
      FROM semantic_symbols
      WHERE ${conditions.join(' AND ')}
      ORDER BY path, start_line
      LIMIT ?
    `;
    params.push(args.max_results);

    const rows = db.prepare(sql).all(...params) as SymbolRow[];

    // 分组并格式化
    const byFile = new Map<string, SymbolRow[]>();
    for (const row of rows) {
      if (!byFile.has(row.path)) {
        byFile.set(row.path, []);
      }
      byFile.get(row.path)!.push(row);
    }

    const output: string[] = [];
    const totalFiles = byFile.size;
    const totalSymbols = rows.length;

    output.push(`Found ${totalSymbols} symbols in ${totalFiles} files\n`);

    for (const [filePath, symbols] of byFile) {
      output.push(`## ${filePath} (${symbols.length} symbols)\n`);

      for (const sym of symbols) {
        const lineRange = sym.end_line
          ? `L${sym.start_line}-L${sym.end_line}`
          : `L${sym.start_line}`;

        const container = sym.container_name ? ` (in ${sym.container_name})` : '';
        output.push(`- **[${lineRange}]** \`${sym.kind}\` **${sym.name}**${container}`);
      }

      output.push(''); // 空行分隔文件
    }

    return formatTextResponse(output.join('\n'));
  } finally {
    db.close();
  }
}
