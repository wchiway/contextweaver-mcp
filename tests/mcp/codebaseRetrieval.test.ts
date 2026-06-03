import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSearchServiceRegistry } from '../../src/mcp/tools/searchServiceRegistry.js';
import { codebaseRetrievalSchema } from '../../src/mcp/tools/codebaseRetrieval.js';

const state = vi.hoisted(() => ({
  ensureIndexed: vi.fn().mockResolvedValue(undefined),
  buildContextPack: vi.fn().mockResolvedValue({
    query: 'trace auth flow',
    seeds: [],
    expanded: [],
    files: [
      {
        filePath: 'src/auth.ts',
        segments: [
          {
            filePath: 'src/auth.ts',
            rawStart: 0,
            rawEnd: 20,
            startLine: 1,
            endLine: 2,
            score: 0.9,
            breadcrumb: 'src/auth.ts > AuthService',
            sources: ['vector' as const],
            isSeed: true,
            chunkIndices: [0],
            text: 'export class AuthService {}',
          },
        ],
      },
    ],
    debug: {
      wVec: 0.6,
      wLex: 0.4,
      timingMs: {},
    },
  }),
  initCalls: 0,
  constructCalls: 0,
}));

vi.mock('../../src/db/index.js', () => ({
  generateProjectId: () => 'project-test',
}));

vi.mock('../../src/mcp/tools/shared.js', () => ({
  ensureIndexed: (...args: unknown[]) => state.ensureIndexed(...args),
  checkEnvOrRespond: vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'missing env' }],
  })),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  checkEmbeddingEnv: () => ({ isValid: true, missingVars: [] }),
  checkRerankerEnv: () => ({ isValid: true, missingVars: [] }),
}));

vi.mock('../../src/search/loadConfig.js', () => ({
  getSearchConfigOverrides: () => ({ rerankTopN: 10 }),
}));

vi.mock('../../src/search/SearchService.js', () => ({
  SearchService: class FakeSearchService {
    constructor(
      public projectId: string,
      public repoPath: string,
      public config: unknown,
    ) {
      state.constructCalls += 1;
    }

    async init() {
      state.initCalls += 1;
    }

    async buildContextPack(...args: unknown[]) {
      return state.buildContextPack(...args);
    }
  },
}));

describe('codebaseRetrievalSchema', () => {
  beforeEach(() => {
    clearSearchServiceRegistry();
    state.ensureIndexed.mockClear();
    state.buildContextPack.mockClear();
    state.initCalls = 0;
    state.constructCalls = 0;
  });

  afterEach(() => {
    clearSearchServiceRegistry();
    vi.clearAllMocks();
  });

  it('accepts legacy input', () => {
    const parsed = codebaseRetrievalSchema.parse({
      repo_path: '/repo',
      information_request: 'trace auth flow',
      technical_terms: ['AuthService'],
    });

    expect(parsed.mode).toBeUndefined();
    expect(parsed.output_format).toBeUndefined();
  });

  it('accepts search controls', () => {
    const parsed = codebaseRetrievalSchema.parse({
      repo_path: '/repo',
      information_request: 'trace auth flow',
      mode: 'deep',
      include_globs: ['src/**/*.ts'],
      exclude_globs: ['**/*.test.ts'],
      language: ['typescript'],
      max_total_chars: 24000,
      max_files: 8,
      max_segments_per_file: 2,
      return_debug: true,
    });

    expect(parsed.mode).toBe('deep');
    expect(parsed.include_globs).toEqual(['src/**/*.ts']);
    expect(parsed.max_total_chars).toBe(24000);
  });

  it('rejects invalid mode and unsafe budget values', () => {
    expect(() =>
      codebaseRetrievalSchema.parse({
        repo_path: '/repo',
        information_request: 'trace auth flow',
        mode: 'expensive',
      }),
    ).toThrow();

    expect(() =>
      codebaseRetrievalSchema.parse({
        repo_path: '/repo',
        information_request: 'trace auth flow',
        max_total_chars: 999999,
      }),
    ).toThrow();
  });

  it('reuses the same SearchService instance across repeated MCP calls', async () => {
    const { handleCodebaseRetrieval } = await import('../../src/mcp/tools/codebaseRetrieval.js');

    const first = await handleCodebaseRetrieval({
      repo_path: '/repo',
      information_request: 'trace auth flow',
    });
    const second = await handleCodebaseRetrieval({
      repo_path: '/repo',
      information_request: 'trace auth flow',
    });

    expect(first.content[0]?.text).toContain('Found 0 relevant code blocks');
    expect(second.content[0]?.text).toContain('Found 0 relevant code blocks');
    expect(state.ensureIndexed).toHaveBeenCalledTimes(2);
    expect(state.constructCalls).toBe(1);
    expect(state.initCalls).toBe(1);
    expect(state.buildContextPack).toHaveBeenCalledTimes(2);
  });
});
