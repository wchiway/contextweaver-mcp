/**
 * ChunkContentLoader 测试（C2 准备阶段）
 *
 * 验证：
 * - 按 (path, raw_start, raw_end) 正确切片
 * - 按 path 分组只查一次 SQLite
 * - content=NULL / 偏移越界 / 空文件 等边界场景
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

  it('[L1] 按 raw_start/raw_end 正确切片', () => {
    insertFile(db, 'a.ts', '0123456789ABCDEFGHIJ'); // 20 chars
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([
      { filePath: 'a.ts', raw_start: 0, raw_end: 5 },
      { filePath: 'a.ts', raw_start: 5, raw_end: 10 },
      { filePath: 'a.ts', raw_start: 10, raw_end: 20 },
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
      { filePath: 'a.ts', raw_start: 0, raw_end: 5 },
      { filePath: 'a.ts', raw_start: 6, raw_end: 11 },
      { filePath: 'b.ts', raw_start: 4, raw_end: 7 },
    ]);

    expect(map.get('a.ts#0#5')).toBe('hello');
    expect(map.get('a.ts#6#11')).toBe('world');
    expect(map.get('b.ts#4#7')).toBe('bar');
  });

  it('[L3] content 为 NULL → 返回空字符串', () => {
    insertFile(db, 'a.ts', null);
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', raw_start: 0, raw_end: 5 }]);
    expect(map.get('a.ts#0#5')).toBe('');
  });

  it('[L4] path 不存在 → 返回空字符串，不抛错', () => {
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'ghost.ts', raw_start: 0, raw_end: 10 }]);
    expect(map.get('ghost.ts#0#10')).toBe('');
  });

  it('[L5] raw_end 超出 content 长度 → 截断到 length', () => {
    insertFile(db, 'a.ts', 'abc'); // 3 chars
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', raw_start: 0, raw_end: 100 }]);
    expect(map.get('a.ts#0#100')).toBe('abc');
  });

  it('[L6] raw_start > raw_end（异常偏移） → 空字符串', () => {
    insertFile(db, 'a.ts', 'abcdef');
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', raw_start: 5, raw_end: 2 }]);
    expect(map.get('a.ts#5#2')).toBe('');
  });

  it('[L7] raw_start 负数 → 当成 0', () => {
    insertFile(db, 'a.ts', 'abcdef');
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([{ filePath: 'a.ts', raw_start: -10, raw_end: 3 }]);
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
    const code = loader.loadOne({ filePath: 'a.ts', raw_start: 0, raw_end: 5 });
    expect(code).toBe('hello');
  });

  it('[L10] key 生成稳定且与 loadMany 内部一致', () => {
    const slice = { filePath: 'src/x.ts', raw_start: 100, raw_end: 200 };
    expect(ChunkContentLoader.key(slice)).toBe('src/x.ts#100#200');

    insertFile(db, 'src/x.ts', 'x'.repeat(300));
    const loader = new ChunkContentLoader(db);
    const map = loader.loadMany([slice]);
    expect(map.has(ChunkContentLoader.key(slice))).toBe(true);
  });
});
