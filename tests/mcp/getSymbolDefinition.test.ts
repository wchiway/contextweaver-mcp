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

vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    generateProjectId: () => 'project-test',
    initDb: () => state.db,
  };
});

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

async function setupDb(): Promise<Database.Database> {
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
    );
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 动态导入以确保 mock 生效
  const { migrateSchema } = await import('../../src/db/index.js');
  migrateSchema(db);

  return db;
}

function insertFile(db: Database.Database, path: string, content: string): void {
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(path, `hash-${path}`, 0, content.length, content, 'typescript');
}

function makeChunk(
  filePath: string,
  breadcrumb: string,
  content: string,
  language = 'typescript',
  chunkIndex = 0,
  startIndex = 0,
): MockChunkRecord {
  return {
    chunk_id: `${filePath}#hash#${chunkIndex}`,
    file_path: filePath,
    file_hash: 'hash',
    chunk_index: chunkIndex,
    vector: [],
    language,
    breadcrumb,
    start_index: startIndex,
    end_index: startIndex + content.length,
    raw_start: startIndex,
    raw_end: startIndex + content.length,
    vec_start: startIndex,
    vec_end: startIndex + content.length,
  };
}

describe('handleGetSymbolDefinition', () => {
  beforeEach(async () => {
    state.db = await setupDb();
    state.ensureIndexed.mockClear();
    state.searchChunksFts.mockReset();
    state.getFilesChunks.mockReset();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
    vi.clearAllMocks();
  });

  it('prefers breadcrumb exact matches over plain FTS fallback hits', async () => {
    const authContent = ['export function login(user: string) {', '  return user;', '}'].join('\n');
    const legacyContent = "export const login = makeLogin();";
    insertFile(state.db as Database.Database, 'src/auth.ts', authContent);
    insertFile(state.db as Database.Database, 'src/legacy.ts', legacyContent);

    state.searchChunksFts.mockReturnValue([
      { chunkId: 'src/legacy.ts#hash#0', filePath: 'src/legacy.ts', chunkIndex: 0, score: 9 },
      { chunkId: 'src/auth.ts#hash#0', filePath: 'src/auth.ts', chunkIndex: 0, score: 1 },
    ]);
    state.getFilesChunks.mockResolvedValue(
      new Map<string, MockChunkRecord[]>([
        ['src/auth.ts', [makeChunk('src/auth.ts', 'AuthService > login', authContent)]],
        ['src/legacy.ts', [makeChunk('src/legacy.ts', 'LegacyService > helpers', legacyContent)]],
      ]),
    );

    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    const response = await handleGetSymbolDefinition({
      repo_path: '/repo',
      symbol: 'login',
      max_results: 1,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Found 1 symbol definitions for "login"');
    expect(text).toContain('## src/auth.ts (L1-L3)');
    expect(text).not.toContain('src/legacy.ts');
  });

  it('uses hint_path to rank same-name breadcrumb matches by common prefix length', async () => {
    const libContent = 'export function createClient() {\n  return {};\n}';
    const testContent = 'export function createClient() {\n  return { mocked: true };\n}';
    insertFile(state.db as Database.Database, 'src/lib/createClient.ts', libContent);
    insertFile(state.db as Database.Database, 'tests/helpers/createClient.ts', testContent);

    state.searchChunksFts.mockReturnValue([
      {
        chunkId: 'tests/helpers/createClient.ts#hash#0',
        filePath: 'tests/helpers/createClient.ts',
        chunkIndex: 0,
        score: 8,
      },
      {
        chunkId: 'src/lib/createClient.ts#hash#0',
        filePath: 'src/lib/createClient.ts',
        chunkIndex: 0,
        score: 7,
      },
    ]);
    state.getFilesChunks.mockResolvedValue(
      new Map<string, MockChunkRecord[]>([
        [
          'tests/helpers/createClient.ts',
          [makeChunk('tests/helpers/createClient.ts', 'Helpers > createClient', testContent)],
        ],
        ['src/lib/createClient.ts', [makeChunk('src/lib/createClient.ts', 'Lib > createClient', libContent)]],
      ]),
    );

    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    const response = await handleGetSymbolDefinition({
      repo_path: '/repo',
      symbol: 'createClient',
      hint_path: 'src/features/auth/login.ts',
      max_results: 1,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('## src/lib/createClient.ts (L1-L3)');
    expect(text).not.toContain('tests/helpers/createClient.ts');
  });

  it('falls back to top-level const definitions and reports correct line numbers', async () => {
    const fileContent = ['// header', '', "export const API_URL = 'https://example.com';", ''].join(
      '\n',
    );
    const declaration = "export const API_URL = 'https://example.com';\n";
    insertFile(state.db as Database.Database, 'src/config.ts', fileContent);

    const startIndex = fileContent.indexOf('export const API_URL');
    state.searchChunksFts.mockReturnValue([
      { chunkId: 'src/config.ts#hash#0', filePath: 'src/config.ts', chunkIndex: 0, score: 6 },
    ]);
    state.getFilesChunks.mockResolvedValue(
      new Map<string, MockChunkRecord[]>([
        ['src/config.ts', [makeChunk('src/config.ts', 'Config', declaration, 'typescript', 0, startIndex)]],
      ]),
    );

    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    const response = await handleGetSymbolDefinition({
      repo_path: '/repo',
      symbol: 'API_URL',
      max_results: 1,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('## src/config.ts (L3-L3)');
    expect(text).toContain("export const API_URL = 'https://example.com';");
  });
});
