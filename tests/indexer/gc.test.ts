/**
 * Indexer GC 测试
 *
 * 验证 1.3 修复：scan 后自动清理 LanceDB 孤儿 chunks
 *
 * 同 transaction.test.ts，通过 mock VectorStore 测试 GC 逻辑核心，
 * 避免依赖 LanceDB native 模块。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initChunksFts, batchUpsertChunkFts } from '../../src/search/fts.js';

/** Mock VectorStore：仅保留 GC 路径需要的方法 */
class MockVectorStore {
  pairs: Array<{ path: string; hash: string }> = [];
  deletedByHash: Array<{ path: string; hash: string }> = [];
  listShouldFail = false;
  deleteShouldFail = false;
  listDelayMs = 0;

  async listFileHashes(): Promise<Array<{ path: string; hash: string }>> {
    if (this.listDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.listDelayMs));
    }
    if (this.listShouldFail) throw new Error('Mock: list failed');
    return [...this.pairs];
  }

  async deleteFilesByHash(items: Array<{ path: string; hash: string }>): Promise<void> {
    if (this.deleteShouldFail) throw new Error('Mock: delete failed');
    for (const it of items) {
      this.deletedByHash.push(it);
      this.pairs = this.pairs.filter(
        (p) => !(p.path === it.path && p.hash === it.hash),
      );
    }
  }
}

/**
 * GC 核心算法的独立实现，对齐 Indexer.gc 的语义。
 *
 * 不直接调用 Indexer 实例是因为 Indexer.init 会触发真实 LanceDB 连接 + embedding 客户端，
 * 而本测试只想验证算法本身。
 */
async function runGc(
  db: Database.Database,
  store: MockVectorStore,
  options: { maxScanMs?: number } = {},
): Promise<{ orphans: number; truncated?: boolean }> {
  const startTime = Date.now();
  const timeBudget = options.maxScanMs ?? 5000;

  let vectorPairs: Array<{ path: string; hash: string }>;
  try {
    vectorPairs = await store.listFileHashes();
  } catch {
    return { orphans: 0 };
  }

  if (vectorPairs.length === 0) return { orphans: 0 };

  if (Date.now() - startTime > timeBudget) {
    return { orphans: 0, truncated: true };
  }

  const sqliteRows = db.prepare('SELECT path, hash FROM files').all() as Array<{
    path: string;
    hash: string;
  }>;
  const valid = new Set(sqliteRows.map((r) => `${r.path} ${r.hash}`));
  const sqlitePaths = new Set(sqliteRows.map((r) => r.path));

  const orphans = vectorPairs.filter((p) => !valid.has(`${p.path} ${p.hash}`));
  if (orphans.length === 0) return { orphans: 0 };

  try {
    await store.deleteFilesByHash(orphans);
  } catch {
    return { orphans: 0 };
  }

  const pathsToClean = Array.from(new Set(orphans.map((o) => o.path))).filter(
    (p) => !sqlitePaths.has(p),
  );
  if (pathsToClean.length > 0) {
    const stmt = db.prepare('DELETE FROM chunks_fts WHERE file_path = ?');
    const tx = db.transaction((items: string[]) => {
      for (const p of items) stmt.run(p);
    });
    tx(pathsToClean);
  }

  return { orphans: orphans.length };
}

describe('Indexer GC', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        content TEXT,
        language TEXT NOT NULL,
        vector_index_hash TEXT
      )
    `);
    initChunksFts(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(path: string, hash: string): void {
    db.prepare(
      'INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(path, hash, 0, 0, 'x', 'typescript', hash);
  }

  it('[G1] LanceDB 有旧 hash, SQLite 已是新 hash → 删除旧 hash', async () => {
    insertFile('file_a.ts', 'h-new');
    const store = new MockVectorStore();
    store.pairs = [
      { path: 'file_a.ts', hash: 'h-old' }, // 孤儿
      { path: 'file_a.ts', hash: 'h-new' }, // 当前
    ];

    const result = await runGc(db, store);

    expect(result.orphans).toBe(1);
    expect(store.deletedByHash).toEqual([{ path: 'file_a.ts', hash: 'h-old' }]);
    expect(store.pairs).toEqual([{ path: 'file_a.ts', hash: 'h-new' }]);
  });

  it('[G2] LanceDB 含 path A, SQLite 已删除 A → 删 LanceDB 全部 + 清 FTS', async () => {
    // SQLite 不含 file_a.ts
    insertFile('file_b.ts', 'h-b');
    batchUpsertChunkFts(db, [
      {
        chunkId: 'file_a.ts#h-old#0',
        filePath: 'file_a.ts',
        chunkIndex: 0,
        breadcrumb: 'a',
        content: 'foo',
      },
    ]);

    const store = new MockVectorStore();
    store.pairs = [
      { path: 'file_a.ts', hash: 'h-old' },
      { path: 'file_b.ts', hash: 'h-b' },
    ];

    const result = await runGc(db, store);

    expect(result.orphans).toBe(1);
    expect(store.pairs).toEqual([{ path: 'file_b.ts', hash: 'h-b' }]);

    // FTS 也应被清理（path 完全不在 SQLite）
    const ftsRow = db
      .prepare('SELECT COUNT(*) as c FROM chunks_fts WHERE file_path = ?')
      .get('file_a.ts') as { c: number };
    expect(ftsRow.c).toBe(0);
  });

  it('[G3] LanceDB 与 SQLite 完全一致 → 不动', async () => {
    insertFile('file_a.ts', 'h-a');
    insertFile('file_b.ts', 'h-b');
    const store = new MockVectorStore();
    store.pairs = [
      { path: 'file_a.ts', hash: 'h-a' },
      { path: 'file_b.ts', hash: 'h-b' },
    ];

    const result = await runGc(db, store);

    expect(result.orphans).toBe(0);
    expect(store.deletedByHash).toEqual([]);
    expect(store.pairs).toHaveLength(2);
  });

  it('[G4] 拉取阶段超时 → truncated=true, 不删任何东西', async () => {
    insertFile('file_a.ts', 'h-a');
    const store = new MockVectorStore();
    store.pairs = [{ path: 'file_a.ts', hash: 'h-old' }];
    store.listDelayMs = 50;

    const result = await runGc(db, store, { maxScanMs: 10 });

    expect(result.truncated).toBe(true);
    expect(result.orphans).toBe(0);
    expect(store.deletedByHash).toEqual([]);
  });

  it('[G5] listFileHashes 抛错 → orphans=0, 不传播', async () => {
    insertFile('file_a.ts', 'h-a');
    const store = new MockVectorStore();
    store.listShouldFail = true;

    const result = await runGc(db, store);

    expect(result.orphans).toBe(0);
    expect(store.deletedByHash).toEqual([]);
  });

  it('[G6] hash 仅变更 (path 仍在 SQLite) → 不删 FTS', async () => {
    insertFile('file_a.ts', 'h-new');
    batchUpsertChunkFts(db, [
      {
        chunkId: 'file_a.ts#h-new#0',
        filePath: 'file_a.ts',
        chunkIndex: 0,
        breadcrumb: 'a',
        content: 'new',
      },
    ]);

    const store = new MockVectorStore();
    store.pairs = [
      { path: 'file_a.ts', hash: 'h-old' }, // 孤儿
      { path: 'file_a.ts', hash: 'h-new' }, // 当前
    ];

    const result = await runGc(db, store);

    expect(result.orphans).toBe(1);

    // FTS 不应被清理（path 仍在 SQLite，新 hash 的 FTS 由 upsert 维护）
    const ftsRow = db
      .prepare('SELECT COUNT(*) as c FROM chunks_fts WHERE file_path = ?')
      .get('file_a.ts') as { c: number };
    expect(ftsRow.c).toBe(1);
  });
});
