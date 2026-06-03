import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextPacker } from '../../src/search/ContextPacker.js';
import { mergeScoredChunks, SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('index_version', '1');
  return db;
}

function makeChunk(filePath: string, chunkIndex: number, score: number): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {
      chunk_id: `${filePath}#hash#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'hash',
      chunk_index: chunkIndex,
      vector: [0.1, 0.2],
      language: 'typescript',
      breadcrumb: 'mod > fn',
      start_index: 0,
      end_index: 10,
      raw_start: 0,
      raw_end: 10,
      vec_start: 0,
      vec_end: 10,
      _distance: 0,
    },
  };
}

describe('SearchService query planner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses multiple semantic variants when query rewrite is enabled', async () => {
    const db = createDb();
    const packSpy = vi.spyOn(ContextPacker.prototype, 'pack').mockResolvedValue([
      {
        filePath: 'auth.ts',
        segments: [],
      },
    ]);

    const service = new SearchService('project-query-planner', '/repo');
    const hybridRetrieve = vi
      .spyOn(service as unknown as { hybridRetrieve: (...args: string[]) => Promise<ScoredChunk[]> }, 'hybridRetrieve')
      .mockImplementation(async (semanticQuery) => [makeChunk(`${semanticQuery}.ts`, 0, 0.9)]);
    vi.spyOn(service as unknown as { rerank: () => Promise<ScoredChunk[]> }, 'rerank').mockImplementation(async (_query, candidates) => candidates);
    vi.spyOn(
      service as unknown as {
        applySmartCutoff: (chunks: ScoredChunk[]) => {
          seeds: ScoredChunk[];
          lowConfidence: boolean;
          warnings: string[];
        };
      },
      'applySmartCutoff',
    ).mockImplementation((chunks) => ({
      seeds: chunks,
      lowConfidence: false,
      warnings: [],
    }));
    vi.spyOn(service as unknown as { expand: () => Promise<ScoredChunk[]> }, 'expand').mockResolvedValue([]);
    vi.spyOn(service as unknown as { recordSearchStats: () => void }, 'recordSearchStats').mockImplementation(() => {});
    vi.spyOn(service as unknown as { db: Database.Database }, 'db', 'get').mockReturnValue(db);

    await service.buildContextPack({
      semanticQuery: 'trace token refresh and retry behavior',
      lexicalQuery: 'trace token refresh and retry behavior AuthService refreshToken',
      technicalTerms: ['AuthService', 'refreshToken'],
      queryRewrite: true,
    });

    expect(hybridRetrieve.mock.calls.length).toBeGreaterThan(1);
    expect(hybridRetrieve.mock.calls[0]?.[0]).toBe('trace token refresh and retry behavior');
    expect(hybridRetrieve.mock.calls[0]?.[1]).toBe(
      'trace token refresh and retry behavior AuthService refreshToken',
    );

    db.close();
    packSpy.mockRestore();
  });

  it('deduplicates merged chunks by file path and chunk index using the highest score', () => {
    const merged = mergeScoredChunks([
      makeChunk('src/auth.ts', 1, 0.6),
      makeChunk('src/auth.ts', 1, 0.9),
      makeChunk('src/auth.ts', 2, 0.7),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.filePath).toBe('src/auth.ts');
    expect(merged[0]?.chunkIndex).toBe(1);
    expect(merged[0]?.score).toBe(0.9);
  });
});
