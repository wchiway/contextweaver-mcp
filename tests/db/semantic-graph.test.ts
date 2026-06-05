import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  batchDelete,
  clear,
  deleteSemanticGraphForPaths,
  migrateSchema,
  replaceSemanticEdges,
  replaceSemanticSymbols,
} from '../../src/db/index.js';
import { initChunksFts, initFilesFts } from '../../src/search/fts.js';

function setupSchema(db: Database.Database): void {
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
  `);
  migrateSchema(db);
  initFilesFts(db);
  initChunksFts(db);
}

describe('semantic graph metadata', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    setupSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates semantic graph tables in schema v5', () => {
    const symbols = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_symbols'")
      .get();
    const edges = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='semantic_edges'")
      .get();
    const version = db
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string };

    expect(symbols).toBeDefined();
    expect(edges).toBeDefined();
    expect(parseInt(version.value, 10)).toBe(5);
  });

  it('replaces symbols for changed paths without touching other files', () => {
    replaceSemanticSymbols(
      db,
      ['a.ts'],
      [
        {
          path: 'a.ts',
          hash: 'h1',
          language: 'typescript',
          name: 'oldName',
          kind: 'function',
          source: 'ctags',
          startLine: 1,
          endLine: 3,
          containerName: null,
        },
        {
          path: 'b.ts',
          hash: 'h2',
          language: 'typescript',
          name: 'keptName',
          kind: 'function',
          source: 'ctags',
          startLine: 1,
          endLine: null,
          containerName: null,
        },
      ],
    );

    replaceSemanticSymbols(
      db,
      ['a.ts'],
      [
        {
          path: 'a.ts',
          hash: 'h3',
          language: 'typescript',
          name: 'newName',
          kind: 'class',
          source: 'ctags',
          startLine: 5,
          endLine: null,
          containerName: 'module',
        },
      ],
    );

    const rows = db
      .prepare('SELECT path, hash, name, kind, container_name FROM semantic_symbols ORDER BY path')
      .all() as Array<{
      path: string;
      hash: string;
      name: string;
      kind: string;
      container_name: string | null;
    }>;

    expect(rows).toEqual([
      { path: 'a.ts', hash: 'h3', name: 'newName', kind: 'class', container_name: 'module' },
      { path: 'b.ts', hash: 'h2', name: 'keptName', kind: 'function', container_name: null },
    ]);
  });

  it('replaces and deletes LSP edges by source and target paths', () => {
    replaceSemanticEdges(
      db,
      ['a.ts'],
      [
        {
          sourcePath: 'a.ts',
          sourceHash: 'hA',
          targetPath: 'b.ts',
          targetHash: 'hB',
          kind: 'reference',
          symbolName: 'target',
          sourceLine: 10,
          targetLine: 2,
          provider: 'lsp',
        },
      ],
    );
    replaceSemanticEdges(db, ['c.ts'], [
      {
        sourcePath: 'c.ts',
        sourceHash: 'hC',
        targetPath: 'a.ts',
        targetHash: 'hA',
        kind: 'call',
        symbolName: 'caller',
        sourceLine: 1,
        targetLine: 10,
        provider: 'lsp',
      },
    ]);

    deleteSemanticGraphForPaths(db, ['a.ts']);

    const count = db.prepare('SELECT COUNT(*) as c FROM semantic_edges').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('clears semantic graph rows on file delete and full clear', () => {
    db.prepare(
      'INSERT INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('a.ts', 'hA', 0, 1, 'x', 'typescript');
    replaceSemanticSymbols(db, ['a.ts'], [
      {
        path: 'a.ts',
        hash: 'hA',
        language: 'typescript',
        name: 'A',
        kind: 'class',
        source: 'ctags',
        startLine: 1,
        endLine: null,
        containerName: null,
      },
    ]);
    replaceSemanticEdges(db, ['a.ts'], [
      {
        sourcePath: 'a.ts',
        sourceHash: 'hA',
        targetPath: 'a.ts',
        targetHash: 'hA',
        kind: 'definition',
        symbolName: 'A',
        sourceLine: 1,
        targetLine: 1,
        provider: 'lsp',
      },
    ]);

    batchDelete(db, ['a.ts']);

    const symbolsAfterDelete = db.prepare('SELECT COUNT(*) as c FROM semantic_symbols').get() as {
      c: number;
    };
    const edgesAfterDelete = db.prepare('SELECT COUNT(*) as c FROM semantic_edges').get() as {
      c: number;
    };
    expect(symbolsAfterDelete.c).toBe(0);
    expect(edgesAfterDelete.c).toBe(0);

    replaceSemanticSymbols(db, ['b.ts'], [
      {
        path: 'b.ts',
        hash: 'hB',
        language: 'typescript',
        name: 'B',
        kind: 'class',
        source: 'ctags',
        startLine: 1,
        endLine: null,
        containerName: null,
      },
    ]);
    clear(db);

    const symbolsAfterClear = db.prepare('SELECT COUNT(*) as c FROM semantic_symbols').get() as {
      c: number;
    };
    expect(symbolsAfterClear.c).toBe(0);
  });
});
