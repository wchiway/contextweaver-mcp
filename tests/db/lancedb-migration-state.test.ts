/**
 * CRIT-B 测试：LanceDB 迁移状态机
 *
 * 不依赖真实 LanceDB（native 模块），仅验证：
 * - getLanceDbMigrationState / setLanceDbMigrationState 持久化
 * - clearAllVectorIndexHash 行为
 * - migration 状态转换语义（pending/done/aborted）
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllVectorIndexHash,
  getLanceDbMigrationState,
  migrateSchema,
  setLanceDbMigrationState,
} from '../../src/db/index.js';

function setup(): Database.Database {
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
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrateSchema(db);
  return db;
}

function insertFile(
  db: Database.Database,
  path: string,
  hash: string,
  vih: string | null,
): void {
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(path, hash, 0, 0, 'x', 'typescript', vih);
}

describe('LanceDB 迁移状态机 (CRIT-B)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setup();
  });

  afterEach(() => {
    db.close();
  });

  it('[B1] 初始状态：getLanceDbMigrationState 返回 null', () => {
    expect(getLanceDbMigrationState(db)).toBeNull();
  });

  it('[B2] setLanceDbMigrationState → getLanceDbMigrationState 持久化', () => {
    setLanceDbMigrationState(db, 'pending');
    expect(getLanceDbMigrationState(db)).toBe('pending');

    setLanceDbMigrationState(db, 'done');
    expect(getLanceDbMigrationState(db)).toBe('done');

    setLanceDbMigrationState(db, 'aborted');
    expect(getLanceDbMigrationState(db)).toBe('aborted');
  });

  it('[B3] 状态值是 ON CONFLICT 覆盖（非追加）', () => {
    setLanceDbMigrationState(db, 'pending');
    setLanceDbMigrationState(db, 'done');

    const rows = db
      .prepare(
        "SELECT COUNT(*) as c FROM metadata WHERE key = 'lancedb_migration_displaycode_state'",
      )
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('[B4] 非法值持久化但读取时归一为 null', () => {
    db.prepare(
      "INSERT INTO metadata (key, value) VALUES ('lancedb_migration_displaycode_state', ?)",
    ).run('garbage');
    expect(getLanceDbMigrationState(db)).toBeNull();
  });

  it('[B5] clearAllVectorIndexHash 清空所有 vector_index_hash', () => {
    insertFile(db, 'a.ts', 'hA', 'hA');
    insertFile(db, 'b.ts', 'hB', 'hB');
    insertFile(db, 'c.ts', 'hC', null); // 已经是 null

    const changes = clearAllVectorIndexHash(db);
    expect(changes).toBe(3); // UPDATE 影响所有行，无论原值

    const rows = db
      .prepare('SELECT path, vector_index_hash FROM files ORDER BY path')
      .all() as Array<{ path: string; vector_index_hash: string | null }>;
    expect(rows.every((r) => r.vector_index_hash === null)).toBe(true);
  });

  it('[B6] clearAllVectorIndexHash 在空表上不抛错', () => {
    expect(() => clearAllVectorIndexHash(db)).not.toThrow();
    const changes = clearAllVectorIndexHash(db);
    expect(changes).toBe(0);
  });

  it('[B7] 状态机崩溃恢复场景：pending 状态下 vector_index_hash 应已被清空', () => {
    // 模拟迁移启动后崩溃
    insertFile(db, 'a.ts', 'hA', 'hA');
    insertFile(db, 'b.ts', 'hB', 'hB');

    // 正确顺序：先清 vih，再设 pending（migrateRemoveDisplayCode 中的顺序）
    clearAllVectorIndexHash(db);
    setLanceDbMigrationState(db, 'pending');

    // 此时模拟"重启"：状态读取正确
    expect(getLanceDbMigrationState(db)).toBe('pending');
    const rows = db
      .prepare('SELECT vector_index_hash FROM files')
      .all() as Array<{ vector_index_hash: string | null }>;
    expect(rows.every((r) => r.vector_index_hash === null)).toBe(true);
    // 自愈机制（getFilesNeedingVectorIndex）将返回所有文件 → 重建索引
  });
});
