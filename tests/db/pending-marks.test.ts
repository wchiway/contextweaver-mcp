/**
 * pending_marks outbox 测试（C1 修复）
 *
 * 覆盖：
 * - insertPendingMarks / deletePendingMarks 基本 CRUD
 * - replayPendingMarks 正常应用
 * - hash mismatch 守卫（文件再次变更后不误覆盖）
 * - 重放幂等性（重放后再调用应为 no-op）
 * - schema v2 → v3 自动迁移建表
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  batchUpdateVectorIndexHash,
  countPendingMarks,
  deletePendingMarks,
  getReadyVectorFileHashes,
  getVectorManifestCounts,
  insertPendingMarks,
  markVectorManifestFailed,
  migrateSchema,
  replayPendingMarks,
  upsertVectorManifestPending,
} from '../../src/db/index.js';

function setupV4Schema(db: Database.Database): void {
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
  migrateSchema(db); // 全新库 → 直接 v3，自动建 pending_marks
}

function insertFile(
  db: Database.Database,
  path: string,
  hash: string,
  vectorIndexHash: string | null,
): void {
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(path, hash, 0, 0, 'x', 'typescript', vectorIndexHash);
}

function getVectorIndexHash(db: Database.Database, path: string): string | null {
  const row = db.prepare('SELECT vector_index_hash FROM files WHERE path = ?').get(path) as
    | { vector_index_hash: string | null }
    | undefined;
  return row?.vector_index_hash ?? null;
}

describe('pending_marks outbox (C1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    setupV4Schema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('[C1-1] migrateSchema v3 自动创建 pending_marks 表', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_marks'")
      .get();
    expect(row).toBeDefined();

    const versionRow = db
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(parseInt(versionRow.value, 10)).toBe(5);
  });

  it('[C1-2] insertPendingMarks 写入；ON CONFLICT 覆盖同 path 不同 hash', () => {
    insertPendingMarks(db, [
      { path: 'a.ts', hash: 'hA1' },
      { path: 'b.ts', hash: 'hB1' },
    ]);
    expect(countPendingMarks(db)).toBe(2);

    // 同 path 覆盖
    insertPendingMarks(db, [{ path: 'a.ts', hash: 'hA2' }]);
    expect(countPendingMarks(db)).toBe(2);

    const row = db.prepare('SELECT hash FROM pending_marks WHERE path = ?').get('a.ts') as {
      hash: string;
    };
    expect(row.hash).toBe('hA2');
  });

  it('[C1-3] deletePendingMarks 移除指定 path', () => {
    insertPendingMarks(db, [
      { path: 'a.ts', hash: 'h' },
      { path: 'b.ts', hash: 'h' },
    ]);
    deletePendingMarks(db, ['a.ts']);
    expect(countPendingMarks(db)).toBe(1);

    const remaining = db.prepare('SELECT path FROM pending_marks').all() as Array<{ path: string }>;
    expect(remaining.map((r) => r.path)).toEqual(['b.ts']);
  });

  it('[C1-4] replayPendingMarks: 正常重放 → 更新 vector_index_hash 并清 outbox', () => {
    insertFile(db, 'a.ts', 'hashX', null);
    insertFile(db, 'b.ts', 'hashY', null);
    insertPendingMarks(db, [
      { path: 'a.ts', hash: 'hashX' },
      { path: 'b.ts', hash: 'hashY' },
    ]);

    const result = replayPendingMarks(db);

    expect(result.applied).toBe(2);
    expect(result.discarded).toBe(0);
    expect(getVectorIndexHash(db, 'a.ts')).toBe('hashX');
    expect(getVectorIndexHash(db, 'b.ts')).toBe('hashY');
    expect(countPendingMarks(db)).toBe(0);
  });

  it('[C1-5] hash mismatch 守卫：files.hash 已变 → 不误覆盖，丢弃 outbox', () => {
    // 写 outbox 时文件 hash 是 hashOld；后文件再次变更为 hashNew，outbox 应被丢弃
    insertFile(db, 'a.ts', 'hashNew', null);
    insertPendingMarks(db, [{ path: 'a.ts', hash: 'hashOld' }]);

    const result = replayPendingMarks(db);

    expect(result.applied).toBe(0);
    expect(result.discarded).toBe(1);
    // 不能误把 vector_index_hash 写成 hashOld
    expect(getVectorIndexHash(db, 'a.ts')).toBeNull();
    // outbox 仍要清理（过时标记无用）
    expect(countPendingMarks(db)).toBe(0);
  });

  it('[C1-6] path 已从 files 删除 → 丢弃 outbox', () => {
    // outbox 引用一个不存在的 path
    insertPendingMarks(db, [{ path: 'ghost.ts', hash: 'h' }]);

    const result = replayPendingMarks(db);

    expect(result.applied).toBe(0);
    expect(result.discarded).toBe(1);
    expect(countPendingMarks(db)).toBe(0);
  });

  it('[C1-7] 重放幂等：第二次重放 = no-op', () => {
    insertFile(db, 'a.ts', 'h', null);
    insertPendingMarks(db, [{ path: 'a.ts', hash: 'h' }]);

    const first = replayPendingMarks(db);
    expect(first.applied).toBe(1);

    const second = replayPendingMarks(db);
    expect(second.applied).toBe(0);
    expect(second.discarded).toBe(0);
  });

  it('[C1-8] 空 outbox → 直接返回 0/0', () => {
    const result = replayPendingMarks(db);
    expect(result).toEqual({ applied: 0, discarded: 0 });
  });

  it('[C1-9] 混合：部分匹配 + 部分 mismatch', () => {
    insertFile(db, 'a.ts', 'hA', null);
    insertFile(db, 'b.ts', 'hB_new', null);
    insertPendingMarks(db, [
      { path: 'a.ts', hash: 'hA' }, // 匹配
      { path: 'b.ts', hash: 'hB_old' }, // mismatch
      { path: 'ghost.ts', hash: 'h' }, // 不存在
    ]);

    const result = replayPendingMarks(db);

    expect(result.applied).toBe(1);
    expect(result.discarded).toBe(2);
    expect(getVectorIndexHash(db, 'a.ts')).toBe('hA');
    expect(getVectorIndexHash(db, 'b.ts')).toBeNull();
    expect(countPendingMarks(db)).toBe(0);
  });

  it('[C1-10] vector_manifest 状态驱动 ready-only 查询', () => {
    insertFile(db, 'ready.ts', 'h-ready', null);
    insertFile(db, 'pending.ts', 'h-pending', null);
    insertFile(db, 'failed.ts', 'h-failed', null);
    insertFile(db, 'stale.ts', 'h-new', 'h-old');

    upsertVectorManifestPending(db, [
      { path: 'ready.ts', hash: 'h-ready', chunkCount: 2, embeddingDimensions: 1024 },
      { path: 'pending.ts', hash: 'h-pending', chunkCount: 1, embeddingDimensions: 1024 },
      { path: 'failed.ts', hash: 'h-failed', chunkCount: 1, embeddingDimensions: 1024 },
      { path: 'stale.ts', hash: 'h-old', chunkCount: 1, embeddingDimensions: 1024 },
    ]);
    batchUpdateVectorIndexHash(db, [{ path: 'ready.ts', hash: 'h-ready' }]);
    markVectorManifestFailed(db, [{ path: 'failed.ts', hash: 'h-failed', error: 'boom' }]);

    expect(getVectorManifestCounts(db)).toEqual({ pending: 2, ready: 1, failed: 1 });
    expect(
      Array.from(
        getReadyVectorFileHashes(db, ['ready.ts', 'pending.ts', 'failed.ts', 'stale.ts']).entries(),
      ),
    ).toEqual([['ready.ts', 'h-ready']]);
  });

  it('[C1-11] v2 → v3 迁移：旧库有 schema_version=2 时升级建 pending_marks', () => {
    const oldDb = new Database(':memory:');
    oldDb.exec(`
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
      INSERT INTO metadata (key, value) VALUES ('schema_version', '2');
    `);

    migrateSchema(oldDb);

    const tableRow = oldDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_marks'")
      .get();
    expect(tableRow).toBeDefined();

    const versionRow = oldDb
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(parseInt(versionRow.value, 10)).toBe(5);

    oldDb.close();
  });
});
