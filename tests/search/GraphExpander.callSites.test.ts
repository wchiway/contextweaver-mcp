import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import { batchUpsertChunkFts, initChunksFts } from '../../src/search/fts.js';
import { GraphExpander } from '../../src/search/GraphExpander.js';
import type { ScoredChunk } from '../../src/search/types.js';
import type { ChunkRecord } from '../../src/vectorStore/index.js';

function makeChunkRecord(
  filePath: string,
  chunkIndex: number,
  breadcrumb: string,
  start = 0,
  end = 20,
): ChunkRecord {
  return {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [0.1, 0.2],
    language: 'typescript',
    breadcrumb,
    start_index: start,
    end_index: end,
    raw_start: start,
    raw_end: end,
    vec_start: start,
    vec_end: end,
  };
}

function makeSeed(
  filePath: string,
  chunkIndex: number,
  score: number,
  breadcrumb: string,
): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: { ...makeChunkRecord(filePath, chunkIndex, breadcrumb), _distance: 0 },
  };
}

describe('GraphExpander call sites', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('adds matched call-site chunks as callsite expansions', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        content TEXT,
        vector_index_hash TEXT
      );
      CREATE TABLE vector_manifest (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        status TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        embedding_dimensions INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    initChunksFts(db);

    const callerContent = 'export function run() {\n  return doSearch();\n}\n';
    db.prepare(
      'INSERT INTO files (path, hash, content, vector_index_hash) VALUES (?, ?, ?, ?)',
    ).run('src/caller.ts', 'hash', callerContent, 'hash');
    db.prepare(
      'INSERT INTO vector_manifest (path, hash, status, chunk_count, embedding_dimensions, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/caller.ts', 'hash', 'ready', 1, 2, Date.now());
    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/caller.ts#hash#0',
        filePath: 'src/caller.ts',
        chunkIndex: 0,
        breadcrumb: 'src/caller.ts > function run',
        content: callerContent,
      },
    ]);

    const callerChunk = makeChunkRecord('src/caller.ts', 0, 'src/caller.ts > function run');
    const vectorStore = {
      getFilesChunks: async (paths: string[]) =>
        new Map(paths.map((path) => [path, path === 'src/caller.ts' ? [callerChunk] : []])),
    };

    const expander = new GraphExpander('project-callsites', {
      ...DEFAULT_CONFIG,
      neighborHops: 0,
      breadcrumbExpandLimit: 0,
      importFilesPerSeed: 0,
      reverseImportFilesPerSeed: 0,
      callsiteChunksPerSeed: 2,
      decayReverseImport: 0.5,
      decayCallsite: 0.5,
    });

    const testExpander = expander as unknown as {
      db: Database.Database;
      vectorStore: typeof vectorStore;
    };
    testExpander.db = db;
    testExpander.vectorStore = vectorStore;

    const result = await expander.expand([
      makeSeed('src/search.ts', 0, 0.9, 'src/search.ts > function doSearch'),
    ]);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.filePath).toBe('src/caller.ts');
    expect(result.chunks[0]?.source).toBe('callsite');
  });
});
