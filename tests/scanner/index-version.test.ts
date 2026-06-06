import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileMeta } from '../../src/db/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';

const state = vi.hoisted(() => {
  const db = {
    close: vi.fn(),
  } as unknown as Database.Database;

  return {
    db,
    storedDimensions: null as number | null,
    indexedPaths: [] as string[],
    filesNeedingVectorIndex: [] as string[],
    processResults: [] as ProcessResult[],
    crawledPaths: [] as string[],
    batchUpsert: vi.fn(),
    batchUpdateMtime: vi.fn(),
    batchDelete: vi.fn(),
    replaceSemanticSymbols: vi.fn(),
    replaceSemanticEdges: vi.fn(),
    incrementIndexVersion: vi.fn().mockReturnValue(1),
    incrementStat: vi.fn(),
    setStatJson: vi.fn(),
    setStoredEmbeddingDimensions: vi.fn(),
    invalidateAllExpanderCaches: vi.fn(),
    closeAllIndexers: vi.fn(),
    closeAllVectorStores: vi.fn().mockResolvedValue(undefined),
    indexerClear: vi.fn().mockResolvedValue(undefined),
    indexerGc: vi.fn().mockResolvedValue({ orphans: 0, truncated: false }),
    indexerIndexFiles: vi.fn().mockResolvedValue({ indexed: 0, deleted: 0, errors: 0 }),
  };
});

vi.mock('../../src/config.js', () => ({
  getEmbeddingConfig: () => ({ dimensions: 1024 }),
  isDev: false,
  isMcpMode: false,
}));

vi.mock('../../src/db/index.js', () => ({
  generateProjectId: () => 'project-test',
  initDb: () => state.db,
  getAllFileMeta: () =>
    new Map<string, Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash'>>(),
  getAllPaths: () => state.indexedPaths,
  getFilesNeedingVectorIndex: () => state.filesNeedingVectorIndex,
  getStoredEmbeddingDimensions: () => state.storedDimensions,
  setStoredEmbeddingDimensions: (...args: unknown[]) => state.setStoredEmbeddingDimensions(...args),
  batchUpsert: (...args: unknown[]) => state.batchUpsert(...args),
  batchUpdateMtime: (...args: unknown[]) => state.batchUpdateMtime(...args),
  batchDelete: (...args: unknown[]) => state.batchDelete(...args),
  replaceSemanticSymbols: (...args: unknown[]) => state.replaceSemanticSymbols(...args),
  replaceSemanticEdges: (...args: unknown[]) => state.replaceSemanticEdges(...args),
  clear: vi.fn(),
  closeDb: vi.fn(),
  incrementIndexVersion: (...args: unknown[]) => state.incrementIndexVersion(...args),
  incrementStat: (...args: unknown[]) => state.incrementStat(...args),
  setStatJson: (...args: unknown[]) => state.setStatJson(...args),
}));

vi.mock('../../src/scanner/crawler.js', () => ({
  crawl: async () => state.crawledPaths,
}));

vi.mock('../../src/scanner/filter.js', () => ({
  initFilter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/scanner/processor.js', () => ({
  processFiles: async () => state.processResults,
}));

vi.mock('../../src/semantic/callGraphBuilder.js', () => ({
  buildAndStoreCallGraph: vi.fn(() => 0),
}));

vi.mock('../../src/indexer/index.js', () => ({
  getIndexer: async () => ({
    clear: state.indexerClear,
    gc: state.indexerGc,
    indexFiles: state.indexerIndexFiles,
  }),
  closeAllIndexers: () => state.closeAllIndexers(),
}));

vi.mock('../../src/vectorStore/index.js', () => ({
  closeAllVectorStores: () => state.closeAllVectorStores(),
}));

vi.mock('../../src/search/GraphExpander.js', () => ({
  invalidateAllExpanderCaches: () => state.invalidateAllExpanderCaches(),
}));

describe('scan index_version invalidation', () => {
  beforeEach(() => {
    state.storedDimensions = null;
    state.indexedPaths = [];
    state.filesNeedingVectorIndex = [];
    state.processResults = [];
    state.crawledPaths = [];
    state.batchUpsert.mockReset();
    state.batchUpdateMtime.mockReset();
    state.batchDelete.mockReset();
    state.replaceSemanticSymbols.mockReset();
    state.replaceSemanticEdges.mockReset();
    state.incrementIndexVersion.mockReset();
    state.incrementIndexVersion.mockReturnValue(1);
    state.incrementStat.mockReset();
    state.setStatJson.mockReset();
    state.setStoredEmbeddingDimensions.mockReset();
    state.invalidateAllExpanderCaches.mockReset();
    state.closeAllIndexers.mockReset();
    state.closeAllVectorStores.mockClear();
    state.indexerClear.mockClear();
    state.indexerGc.mockClear();
    state.indexerIndexFiles.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('increments index_version when scan writes added/modified/deleted files', async () => {
    state.crawledPaths = ['/repo/a.ts'];
    state.processResults = [
      {
        absPath: '/repo/a.ts',
        relPath: 'a.ts',
        hash: 'hash-a',
        content: 'const a = 1;',
        chunks: [],
        language: 'typescript',
        mtime: 1,
        size: 12,
        status: 'added',
      },
    ];

    const { scan } = await import('../../src/scanner/index.js');
    const stats = await scan('/repo', { vectorIndex: false });

    expect(stats.added).toBe(1);
    expect(state.incrementIndexVersion).toHaveBeenCalledTimes(1);
  });

  it('does not increment index_version when scan only touches unchanged files', async () => {
    state.crawledPaths = ['/repo/a.ts'];
    state.processResults = [
      {
        absPath: '/repo/a.ts',
        relPath: 'a.ts',
        hash: 'hash-a',
        content: null,
        chunks: [],
        language: 'typescript',
        mtime: 1,
        size: 12,
        status: 'unchanged',
      },
    ];

    const { scan } = await import('../../src/scanner/index.js');
    const stats = await scan('/repo', { vectorIndex: false });

    expect(stats.unchanged).toBe(1);
    expect(state.incrementIndexVersion).not.toHaveBeenCalled();
  });
});
