/**
 * TG1: C2 LanceDB 迁移真实端到端集成测试
 *
 * 使用真实 @lancedb/lancedb（已是运行时 dep）+ tmp 目录构造一个
 * 含 display_code 列的 v2 chunks 表，调用 bootstrap 触发迁移，
 * 断言新 schema 无 display_code、count 保留、state='done'。
 *
 * 同时覆盖：
 * - 全新库（无表）：直接标 done
 * - 已迁移库（无 display_code 列）：标 done
 * - 崩溃恢复（pending + 无表 → done）
 * - 抽样校验失败 → state='aborted'，旧表保留
 *
 * 这是 native LanceDB 集成测试，相对慢（~5s/case），但覆盖了纯函数测试无法
 * 验证的真实 schema drop+recreate 行为。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/db/bootstrap.js';
import {
  getLanceDbMigrationState,
  initDb,
  migrateSchema,
  setLanceDbMigrationState,
} from '../../src/db/index.js';
import { VectorStore } from '../../src/vectorStore/index.js';

/** 完整的 v2 chunks 表行（含 display_code/vector_text） */
interface V2Row {
  chunk_id: string;
  file_path: string;
  file_hash: string;
  chunk_index: number;
  vector: number[];
  display_code: string;
  vector_text: string;
  language: string;
  breadcrumb: string;
  start_index: number;
  end_index: number;
  raw_start: number;
  raw_end: number;
  vec_start: number;
  vec_end: number;
}

function makeV2Row(filePath: string, idx: number, displayCode: string): V2Row {
  const vec = Float32Array.from({ length: 8 }, (_, i) => 0.1 + i * 0.01);
  return {
    chunk_id: `${filePath}#h#${idx}`,
    file_path: filePath,
    file_hash: 'h',
    chunk_index: idx,
    vector: Array.from(vec),
    display_code: displayCode,
    vector_text: displayCode,
    language: 'typescript',
    breadcrumb: 'mod>fn',
    start_index: idx * 10,
    end_index: idx * 10 + displayCode.length,
    raw_start: idx * 10,
    raw_end: idx * 10 + displayCode.length,
    vec_start: idx * 10,
    vec_end: idx * 10 + displayCode.length,
  };
}

async function makeTmpDirs(): Promise<{
  baseDir: string;
  lanceDir: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-tg1-'));
  const lanceDir = path.join(baseDir, 'vectors.lance');
  return {
    baseDir,
    lanceDir,
    cleanup: async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
    },
  };
}

async function createV2Table(lanceDir: string, rows: V2Row[]): Promise<void> {
  const conn = await lancedb.connect(lanceDir);
  await conn.createTable('chunks', rows as unknown as Record<string, unknown>[]);
}

async function getTableSchema(lanceDir: string): Promise<string[]> {
  const conn = await lancedb.connect(lanceDir);
  const names = await conn.tableNames();
  if (!names.includes('chunks')) return [];
  const table = await conn.openTable('chunks');
  const schema = await table.schema();
  return schema.fields.map((f) => f.name);
}

async function getTableCount(lanceDir: string): Promise<number> {
  const conn = await lancedb.connect(lanceDir);
  const names = await conn.tableNames();
  if (!names.includes('chunks')) return 0;
  const table = await conn.openTable('chunks');
  return await table.countRows();
}

describe('TG1: C2 LanceDB 迁移端到端集成', () => {
  let baseDir: string;
  let lanceDir: string;
  let cleanup: () => Promise<void>;
  let db: Database.Database;

  beforeEach(async () => {
    const dirs = await makeTmpDirs();
    baseDir = dirs.baseDir;
    lanceDir = dirs.lanceDir;
    cleanup = dirs.cleanup;

    db = new Database(path.join(baseDir, 'index.db'));
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
  });

  afterEach(async () => {
    db.close();
    await cleanup();
  });

  function insertFile(path: string, content: string, vih: string | null): void {
    db.prepare(
      'INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(path, 'h', 0, content.length, content, 'typescript', vih);
  }

  it('[TG1-1] v2 表 → 迁移后 schema 无 display_code/vector_text，count 保留', async () => {
    // 构造内容：start_index/end_index 必须能切出 display_code
    const content = 'ABCDEFGHIJabcdefghij'; // 20 chars
    insertFile('a.ts', content, 'h');

    // chunk0: [0, 10) = "ABCDEFGHIJ"
    // chunk1: [10, 20) = "abcdefghij"
    const v2Rows = [
      { ...makeV2Row('a.ts', 0, 'ABCDEFGHIJ'), start_index: 0, end_index: 10, raw_start: 0, raw_end: 10 },
      { ...makeV2Row('a.ts', 1, 'abcdefghij'), start_index: 10, end_index: 20, raw_start: 10, raw_end: 20 },
    ];
    await createV2Table(lanceDir, v2Rows);

    // 验证起始状态
    expect(await getTableSchema(lanceDir)).toContain('display_code');
    expect(await getTableCount(lanceDir)).toBe(2);

    // 执行迁移
    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(true);
    expect(result.migration.totalRows).toBe(2);
    expect(getLanceDbMigrationState(db)).toBe('done');

    // 新 schema 不含 display_code/vector_text
    const newSchema = await getTableSchema(lanceDir);
    expect(newSchema).not.toContain('display_code');
    expect(newSchema).not.toContain('vector_text');
    // 关键字段保留
    expect(newSchema).toContain('chunk_id');
    expect(newSchema).toContain('vector');
    expect(newSchema).toContain('start_index');
    expect(newSchema).toContain('raw_start');

    // 行数保留
    expect(await getTableCount(lanceDir)).toBe(2);
  }, 30000);

  it('[TG1-2] 全新库（无 chunks 表）→ 直接标 done', async () => {
    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(false);
    expect(result.migration.reason).toBe('empty');
    expect(getLanceDbMigrationState(db)).toBe('done');
  }, 30000);

  it('[TG1-3] 已迁移库（无 display_code 列）→ 标 done 不重复迁移', async () => {
    // 构造无 display_code 的 v3 表
    const v3Rows = [
      {
        chunk_id: 'a.ts#h#0',
        file_path: 'a.ts',
        file_hash: 'h',
        chunk_index: 0,
        vector: new Array(8).fill(0.1),
        language: 'typescript',
        breadcrumb: 'x',
        start_index: 0,
        end_index: 5,
        raw_start: 0,
        raw_end: 5,
        vec_start: 0,
        vec_end: 5,
      },
    ];
    const conn = await lancedb.connect(lanceDir);
    await conn.createTable('chunks', v3Rows as unknown as Record<string, unknown>[]);

    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(false);
    expect(result.migration.reason).toBe('already_migrated');
    expect(getLanceDbMigrationState(db)).toBe('done');

    // 表未被重建（count 保持）
    expect(await getTableCount(lanceDir)).toBe(1);
  }, 30000);

  it('[TG1-4] 崩溃恢复：state=pending + 无表 → 自动标 done', async () => {
    // 模拟上次崩溃：state=pending 但 LanceDB 表已 drop
    setLanceDbMigrationState(db, 'pending');

    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(true);
    expect(result.migration.reason).toBe('recovered_pending_no_table');
    expect(getLanceDbMigrationState(db)).toBe('done');
  }, 30000);

  it('[TG1-5] 抽样校验失败 → state=aborted，旧表保留', async () => {
    // 文件内容与 display_code 不匹配 → 必然 abort
    insertFile('a.ts', 'totally-different-content', 'h');

    const v2Rows = [
      { ...makeV2Row('a.ts', 0, 'XXX-mismatched'), start_index: 0, end_index: 14 },
    ];
    await createV2Table(lanceDir, v2Rows);

    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(false);
    expect(result.migration.reason).toMatch(/^mismatch_ratio_/);
    expect(getLanceDbMigrationState(db)).toBe('aborted');

    // 旧表保留（含 display_code）
    expect(await getTableSchema(lanceDir)).toContain('display_code');
    expect(await getTableCount(lanceDir)).toBe(1);
  }, 30000);

  it('[TG1-6] 二次调用幂等：done 状态下不重做', async () => {
    setLanceDbMigrationState(db, 'done');

    const vs = new VectorStore('tg1-test', 8, lanceDir);
    await vs.init();

    const result = await bootstrap(db, vs);

    expect(result.migration.migrated).toBe(false);
    expect(result.migration.reason).toBe('already_migrated_persisted');
    expect(getLanceDbMigrationState(db)).toBe('done');
  }, 30000);
});
