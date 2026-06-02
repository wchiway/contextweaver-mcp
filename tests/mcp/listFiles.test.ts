import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  ensureIndexed: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDebugEnabled: () => false,
}));

function seedFiles(db: Database.Database): void {
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
  ).run('README.md', 'h1', 0, 512, '# readme', 'markdown');
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('src/app.ts', 'h2', 0, 128, 'export const app = 1;', 'typescript');
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('src/nested/util.ts', 'h3', 0, 256, 'export const util = 1;', 'typescript');
  db.prepare(
    'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('scripts/build.js', 'h4', 0, 96, 'console.log("build")', 'javascript');
}

describe('handleListFiles', () => {
  beforeEach(() => {
    state.db = new Database(':memory:');
    seedFiles(state.db);
    state.ensureIndexed.mockClear();
  });

  afterEach(() => {
    state.db?.close();
    state.db = null;
    vi.clearAllMocks();
  });

  it('filters by glob and language and uses SQLite-only indexing mode', async () => {
    const { handleListFiles } = await import('../../src/mcp/tools/listFiles.js');

    const response = await handleListFiles({
      repo_path: '/repo',
      glob: 'src/**/*.ts',
      language: 'typescript',
      max_results: 10,
    });

    expect(state.ensureIndexed).toHaveBeenCalledWith('/repo', 'project-test', {
      onProgress: undefined,
      vectorIndex: false,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Found 2 files');
    expect(text).toContain('src/app.ts');
    expect(text).toContain('src/nested/util.ts');
    expect(text).not.toContain('README.md');
    expect(text).not.toContain('scripts/build.js');
  });

  it('applies max_results after filtering', async () => {
    const { handleListFiles } = await import('../../src/mcp/tools/listFiles.js');

    const response = await handleListFiles({
      repo_path: '/repo',
      max_results: 2,
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Found 2 files');
    expect(text).toContain('README.md');
    expect(text).toContain('scripts/build.js');
    expect(text).not.toContain('src/app.ts');
  });
});
