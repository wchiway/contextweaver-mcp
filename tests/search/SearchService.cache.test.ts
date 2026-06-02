import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextPacker } from '../../src/search/ContextPacker.js';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

function createDb(indexVersion = 0): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
    'index_version',
    String(indexVersion),
  );
  return db;
}

function setIndexVersion(db: Database.Database, value: number): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('index_version', String(value));
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

function wireService(
  service: SearchService,
  db: Database.Database,
  label: string,
  packSpy: ReturnType<typeof vi.spyOn>,
) {
  const candidate = makeChunk(`${label}.ts`, 0, 0.9);
  const seed = makeChunk(`${label}.ts`, 0, 0.95);
  const expanded = makeChunk(`${label}.ts`, 1, 0.5);

  const retrieveSpy = vi.fn().mockResolvedValue([candidate]);
  const rerankSpy = vi.fn().mockResolvedValue([seed]);
  const cutoffSpy = vi.fn((chunks: ScoredChunk[]) => chunks);
  const expandSpy = vi.fn().mockResolvedValue([expanded]);

  (service as any).db = db;
  (service as any).hybridRetrieve = retrieveSpy;
  (service as any).rerank = rerankSpy;
  (service as any).applySmartCutoff = cutoffSpy;
  (service as any).expand = expandSpy;

  packSpy.mockResolvedValue([
    {
      filePath: `${label}.ts`,
      segments: [],
    },
  ]);

  return { retrieveSpy, rerankSpy, cutoffSpy, expandSpy };
}

describe('SearchService query cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses cached results across SearchService instances for the same project/query/version', async () => {
    const db = createDb(3);
    const packSpy = vi.spyOn(ContextPacker.prototype, 'pack');

    const service1 = new SearchService('project-a', '/repo');
    const firstSpies = wireService(service1, db, 'first', packSpy);

    const first = await service1.buildContextPack('find login flow');
    expect(firstSpies.retrieveSpy).toHaveBeenCalledTimes(1);
    expect(firstSpies.rerankSpy).toHaveBeenCalledTimes(1);
    expect(packSpy).toHaveBeenCalledTimes(1);

    const service2 = new SearchService('project-a', '/repo');
    const secondSpies = wireService(service2, db, 'second', packSpy);

    const second = await service2.buildContextPack('find login flow');

    expect(second).toEqual(first);
    expect(secondSpies.retrieveSpy).not.toHaveBeenCalled();
    expect(secondSpies.rerankSpy).not.toHaveBeenCalled();
    expect(secondSpies.expandSpy).not.toHaveBeenCalled();
    expect(packSpy).toHaveBeenCalledTimes(1);

    db.close();
  });

  it('invalidates cached results when index_version changes', async () => {
    const db = createDb(0);
    const packSpy = vi.spyOn(ContextPacker.prototype, 'pack');
    const service = new SearchService('project-b', '/repo');
    const spies = wireService(service, db, 'versioned', packSpy);

    await service.buildContextPack('trace billing');
    expect(spies.retrieveSpy).toHaveBeenCalledTimes(1);

    setIndexVersion(db, 1);
    await service.buildContextPack('trace billing');

    expect(spies.retrieveSpy).toHaveBeenCalledTimes(2);
    expect(spies.rerankSpy).toHaveBeenCalledTimes(2);
    expect(packSpy).toHaveBeenCalledTimes(2);

    db.close();
  });

  it('does not share cache entries across different config fingerprints', async () => {
    const db = createDb(5);
    const packSpy = vi.spyOn(ContextPacker.prototype, 'pack');

    const service1 = new SearchService('project-c', '/repo', { rerankTopN: 8 });
    const firstSpies = wireService(service1, db, 'config-a', packSpy);
    await service1.buildContextPack('search payments');
    expect(firstSpies.retrieveSpy).toHaveBeenCalledTimes(1);

    const service2 = new SearchService('project-c', '/repo', { rerankTopN: 9 });
    const secondSpies = wireService(service2, db, 'config-b', packSpy);
    await service2.buildContextPack('search payments');

    expect(secondSpies.retrieveSpy).toHaveBeenCalledTimes(1);
    expect(secondSpies.rerankSpy).toHaveBeenCalledTimes(1);
    expect(packSpy).toHaveBeenCalledTimes(2);

    db.close();
  });
});
