import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import { GraphExpander } from '../../src/search/GraphExpander.js';
import type { ScoredChunk } from '../../src/search/types.js';
import type { ChunkRecord } from '../../src/vectorStore/index.js';

function makeChunkRecord(filePath: string, chunkIndex: number, breadcrumb: string): ChunkRecord {
  return {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [0.1, 0.2],
    language: 'typescript',
    breadcrumb,
    start_index: 0,
    end_index: 20,
    raw_start: 0,
    raw_end: 20,
    vec_start: 0,
    vec_end: 20,
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

describe('GraphExpander reverse imports', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('adds importing file chunks as reverse_import expansions', async () => {
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

    db.prepare(
      'INSERT INTO files (path, hash, content, vector_index_hash) VALUES (?, ?, ?, ?)',
    ).run('src/service.ts', 'hash', 'export function doThing() {}', 'hash');
    db.prepare(
      'INSERT INTO files (path, hash, content, vector_index_hash) VALUES (?, ?, ?, ?)',
    ).run(
      'src/controller.ts',
      'hash',
      "import { doThing } from './service';\nexport function handle() { return doThing(); }",
      'hash',
    );
    db.prepare(
      'INSERT INTO vector_manifest (path, hash, status, chunk_count, embedding_dimensions, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/controller.ts', 'hash', 'ready', 1, 2, Date.now());

    const controllerChunk = makeChunkRecord(
      'src/controller.ts',
      0,
      'src/controller.ts > function handle',
    );

    const vectorStore = {
      getFilesChunks: async (paths: string[]) =>
        new Map(paths.map((path) => [path, path === 'src/controller.ts' ? [controllerChunk] : []])),
    };

    const expander = new GraphExpander('project-reverse-imports', {
      ...DEFAULT_CONFIG,
      neighborHops: 0,
      breadcrumbExpandLimit: 0,
      importFilesPerSeed: 0,
      reverseImportFilesPerSeed: 2,
      callsiteChunksPerSeed: 0,
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
      makeSeed('src/service.ts', 0, 0.9, 'src/service.ts > function doThing'),
    ]);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.filePath).toBe('src/controller.ts');
    expect(result.chunks[0]?.source).toBe('reverse_import');
  });
});
