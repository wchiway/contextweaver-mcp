import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

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
  generateProjectId: vi.fn(() => 'project-test'),
  initDb: vi.fn(() => state.db),
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
    );
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_symbols (
      path TEXT NOT NULL,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('tree-sitter', 'ctags', 'lsp')),
      start_line INTEGER NOT NULL,
      end_line INTEGER,
      container_name TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (path, hash, source, kind, name, start_line, end_line)
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_symbols_path ON semantic_symbols(path);
    CREATE INDEX IF NOT EXISTS idx_semantic_symbols_name ON semantic_symbols(name);
    CREATE INDEX IF NOT EXISTS idx_semantic_symbols_source ON semantic_symbols(source);
  `);

  return db;
}

describe('handleGetSymbolDefinition', () => {
  beforeEach(() => {
    state.db = setupDb();
    state.ensureIndexed.mockClear();
    state.searchChunksFts.mockReset();
    state.getFilesChunks.mockReset();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
    vi.clearAllMocks();
  });

  it('should query semantic_symbols and return formatted definitions', async () => {
    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    // 插入测试数据
    state.db!.exec(`
      INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash)
      VALUES ('src/utils.ts', 'hash1', 1234567890, 100, 'export function testFunc() {\n  return 42;\n}', 'typescript', 'vec1');

      INSERT INTO semantic_symbols (path, hash, language, name, kind, source, start_line, end_line, container_name, updated_at)
      VALUES ('src/utils.ts', 'hash1', 'typescript', 'testFunc', 'function', 'tree-sitter', 1, 3, NULL, 1234567890);
    `);

    state.getFilesChunks.mockResolvedValue(new Map());

    const result = await handleGetSymbolDefinition(
      { repo_path: '/test/repo', symbol: 'testFunc' },
      undefined,
      state.db!,
    );

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Found 1 symbol definitions for "testFunc"');
    expect(text).toContain('src/utils.ts');
    expect(text).toContain('L1-L3');
    expect(text).toContain('kind: function');
    expect(text).toContain('source: tree-sitter');
  });

  it('should prioritize tree-sitter over ctags in semantic_symbols', async () => {
    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    state.db!.exec(`
      INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash)
      VALUES
        ('src/a.ts', 'hash1', 1234567890, 100, 'export class MyClass {}', 'typescript', 'vec1'),
        ('src/b.ts', 'hash2', 1234567890, 100, 'export class MyClass {}', 'typescript', 'vec2');

      INSERT INTO semantic_symbols (path, hash, language, name, kind, source, start_line, end_line, container_name, updated_at)
      VALUES
        ('src/b.ts', 'hash2', 'typescript', 'MyClass', 'class', 'ctags', 1, 1, NULL, 1234567890),
        ('src/a.ts', 'hash1', 'typescript', 'MyClass', 'class', 'tree-sitter', 1, 1, NULL, 1234567890);
    `);

    state.getFilesChunks.mockResolvedValue(new Map());

    const result = await handleGetSymbolDefinition(
      { repo_path: '/test/repo', symbol: 'MyClass', max_results: 2 },
      undefined,
      state.db!,
    );

    const text = result.content[0]?.text ?? '';
    const lines = text.split('\n');
    const firstDefLine = lines.find((l) => l.startsWith('## src/'));
    expect(firstDefLine).toContain('src/a.ts'); // tree-sitter 应该排在前面
  });

  it('should use hint_path to rank same-name symbols by prefix match', async () => {
    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    state.db!.exec(`
      INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash)
      VALUES
        ('src/auth/login.ts', 'hash1', 1234567890, 100, 'export function validate() {}', 'typescript', 'vec1'),
        ('src/utils/validate.ts', 'hash2', 1234567890, 100, 'export function validate() {}', 'typescript', 'vec2');

      INSERT INTO semantic_symbols (path, hash, language, name, kind, source, start_line, end_line, container_name, updated_at)
      VALUES
        ('src/auth/login.ts', 'hash1', 'typescript', 'validate', 'function', 'tree-sitter', 1, 1, NULL, 1234567890),
        ('src/utils/validate.ts', 'hash2', 'typescript', 'validate', 'function', 'tree-sitter', 1, 1, NULL, 1234567890);
    `);

    state.getFilesChunks.mockResolvedValue(new Map());

    const result = await handleGetSymbolDefinition(
      { repo_path: '/test/repo', symbol: 'validate', hint_path: 'src/auth/middleware.ts' },
      undefined,
      state.db!,
    );

    const text = result.content[0]?.text ?? '';
    const lines = text.split('\n');
    const firstDefLine = lines.find((l) => l.startsWith('## src/'));
    expect(firstDefLine).toContain('src/auth/login.ts'); // 更长的公共前缀
  });

  it('should fall back to FTS + pattern matching when semantic_symbols is empty', async () => {
    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    const mockChunk: MockChunkRecord = {
      chunk_id: 'chunk1',
      file_path: 'src/legacy.js',
      file_hash: 'hash1',
      chunk_index: 0,
      vector: [0.1, 0.2],
      language: 'javascript',
      breadcrumb: 'oldFunc',
      start_index: 0,
      end_index: 30,
      raw_start: 0,
      raw_end: 30,
      vec_start: 0,
      vec_end: 30,
    };

    state.db!.exec(`
      INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash)
      VALUES ('src/legacy.js', 'hash1', 1234567890, 100, 'function oldFunc() {\n  return 1;\n}', 'javascript', 'vec1');
    `);

    state.searchChunksFts.mockReturnValue([
      { filePath: 'src/legacy.js', chunkIndex: 0, score: 0.9 },
    ]);

    state.getFilesChunks.mockResolvedValue(
      new Map([['src/legacy.js', [mockChunk]]]),
    );

    const result = await handleGetSymbolDefinition(
      { repo_path: '/test/repo', symbol: 'oldFunc' },
      undefined,
      state.db!,
    );

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Found 1 symbol definitions for "oldFunc"');
    expect(text).toContain('src/legacy.js');
    expect(text).toContain('function oldFunc()');
  });

  it('should filter out call and reference kinds from semantic_symbols', async () => {
    const { handleGetSymbolDefinition } = await import(
      '../../src/mcp/tools/getSymbolDefinition.js'
    );

    state.db!.exec(`
      INSERT INTO files (path, hash, mtime, size, content, language, vector_index_hash)
      VALUES
        ('src/def.ts', 'hash1', 1234567890, 100, 'export function foo() {}', 'typescript', 'vec1'),
        ('src/call.ts', 'hash2', 1234567890, 100, 'foo();', 'typescript', 'vec2');

      INSERT INTO semantic_symbols (path, hash, language, name, kind, source, start_line, end_line, container_name, updated_at)
      VALUES
        ('src/def.ts', 'hash1', 'typescript', 'foo', 'function', 'tree-sitter', 1, 1, NULL, 1234567890),
        ('src/call.ts', 'hash2', 'typescript', 'foo', 'call', 'tree-sitter', 1, 1, NULL, 1234567890);
    `);

    state.getFilesChunks.mockResolvedValue(new Map());

    const result = await handleGetSymbolDefinition(
      { repo_path: '/test/repo', symbol: 'foo' },
      undefined,
      state.db!,
    );

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Found 1 symbol definitions');
    expect(text).toContain('src/def.ts');
    expect(text).not.toContain('src/call.ts');
  });
});
