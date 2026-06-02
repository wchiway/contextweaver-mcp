import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockChunkRecord {
  chunk_id: string;
  file_path: string;
  file_hash: string;
  chunk_index: number;
  vector: number[];
  language: string;
  breadcrumb: string;
  start_index: number;
  end_index: number;
  raw_start: number;
  raw_end: number;
  vec_start: number;
  vec_end: number;
}

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  ensureIndexed: vi.fn().mockResolvedValue(undefined),
  searchChunksFts: vi.fn(),
  getFilesChunks: vi.fn(),
}));

vi.mock('../../src/db/index.js', () => ({
  generateProjectId: () => 'project-test',
  initDb: () => state.db,
}));

vi.mock('../../src/mcp/tools/shared.js', () => ({
  ensureIndexed: (...args: unknown[]) => state.ensureIndexed(...args),
  formatTextResponse: (text: string) => ({
    content: [{ type: 'text' as const, text }],
  }),
}));

vi.mock('../../src/search/fts.js', () => ({
  searchChunksFts: (...args: unknown[]) => state.searchChunksFts(...args),
}));

vi.mock('../../src/vectorStore/index.js', () => ({
  getVectorStore: async () => ({
    getFilesChunks: (...args: unknown[]) => state.getFilesChunks(...args),
  }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDebugEnabled: () => false,
}));

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    )
  `);

  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'src/auth.ts',
    'h1',
    0,
    56,
    ['export function login(user: string) {', '  return user;', '}', ''].join('\n'),
    'typescript',
  );
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'src/app.ts',
    'h2',
    0,
    88,
    ['const result = login(user);', 'const ignored = loginUser(user);', 'login(user);', ''].join(
      '\n',
    ),
    'typescript',
  );

  return db;
}

function getChunkMap(): Map<string, MockChunkRecord[]> {
  const authContent = ['export function login(user: string) {', '  return user;', '}', ''].join(
    '\n',
  );
  const appContent = [
    'const result = login(user);',
    'const ignored = loginUser(user);',
    'login(user);',
    '',
  ].join('\n');

  return new Map<string, MockChunkRecord[]>([
    [
      'src/auth.ts',
      [
        {
          chunk_id: 'src/auth.ts#h1#0',
          file_path: 'src/auth.ts',
          file_hash: 'h1',
          chunk_index: 0,
          vector: [],
          language: 'typescript',
          breadcrumb: 'Auth > login',
          start_index: 0,
          end_index: authContent.length,
          raw_start: 0,
          raw_end: authContent.length,
          vec_start: 0,
          vec_end: authContent.length,
        },
      ],
    ],
    [
      'src/app.ts',
      [
        {
          chunk_id: 'src/app.ts#h2#0',
          file_path: 'src/app.ts',
          file_hash: 'h2',
          chunk_index: 0,
          vector: [],
          language: 'typescript',
          breadcrumb: 'App > run',
          start_index: 0,
          end_index: appContent.length,
          raw_start: 0,
          raw_end: appContent.length,
          vec_start: 0,
          vec_end: appContent.length,
        },
      ],
    ],
  ]);
}

describe('handleFindReferences', () => {
  beforeEach(() => {
    state.db = setupDb();
    state.ensureIndexed.mockClear();
    state.searchChunksFts.mockReset();
    state.getFilesChunks.mockReset();
    state.searchChunksFts.mockReturnValue([
      { chunkId: 'src/auth.ts#h1#0', filePath: 'src/auth.ts', chunkIndex: 0, score: 2 },
      { chunkId: 'src/app.ts#h2#0', filePath: 'src/app.ts', chunkIndex: 0, score: 1 },
    ]);
    state.getFilesChunks.mockResolvedValue(getChunkMap());
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
    vi.clearAllMocks();
  });

  it('filters out substring matches and reports exact reference lines', async () => {
    const { handleFindReferences } = await import('../../src/mcp/tools/findReferences.js');

    const response = await handleFindReferences({
      repo_path: '/repo',
      symbol: 'login',
      max_results: 10,
    });

    expect(state.ensureIndexed).toHaveBeenCalledWith('/repo', 'project-test', {
      onProgress: undefined,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Found 3 text references for "login"');
    expect(text).toContain('src/auth.ts:1');
    expect(text).toContain('src/app.ts:1');
    expect(text).toContain('src/app.ts:3');
    expect(text).not.toContain('loginUser');
  });

  it('excludes definition chunks when exclude_definition is enabled', async () => {
    const { handleFindReferences } = await import('../../src/mcp/tools/findReferences.js');

    const response = await handleFindReferences({
      repo_path: '/repo',
      symbol: 'login',
      exclude_definition: true,
      max_results: 10,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Found 2 text references for "login"');
    expect(text).not.toContain('src/auth.ts:1');
    expect(text).toContain('src/app.ts:1');
    expect(text).toContain('src/app.ts:3');
  });
});
