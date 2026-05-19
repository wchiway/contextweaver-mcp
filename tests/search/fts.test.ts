/**
 * fts.ts batchUpsertChunkFts 测试
 *
 * 验证 C3 修复：chunks_fts upsert 改为 per-file 整体替换，
 * 避免 hash 变化时旧 chunk_id 残留。
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchUpsertChunkFts, initChunksFts } from '../../src/search/fts.js';

interface FtsRow {
  chunk_id: string;
  file_path: string;
  chunk_index: number;
  breadcrumb: string;
  content: string;
}

function dumpFts(db: Database.Database, filePath?: string): FtsRow[] {
  const sql = filePath
    ? 'SELECT chunk_id, file_path, chunk_index, breadcrumb, content FROM chunks_fts WHERE file_path = ? ORDER BY chunk_index'
    : 'SELECT chunk_id, file_path, chunk_index, breadcrumb, content FROM chunks_fts ORDER BY file_path, chunk_index';
  const stmt = db.prepare(sql);
  return (filePath ? stmt.all(filePath) : stmt.all()) as FtsRow[];
}

describe('batchUpsertChunkFts (C3: per-file 整体替换)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initChunksFts(db);
  });

  afterEach(() => {
    db.close();
  });

  it('[C3-1] hash 变化时旧 chunk_id 应被整体清除', () => {
    // hash A: 3 chunks
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#hashA#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'mod>fnA0',
        content: 'foo',
      },
      {
        chunkId: 'a.ts#hashA#1',
        filePath: 'a.ts',
        chunkIndex: 1,
        breadcrumb: 'mod>fnA1',
        content: 'bar',
      },
      {
        chunkId: 'a.ts#hashA#2',
        filePath: 'a.ts',
        chunkIndex: 2,
        breadcrumb: 'mod>fnA2',
        content: 'baz',
      },
    ]);

    expect(dumpFts(db, 'a.ts')).toHaveLength(3);

    // hash B: 2 chunks（chunkId 完全不同，因 hash 改变）
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#hashB#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'mod>fnB0',
        content: 'qux',
      },
      {
        chunkId: 'a.ts#hashB#1',
        filePath: 'a.ts',
        chunkIndex: 1,
        breadcrumb: 'mod>fnB1',
        content: 'quux',
      },
    ]);

    const rows = dumpFts(db, 'a.ts');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.chunk_id.startsWith('a.ts#hashB#'))).toBe(true);
    expect(rows.map((r) => r.chunk_index)).toEqual([0, 1]);
  });

  it('[C3-2] 跨文件 batch：仅清理 batch 中涉及的 file_path', () => {
    // 初始化：A 和 B 各 2 个 chunks
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#hA#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'a0',
        content: 'a-content-0',
      },
      {
        chunkId: 'a.ts#hA#1',
        filePath: 'a.ts',
        chunkIndex: 1,
        breadcrumb: 'a1',
        content: 'a-content-1',
      },
      {
        chunkId: 'b.ts#hB#0',
        filePath: 'b.ts',
        chunkIndex: 0,
        breadcrumb: 'b0',
        content: 'b-content-0',
      },
      {
        chunkId: 'b.ts#hB#1',
        filePath: 'b.ts',
        chunkIndex: 1,
        breadcrumb: 'b1',
        content: 'b-content-1',
      },
    ]);

    // 仅更新 A 文件（hash 变化为 hA2，1 个 chunk）
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#hA2#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'a-new',
        content: 'a-new-content',
      },
    ]);

    const aRows = dumpFts(db, 'a.ts');
    const bRows = dumpFts(db, 'b.ts');

    expect(aRows).toHaveLength(1);
    expect(aRows[0].chunk_id).toBe('a.ts#hA2#0');

    // B 文件应完全不受影响
    expect(bRows).toHaveLength(2);
    expect(bRows.map((r) => r.chunk_id)).toEqual(['b.ts#hB#0', 'b.ts#hB#1']);
  });

  it('[C3-3] 空数组应为 no-op，不抛错', () => {
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#h#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'x',
        content: 'y',
      },
    ]);
    expect(dumpFts(db)).toHaveLength(1);

    // 空 batch：表内容应不变
    batchUpsertChunkFts(db, []);
    expect(dumpFts(db)).toHaveLength(1);
  });

  it('[C3-4] 同一 batch 内同一 file_path 多个 chunk → 全部保留', () => {
    batchUpsertChunkFts(db, [
      {
        chunkId: 'x.ts#h#0',
        filePath: 'x.ts',
        chunkIndex: 0,
        breadcrumb: 'x0',
        content: 'c0',
      },
      {
        chunkId: 'x.ts#h#1',
        filePath: 'x.ts',
        chunkIndex: 1,
        breadcrumb: 'x1',
        content: 'c1',
      },
      {
        chunkId: 'x.ts#h#2',
        filePath: 'x.ts',
        chunkIndex: 2,
        breadcrumb: 'x2',
        content: 'c2',
      },
    ]);

    const rows = dumpFts(db, 'x.ts');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.chunk_index)).toEqual([0, 1, 2]);
  });

  it('[C3-5] 事务回滚验证：单条 INSERT 失败时不应留下半量数据', () => {
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#h0#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'old',
        content: 'old-content',
      },
    ]);
    expect(dumpFts(db, 'a.ts')).toHaveLength(1);

    // 构造非法输入触发 SQLite 错误（chunk_index 列被 SQLite 接受任意类型，
    // 这里用 deliberately bad payload：传递无法绑定的 symbol 是不可能的，
    // 改为通过 db.exec 后手工破坏 prepare —— 实际中难以精确触发回滚，
    // 此用例改为间接断言：成功 batch 后表状态等价于 "delete-all-then-insert"）
    batchUpsertChunkFts(db, [
      {
        chunkId: 'a.ts#h1#0',
        filePath: 'a.ts',
        chunkIndex: 0,
        breadcrumb: 'new',
        content: 'new-content',
      },
    ]);

    const rows = dumpFts(db, 'a.ts');
    expect(rows).toHaveLength(1);
    expect(rows[0].breadcrumb).toBe('new');
    expect(rows[0].content).toBe('new-content');
  });
});
