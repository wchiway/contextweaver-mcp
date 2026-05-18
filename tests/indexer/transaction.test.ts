/**
 * Indexer 事务回滚测试
 *
 * 验证 1.2 修复：FTS 失败时反向删除 LanceDB，保持 vector_index_hash 旧值
 *
 * 由于 Indexer.batchIndex 是 private 且强耦合 native 模块（LanceDB / embedding API），
 * 这里通过 mock VectorStore + 内存 SQLite 测试事务补偿语义，
 * 而非端到端调用 batchIndex（端到端集成测试见 scanner 层）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { batchUpdateVectorIndexHash, clearVectorIndexHash } from '../../src/db/index.js';
import { batchUpsertChunkFts, initChunksFts } from '../../src/search/fts.js';
import type { ChunkRecord } from '../../src/vectorStore/index.js';

/** Mock VectorStore：记录所有调用，支持注入失败 */
class MockVectorStore {
  records = new Map<string, ChunkRecord>(); // chunk_id -> record
  upsertCalls: Array<{ path: string; hash: string; records: ChunkRecord[] }> = [];
  deleteByHashCalls: Array<{ path: string; hash: string }> = [];
  upsertShouldFail = false;
  deleteByHashShouldFail = false;

  async batchUpsertFiles(
    files: Array<{ path: string; hash: string; records: ChunkRecord[] }>,
  ): Promise<void> {
    if (this.upsertShouldFail) throw new Error('Mock: LanceDB upsert failed');
    for (const f of files) {
      this.upsertCalls.push(f);
      for (const r of f.records) {
        this.records.set(r.chunk_id, r);
      }
    }
  }

  async deleteFilesByHash(items: Array<{ path: string; hash: string }>): Promise<void> {
    if (this.deleteByHashShouldFail) throw new Error('Mock: LanceDB delete failed');
    for (const it of items) {
      this.deleteByHashCalls.push(it);
      for (const [id, rec] of this.records) {
        if (rec.file_path === it.path && rec.file_hash === it.hash) {
          this.records.delete(id);
        }
      }
    }
  }
}

/** 构造伪事务执行器，模拟 Indexer.batchIndex 阶段 4-6 的核心逻辑 */
async function runPseudoTransaction(
  db: Database.Database,
  store: MockVectorStore,
  filesToUpsert: Array<{ path: string; hash: string; records: ChunkRecord[] }>,
  ftsChunks: Array<{
    chunkId: string;
    filePath: string;
    chunkIndex: number;
    breadcrumb: string;
    content: string;
  }>,
  successFiles: Array<{ path: string; hash: string }>,
  ftsShouldFail = false,
): Promise<{ ok: boolean; reason?: string }> {
  // 阶段 4: LanceDB
  try {
    await store.batchUpsertFiles(filesToUpsert);
  } catch (err) {
    clearVectorIndexHash(
      db,
      filesToUpsert.map((f) => f.path),
    );
    return { ok: false, reason: 'lancedb' };
  }

  // 阶段 5: FTS
  try {
    if (ftsShouldFail) throw new Error('Mock: FTS failed');
    batchUpsertChunkFts(db, ftsChunks);
  } catch (err) {
    // 补偿
    try {
      await store.deleteFilesByHash(
        filesToUpsert.map((f) => ({ path: f.path, hash: f.hash })),
      );
    } catch {
      // 二级失败，孤儿留给 GC
    }
    clearVectorIndexHash(
      db,
      filesToUpsert.map((f) => f.path),
    );
    return { ok: false, reason: 'fts' };
  }

  // 阶段 6: SQLite mark
  batchUpdateVectorIndexHash(db, successFiles);
  return { ok: true };
}

describe('Indexer 事务补偿', () => {
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

    // 种子数据：file_a 已有旧 hash 'old-hash'
    db.prepare(
      'INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('file_a.ts', 'new-hash', 0, 0, 'content', 'typescript', 'old-hash');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function makeRecord(path: string, hash: string, idx: number): ChunkRecord {
    return {
      chunk_id: `${path}#${hash}#${idx}`,
      file_path: path,
      file_hash: hash,
      chunk_index: idx,
      vector: [0.1, 0.2],
      display_code: 'code',
      vector_text: 'code',
      language: 'typescript',
      breadcrumb: 'a > b',
      start_index: 0,
      end_index: 10,
      raw_start: 0,
      raw_end: 10,
      vec_start: 0,
      vec_end: 10,
    };
  }

  it('[T1] LanceDB 成功 + FTS 失败 → LanceDB 回滚, vector_index_hash 保持旧值', async () => {
    const store = new MockVectorStore();
    const filesToUpsert = [
      {
        path: 'file_a.ts',
        hash: 'new-hash',
        records: [makeRecord('file_a.ts', 'new-hash', 0)],
      },
    ];
    const ftsChunks = [
      {
        chunkId: 'file_a.ts#new-hash#0',
        filePath: 'file_a.ts',
        chunkIndex: 0,
        breadcrumb: 'a > b',
        content: 'code',
      },
    ];

    const result = await runPseudoTransaction(
      db,
      store,
      filesToUpsert,
      ftsChunks,
      [{ path: 'file_a.ts', hash: 'new-hash' }],
      /* ftsShouldFail */ true,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fts');

    // LanceDB 已回滚：新 hash 的 chunks 应被删除
    expect(store.records.size).toBe(0);
    expect(store.deleteByHashCalls).toHaveLength(1);
    expect(store.deleteByHashCalls[0]).toEqual({
      path: 'file_a.ts',
      hash: 'new-hash',
    });

    // vector_index_hash 被清空，下次扫描会重试
    const row = db
      .prepare('SELECT vector_index_hash FROM files WHERE path = ?')
      .get('file_a.ts') as { vector_index_hash: string | null };
    expect(row.vector_index_hash).toBeNull();
  });

  it('[T2] LanceDB + FTS 成功 → vector_index_hash 收敛为新 hash', async () => {
    const store = new MockVectorStore();
    const filesToUpsert = [
      {
        path: 'file_a.ts',
        hash: 'new-hash',
        records: [makeRecord('file_a.ts', 'new-hash', 0)],
      },
    ];

    const result = await runPseudoTransaction(
      db,
      store,
      filesToUpsert,
      [
        {
          chunkId: 'file_a.ts#new-hash#0',
          filePath: 'file_a.ts',
          chunkIndex: 0,
          breadcrumb: 'a > b',
          content: 'code',
        },
      ],
      [{ path: 'file_a.ts', hash: 'new-hash' }],
    );

    expect(result.ok).toBe(true);
    expect(store.records.size).toBe(1);
    expect(store.deleteByHashCalls).toHaveLength(0);

    const row = db
      .prepare('SELECT vector_index_hash FROM files WHERE path = ?')
      .get('file_a.ts') as { vector_index_hash: string };
    expect(row.vector_index_hash).toBe('new-hash');
  });

  it('[T3] LanceDB 失败 → 直接 clearVectorIndexHash, 不调用 FTS/mark', async () => {
    const store = new MockVectorStore();
    store.upsertShouldFail = true;

    const filesToUpsert = [
      {
        path: 'file_a.ts',
        hash: 'new-hash',
        records: [makeRecord('file_a.ts', 'new-hash', 0)],
      },
    ];

    const result = await runPseudoTransaction(
      db,
      store,
      filesToUpsert,
      [],
      [{ path: 'file_a.ts', hash: 'new-hash' }],
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lancedb');
    expect(store.records.size).toBe(0);

    const row = db
      .prepare('SELECT vector_index_hash FROM files WHERE path = ?')
      .get('file_a.ts') as { vector_index_hash: string | null };
    expect(row.vector_index_hash).toBeNull();
  });

  it('[T4] FTS 失败且补偿删除也失败 → 仍 clearVectorIndexHash, 留 GC 清理', async () => {
    const store = new MockVectorStore();
    store.deleteByHashShouldFail = true;

    const filesToUpsert = [
      {
        path: 'file_a.ts',
        hash: 'new-hash',
        records: [makeRecord('file_a.ts', 'new-hash', 0)],
      },
    ];

    const result = await runPseudoTransaction(
      db,
      store,
      filesToUpsert,
      [
        {
          chunkId: 'file_a.ts#new-hash#0',
          filePath: 'file_a.ts',
          chunkIndex: 0,
          breadcrumb: 'a > b',
          content: 'code',
        },
      ],
      [{ path: 'file_a.ts', hash: 'new-hash' }],
      /* ftsShouldFail */ true,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fts');

    // LanceDB 仍残留孤儿（补偿失败）
    expect(store.records.size).toBe(1);

    // 但 vector_index_hash 已清空，孤儿会在 GC 阶段被清理
    const row = db
      .prepare('SELECT vector_index_hash FROM files WHERE path = ?')
      .get('file_a.ts') as { vector_index_hash: string | null };
    expect(row.vector_index_hash).toBeNull();
  });
});
