/**
 * ChunkContentLoader - 按 (path, start_index, end_index) 从 files.content 批量切片
 *
 * 用于消除 LanceDB chunks 表与 SQLite files 表的正文双写（C2 修复）。
 * - 输入：chunk 元数据数组（每条含 filePath / start_index / end_index）
 * - 输出：Map<key, code>，key = `${filePath}#${start_index}#${end_index}`
 *
 * 切片基准（CRIT-A 修复）：使用 start_index/end_index（与 SemanticSplitter 中
 * displayCode 同源），而非 raw_start/raw_end（含前置 gap，会污染 rerank 输入）。
 *
 * 域：所有偏移在 SemanticSplitter 中已统一到 UTF-16 字符域（adapter.toCharOffset），
 * 因此 String.prototype.slice 直接可用。
 *
 * 设计：
 * 1. 按 filePath 分组，每个 path 只读取一次 files.content
 * 2. 内存中按偏移切片，避免 N+1 查询
 * 3. content 为 null 或偏移越界时返回空字符串而非抛错（防御式）
 */

import type Database from 'better-sqlite3';

export interface ChunkSlice {
  filePath: string;
  start_index: number;
  end_index: number;
}

export class ChunkContentLoader {
  constructor(private db: Database.Database) {}

  /**
   * 生成 cache key
   */
  static key(slice: ChunkSlice): string {
    return `${slice.filePath}#${slice.start_index}#${slice.end_index}`;
  }

  /**
   * 批量加载 chunk 正文
   *
   * @returns Map<key, code>，key 由 ChunkContentLoader.key 生成
   */
  loadMany(slices: ChunkSlice[]): Map<string, string> {
    const result = new Map<string, string>();
    if (slices.length === 0) return result;

    // 按 filePath 分组
    const byPath = new Map<string, ChunkSlice[]>();
    for (const s of slices) {
      let arr = byPath.get(s.filePath);
      if (!arr) {
        arr = [];
        byPath.set(s.filePath, arr);
      }
      arr.push(s);
    }

    const stmt = this.db.prepare('SELECT content FROM files WHERE path = ?');
    for (const [path, spans] of byPath) {
      const row = stmt.get(path) as { content: string | null } | undefined;
      const content = row?.content ?? null;
      for (const s of spans) {
        const k = ChunkContentLoader.key(s);
        if (content === null) {
          result.set(k, '');
          continue;
        }
        // 防御：偏移越界时 slice 仍返回截断结果，不抛错
        const safeStart = Math.max(0, Math.min(s.start_index, content.length));
        const safeEnd = Math.max(safeStart, Math.min(s.end_index, content.length));
        result.set(k, content.slice(safeStart, safeEnd));
      }
    }
    return result;
  }

  /**
   * 加载单个 chunk 正文（便捷方法，不推荐在批量场景使用）
   */
  loadOne(slice: ChunkSlice): string {
    const map = this.loadMany([slice]);
    return map.get(ChunkContentLoader.key(slice)) ?? '';
  }
}
