import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextPacker } from '../../src/search/ContextPacker.js';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import type { ScoredChunk } from '../../src/search/types.js';

function scored(source: ScoredChunk['source'], index: number, score: number): ScoredChunk {
  return {
    filePath: 'src/a.ts',
    chunkIndex: index,
    score,
    source,
    record: {
      chunk_id: `src/a.ts#h#${index}`,
      file_path: 'src/a.ts',
      file_hash: 'h',
      chunk_index: index,
      vector: [],
      language: 'typescript',
      breadcrumb: `src/a.ts > chunk ${index}`,
      start_index: index * 4,
      end_index: index * 4 + 5,
      raw_start: index * 4,
      raw_end: index * 4 + 5,
      vec_start: index * 4,
      vec_end: index * 4 + 5,
      _distance: 0,
    },
  };
}

describe('ContextPacker provenance', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  it('preserves sources, seed flag, and chunk indices on merged segments', async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT);');
    db.prepare('INSERT INTO files (path, content) VALUES (?, ?)').run(
      'src/a.ts',
      '0123456789abcdefghijklmnopqrst',
    );

    const packer = new ContextPacker('project', DEFAULT_CONFIG);
    const result = await packer.pack([scored('vector', 0, 0.9), scored('neighbor', 1, 0.5)], db);

    expect(result[0]?.segments[0]?.sources).toEqual(['vector', 'neighbor']);
    expect(result[0]?.segments[0]?.isSeed).toBe(true);
    expect(result[0]?.segments[0]?.chunkIndices).toEqual([0, 1]);
  });
});
