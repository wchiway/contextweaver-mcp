/**
 * Schema 迁移测试
 *
 * 验证 1.1 修复：files_fts 从独立内容表迁移到外部内容表
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateSchema } from '../../src/db/index.js';
import { initFilesFts, searchFilesFts } from '../../src/search/fts.js';

/** 模拟 v1.1.0 之前的 schema：files_fts 是独立 contentful 表 */
function createV1Schema(db: Database.Database): void {
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
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE files_fts USING fts5(
      path,
      content,
      tokenize='unicode61'
    );
  `);
}

function insertFile(db: Database.Database, path: string, content: string): void {
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(path, `h-${path}`, 0, content.length, content, 'typescript');
}

function getFtsSchema(db: Database.Database): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='files_fts'`)
    .get() as { sql: string } | undefined;
  return row?.sql ?? '';
}

function getSchemaVersion(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  return parseInt(row.value, 10);
}

describe('Schema 迁移 v1 → v2', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('[M1] v1 schema → 自动迁移到 v2, 数据不丢失', () => {
    createV1Schema(db);
    insertFile(db, 'a.ts', 'function hello() { return "world"; }');
    insertFile(db, 'b.ts', 'class Foo { bar() {} }');
    // 旧 schema 下用旧方式同步 FTS
    db.exec('INSERT INTO files_fts(path, content) SELECT path, content FROM files');

    // 执行迁移
    migrateSchema(db);

    // 触发器需在迁移后通过 initFilesFts 安装
    initFilesFts(db);

    // 验证 schema 已升级
    expect(getSchemaVersion(db)).toBe(4);
    expect(getFtsSchema(db)).toContain("content='files'");

    // 验证数据可搜索
    const results = searchFilesFts(db, 'hello', 10);
    expect(results.some((r) => r.path === 'a.ts')).toBe(true);
  });

  it('[M2] 迁移后 INSERT files → 触发器自动同步 files_fts', () => {
    createV1Schema(db);
    migrateSchema(db);
    initFilesFts(db);

    // 此时插入新文件
    insertFile(db, 'new.ts', 'function newFunc() {}');

    const results = searchFilesFts(db, 'newFunc', 10);
    expect(results.some((r) => r.path === 'new.ts')).toBe(true);
  });

  it('[M3] 迁移后 DELETE files → 触发器自动从 files_fts 删除', () => {
    createV1Schema(db);
    insertFile(db, 'delete_me.ts', 'targetSymbol');
    db.exec('INSERT INTO files_fts(path, content) SELECT path, content FROM files');

    migrateSchema(db);
    initFilesFts(db);

    // 删除前能搜到
    const before = searchFilesFts(db, 'targetSymbol', 10);
    expect(before.some((r) => r.path === 'delete_me.ts')).toBe(true);

    // 删除文件
    db.prepare('DELETE FROM files WHERE path = ?').run('delete_me.ts');

    // 删除后搜不到
    const after = searchFilesFts(db, 'targetSymbol', 10);
    expect(after.some((r) => r.path === 'delete_me.ts')).toBe(false);
  });

  it('[M4] 迁移后 UPDATE files.content → 触发器同步新内容', () => {
    createV1Schema(db);
    insertFile(db, 'update.ts', 'oldTokenABCXYZ');
    db.exec('INSERT INTO files_fts(path, content) SELECT path, content FROM files');

    migrateSchema(db);
    initFilesFts(db);

    expect(searchFilesFts(db, 'oldTokenABCXYZ', 10)).toHaveLength(1);

    db.prepare('UPDATE files SET content = ? WHERE path = ?').run('newTokenDEFUVW', 'update.ts');

    expect(searchFilesFts(db, 'oldTokenABCXYZ', 10)).toHaveLength(0);
    expect(searchFilesFts(db, 'newTokenDEFUVW', 10)).toHaveLength(1);
  });

  it('[M5] content 为 NULL 的文件 → 触发器跳过, 不报错', () => {
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
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    migrateSchema(db);
    initFilesFts(db);

    // 插入 content=NULL 的文件不应抛错
    expect(() => {
      db.prepare(
        'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('skipped.bin', 'h-x', 0, 0, null, 'binary');
    }).not.toThrow();

    // FTS 中不存在该行
    const results = searchFilesFts(db, 'skipped', 10);
    expect(results.some((r) => r.path === 'skipped.bin')).toBe(false);
  });

  it('[M6] 全新数据库 → 直接标记 v2, 无需迁移', () => {
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
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    migrateSchema(db);
    expect(getSchemaVersion(db)).toBe(4);
  });

  it('[M7] 重复 migrateSchema 调用幂等', () => {
    createV1Schema(db);
    insertFile(db, 'a.ts', 'content');
    db.exec('INSERT INTO files_fts(path, content) SELECT path, content FROM files');

    migrateSchema(db);
    initFilesFts(db);
    // 再次调用不应破坏数据
    migrateSchema(db);
    initFilesFts(db);

    expect(getSchemaVersion(db)).toBe(4);
    expect(getFtsSchema(db)).toContain("content='files'");
  });

  it('[M8] 残留 files_fts_v1_backup 表 → 自动清理', () => {
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
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE files_fts USING fts5(
        path, content, content='files', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE VIRTUAL TABLE files_fts_v1_backup USING fts5(path, content);
    `);
    // 标记已迁移
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', '2');

    migrateSchema(db);

    const backupExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts_v1_backup'`)
      .get();
    expect(backupExists).toBeUndefined();
  });
});
