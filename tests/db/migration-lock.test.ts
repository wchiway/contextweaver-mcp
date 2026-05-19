/**
 * H2 测试：LanceDB 迁移跨进程 advisory lock
 *
 * 验证：
 * - tryAcquire 首次获取成功
 * - 同 PID 重入返回 true（视为持有）
 * - 不同 PID 占用 → 失败
 * - 僵尸锁（>10 分钟）可被夺取
 * - 损坏锁数据视作过期
 * - releaseLock 后可重新获取
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  migrateSchema,
  releaseLanceDbMigrationLock,
  tryAcquireLanceDbMigrationLock,
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

function setLockManually(db: Database.Database, pid: number, acquiredAt: number): void {
  db.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('lancedb_migration_lock', JSON.stringify({ pid, acquiredAt }));
}

describe('LanceDB 迁移 advisory lock (H2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setup();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('[H2-1] 首次获取锁成功', () => {
    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
  });

  it('[H2-2] 同进程重入返回 true（已持有）', () => {
    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
  });

  it('[H2-3] 其他进程持有未过期锁 → 获取失败', () => {
    const otherPid = process.pid + 1; // 不同 PID
    setLockManually(db, otherPid, Date.now()); // 刚获取

    expect(tryAcquireLanceDbMigrationLock(db)).toBe(false);
  });

  it('[H2-4] 僵尸锁（>10 分钟） → 强制夺取', () => {
    const otherPid = process.pid + 1;
    const staleTime = Date.now() - 11 * 60 * 1000; // 11 分钟前
    setLockManually(db, otherPid, staleTime);

    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);

    // 验证锁已被当前进程接管
    const lock = db
      .prepare("SELECT value FROM metadata WHERE key = 'lancedb_migration_lock'")
      .get() as { value: string };
    const parsed = JSON.parse(lock.value);
    expect(parsed.pid).toBe(process.pid);
  });

  it('[H2-5] 损坏的锁数据 → 视作过期可夺取', () => {
    db.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
    `).run('lancedb_migration_lock', 'not-valid-json{{{');

    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
  });

  it('[H2-6] releaseLock 后可重新获取（即使来自不同进程）', () => {
    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
    releaseLanceDbMigrationLock(db);

    // 模拟「另一个进程」尝试获取（无现存锁）
    const lockRow = db
      .prepare("SELECT * FROM metadata WHERE key = 'lancedb_migration_lock'")
      .get();
    expect(lockRow).toBeUndefined();

    expect(tryAcquireLanceDbMigrationLock(db)).toBe(true);
  });

  it('[H2-7] 临界：恰好 10 分钟未过期 → 仍持有', () => {
    const otherPid = process.pid + 1;
    const justUnder = Date.now() - 10 * 60 * 1000 + 1000; // 9:59 前
    setLockManually(db, otherPid, justUnder);

    expect(tryAcquireLanceDbMigrationLock(db)).toBe(false);
  });
});
