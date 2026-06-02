import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectHealthSnapshot,
  getAllStats,
  getStatJson,
  incrementStat,
  setStatJson,
} from '../../src/db/index.js';
import { renderStatsText, type StatsReport } from '../../src/stats/index.js';

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    );
    CREATE TABLE pending_marks (path TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
}

describe('stats 埋点基础设施', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('incrementStat 首次插入即为 by，后续原子累加', () => {
    incrementStat(db, 'stats.search.total_queries');
    incrementStat(db, 'stats.search.total_queries');
    incrementStat(db, 'stats.search.sum_retrieve_ms', 30);
    incrementStat(db, 'stats.search.sum_retrieve_ms', 12);

    const stats = getAllStats(db);
    expect(stats['stats.search.total_queries']).toBe('2');
    expect(stats['stats.search.sum_retrieve_ms']).toBe('42');
  });

  it('incrementStat by=0 也会建立计数器键', () => {
    incrementStat(db, 'stats.search.sum_seed_count', 0);
    expect(getAllStats(db)['stats.search.sum_seed_count']).toBe('0');
  });

  it('getAllStats 只返回 stats.* 前缀的键', () => {
    incrementStat(db, 'stats.index.total_runs');
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', '3');

    const stats = getAllStats(db);
    expect(stats['stats.index.total_runs']).toBe('1');
    expect(stats.schema_version).toBeUndefined();
  });

  it('setStatJson / getStatJson 往返序列化', () => {
    setStatJson(db, 'stats.index.last_run_json', { totalFiles: 5, added: 2 });
    expect(getStatJson(db, 'stats.index.last_run_json')).toEqual({ totalFiles: 5, added: 2 });
  });

  it('getStatJson 解析失败返回 null', () => {
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('stats.x', 'not-json');
    expect(getStatJson(db, 'stats.x')).toBeNull();
    expect(getStatJson(db, 'stats.missing')).toBeNull();
  });
});

describe('collectHealthSnapshot', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('聚合文件数/字节/语言占比/pending_marks', () => {
    const insert = db.prepare(
      'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('a.ts', 'h1', 1, 100, 'x', 'typescript');
    insert.run('b.ts', 'h2', 1, 200, 'y', 'typescript');
    insert.run('c.py', 'h3', 1, 50, 'z', 'python');
    db.prepare('INSERT INTO pending_marks (path, hash, created_at) VALUES (?, ?, ?)').run(
      'a.ts',
      'h1',
      1,
    );

    const snap = collectHealthSnapshot(db);
    expect(snap.totalFiles).toBe(3);
    expect(snap.totalBytes).toBe(350);
    expect(snap.byLanguage).toEqual({ typescript: 2, python: 1 });
    expect(snap.pendingMarks).toBe(1);
    expect(snap.migrationState).toBeNull();
  });

  it('空库返回零值且不抛错', () => {
    const snap = collectHealthSnapshot(db);
    expect(snap.totalFiles).toBe(0);
    expect(snap.totalBytes).toBe(0);
    expect(snap.byLanguage).toEqual({});
  });
});

describe('renderStatsText', () => {
  it('新库（计数器全 0）不抛错，均值显示 —', () => {
    const report: StatsReport = {
      projectId: 'test',
      health: {
        totalFiles: 0,
        totalBytes: 0,
        byLanguage: {},
        pendingMarks: 0,
        migrationState: null,
        embeddingDimensions: null,
        indexVersion: 0,
      },
      lancedbRows: 0,
      index: { totalRuns: 0, lastRun: null, lastRunAt: null },
      search: {
        totalQueries: 0,
        cacheHits: 0,
        cacheHitRate: null,
        computeRuns: 0,
        avgRetrieveMs: null,
        avgRerankMs: null,
        avgExpandMs: null,
        avgPackMs: null,
        avgSeedCount: null,
      },
      diagnostics: [],
    };

    const text = renderStatsText(report);
    expect(text).toContain('retrieve=—');
    expect(text).toContain('暂无（尚未索引）');
    expect(text).toContain('无异常');
  });

  it('渲染诊断告警', () => {
    const report: StatsReport = {
      projectId: 'test',
      health: {
        totalFiles: 10,
        totalBytes: 1024,
        byLanguage: { typescript: 10 },
        pendingMarks: 3,
        migrationState: 'aborted',
        embeddingDimensions: 1024,
        indexVersion: 2,
      },
      lancedbRows: 0,
      index: { totalRuns: 1, lastRun: null, lastRunAt: null },
      search: {
        totalQueries: 4,
        cacheHits: 1,
        cacheHitRate: 0.25,
        computeRuns: 3,
        avgRetrieveMs: 10,
        avgRerankMs: 5,
        avgExpandMs: 2,
        avgPackMs: 1,
        avgSeedCount: 8,
      },
      diagnostics: ['LanceDB 迁移状态为 aborted', 'pending_marks 积压 3 条'],
    };

    const text = renderStatsText(report);
    expect(text).toContain('25.0%');
    expect(text).toContain('⚠ LanceDB 迁移状态为 aborted');
    expect(text).toContain('⚠ pending_marks 积压 3 条');
  });
});
