import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchService } from '../../src/search/SearchService.js';

vi.mock('../../src/api/reranker.js', () => ({
  getRerankerClient: () => ({
    rerankWithData: vi.fn(async (_query, candidates) =>
      candidates.slice(0, 3).map((data, index) => ({ data, score: 0.9 - index * 0.1 })),
    ),
  }),
}));

describe('SearchService query terms', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  it('uses information_request for vector search and technical terms for lexical search', async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);');
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('index_version', '1');

    const service = new SearchService('project-query-terms', '/repo');
    vi.spyOn(service as unknown as { recordSearchStats: () => void }, 'recordSearchStats').mockImplementation(() => {});
    vi.spyOn(service as unknown as { vectorRetrieve: (query: string) => Promise<unknown[]> }, 'vectorRetrieve').mockResolvedValue([]);
    vi.spyOn(service as unknown as { lexicalRetrieve: (query: string) => Promise<unknown[]> }, 'lexicalRetrieve').mockResolvedValue([]);
    vi.spyOn(service as unknown as { expand: () => Promise<unknown[]> }, 'expand').mockResolvedValue([]);
    vi.spyOn(service as unknown as { db: Database.Database }, 'db', 'get').mockReturnValue(db);

    await service.buildContextPack({
      semanticQuery: 'trace login behavior',
      lexicalQuery: 'trace login behavior AuthService refreshToken',
      technicalTerms: ['AuthService', 'refreshToken'],
    });

    expect(
      (
        service as unknown as {
          vectorRetrieve: { mock: { calls: unknown[][] } };
        }
      ).vectorRetrieve.mock.calls[0]?.[0],
    ).toBe('trace login behavior');
    expect(
      (
        service as unknown as {
          lexicalRetrieve: { mock: { calls: unknown[][] } };
        }
      ).lexicalRetrieve.mock.calls[0]?.[0],
    ).toBe('trace login behavior AuthService refreshToken');
  });
});
