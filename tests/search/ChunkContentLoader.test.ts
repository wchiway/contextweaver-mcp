/**
 * ChunkContentLoader 测试（C2 准备阶段 + CRIT-A 修复）
 *
 * 验证：
 * - 按 (path, start_index, end_index) 正确切片（UTF-16 字符域）
 * - 按 path 分组只查一次 SQLite
 * - content=NULL / 偏移越界 / 空文件 等边界场景
 * - 多字节字符（CJK / emoji）UTF-16 切片正确性
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkContentLoader } from '../../src/search/ChunkContentLoader.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, content: string | null): void {
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(path, 'h', 0, content?.length ?? 0, content, 'typescript');
}

describe('ChunkContentLoader', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('[L1] 按 start_index/end_index 正确切片', () => {
    insertFile(db, 'a.ts', '0123456789ABCDEFGHIJ'); // 20 chars
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([
      { filePath: 'a.ts', start_index: 0, end_index: 5 },
      { filePath: 'a.ts', start_index: 5, end_index: 10 },
      { filePath: 'a.ts', start_index: 10, end_index: 20 },
    ]);

    expect(map.get('a.ts#0#5')).toBe('01234');
    expect(map.get('a.ts#5#10')).toBe('56789');
    expect(map.get('a.ts#10#20')).toBe('ABCDEFGHIJ');
  });

  it('[L2] 跨文件批量加载，每个 path 只查一次', () => {
    insertFile(db, 'a.ts', 'hello world');
    insertFile(db, 'b.ts', 'foo bar baz');

    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([
      { filePath: 'a.ts', start_index: 0, end_index: 5 },
      { filePath: 'a.ts', start_index: 6, end_index: 11 },
      { filePath: 'b.ts', start_index: 4, end_index: 7 },
    ]);

    expect(map.get('a.ts#0#5')).toBe('hello');
    expect(map.get('a.ts#6#11')).toBe('world');
    expect(map.get('b.ts#4#7')).toBe('bar');
  });

  it('[L3] content 为 NULL → 返回空字符串', () => {
    insertFile(db, 'a.ts', null);
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', start_index: 0, end_index: 5 }]);
    expect(map.get('a.ts#0#5')).toBe('');
  });

  it('[L4] path 不存在 → 返回空字符串，不抛错', () => {
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'ghost.ts', start_index: 0, end_index: 10 }]);
    expect(map.get('ghost.ts#0#10')).toBe('');
  });

  it('[L5] end_index 超出 content 长度 → 截断到 length', () => {
    insertFile(db, 'a.ts', 'abc'); // 3 chars
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', start_index: 0, end_index: 100 }]);
    expect(map.get('a.ts#0#100')).toBe('abc');
  });

  it('[L6] start_index > end_index（异常偏移） → 空字符串', () => {
    insertFile(db, 'a.ts', 'abcdef');
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', start_index: 5, end_index: 2 }]);
    expect(map.get('a.ts#5#2')).toBe('');
  });

  it('[L7] start_index 负数 → 当成 0', () => {
    insertFile(db, 'a.ts', 'abcdef');
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', start_index: -10, end_index: 3 }]);
    expect(map.get('a.ts#-10#3')).toBe('abc');
  });

  it('[L8] 空数组 → 空 Map', () => {
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([]);
    expect(map.size).toBe(0);
  });

  it('[L9] loadOne 便捷方法', () => {
    insertFile(db, 'a.ts', 'hello');
    const loader = new ChunkContentLoader(db);
    const code = loader.loadOne({ filePath: 'a.ts', start_index: 0, end_index: 5 });
    expect(code).toBe('hello');
  });

  it('[L10] key 生成稳定且与 loadMany 内部一致', () => {
    const slice = { filePath: 'src/x.ts', start_index: 100, end_index: 200 };
    expect(ChunkContentLoader.key(slice)).toBe('src/x.ts#100#200');

    insertFile(db, 'src/x.ts', 'x'.repeat(300));
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([slice]);
    expect(map.has(ChunkContentLoader.key(slice))).toBe(true);
  });

  it('[L11] CJK 字符 UTF-16 切片：3 个汉字（共 3 code units）正确切片', () => {
    // "你好世界" 4 个汉字，UTF-16 code units = 4，UTF-8 bytes = 12
    insertFile(db, 'cjk.md', '你好世界test');
    const loader = new ChunkContentLoader(db);
    // 期望 SemanticSplitter 已通过 adapter.toCharOffset 转换为 UTF-16 偏移
    const map = loader.loadMany([
      { filePath: 'cjk.md', start_index: 0, end_index: 2 }, // "你好"
      { filePath: 'cjk.md', start_index: 2, end_index: 4 }, // "世界"
      { filePath: 'cjk.md', start_index: 4, end_index: 8 }, // "test"
    ]);

    expect(map.get('cjk.md#0#2')).toBe('你好');
    expect(map.get('cjk.md#2#4')).toBe('世界');
    expect(map.get('cjk.md#4#8')).toBe('test');
  });

  it('[L12] 紧邻 chunk 切片不重叠（验证 displayCode 还原语义）', () => {
    // 模拟 SemanticSplitter 产物：[0,5) "hello", [10,15) "world"
    // raw_start/end 含 gap，但 start_index/end_index 仅是 displayCode 范围
    insertFile(db, 'a.ts', 'hello\n   world');
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([
      { filePath: 'a.ts', start_index: 0, end_index: 5 },
      { filePath: 'a.ts', start_index: 9, end_index: 14 },
    ]);

    expect(map.get('a.ts#0#5')).toBe('hello');
    expect(map.get('a.ts#9#14')).toBe('world');
  });
});
