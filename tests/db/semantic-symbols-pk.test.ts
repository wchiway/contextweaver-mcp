import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { replaceSemanticSymbols, migrateSchema } from '../../src/db/index.js';
import type { SemanticSymbol } from '../../src/semantic/types.js';

describe('semantic_symbols primary key', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
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
  });

  afterEach(() => {
    db.close();
  });

  it('should handle multiple symbols with same name on same line but different end_line', () => {
    const symbols: SemanticSymbol[] = [
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'foo',
        kind: 'function',
        source: 'tree-sitter',
        startLine: 1,
        endLine: 3,
        containerName: null,
      },
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'foo',
        kind: 'function',
        source: 'tree-sitter',
        startLine: 1,
        endLine: 5, // Different end_line
        containerName: null,
      },
    ];

    // 应该不会冲突，两个符号都能插入
    expect(() => {
      replaceSemanticSymbols(db, ['test.py'], symbols);
    }).not.toThrow();

    const rows = db.prepare('SELECT * FROM semantic_symbols ORDER BY end_line').all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ name: 'foo', start_line: 1, end_line: 3 });
    expect(rows[1]).toMatchObject({ name: 'foo', start_line: 1, end_line: 5 });
  });

  it('should handle same symbol definition appearing twice (same start_line and end_line)', () => {
    const symbol: SemanticSymbol = {
      path: 'test.py',
      hash: 'hash1',
      language: 'python',
      name: 'bar',
      kind: 'function',
      source: 'tree-sitter',
      startLine: 10,
      endLine: 15,
      containerName: null,
    };

    // 第一次插入
    replaceSemanticSymbols(db, ['test.py'], [symbol]);
    let rows = db.prepare('SELECT * FROM semantic_symbols').all();
    expect(rows.length).toBe(1);

    // 第二次插入相同符号（模拟重新索引）
    replaceSemanticSymbols(db, ['test.py'], [symbol]);
    rows = db.prepare('SELECT * FROM semantic_symbols').all();
    expect(rows.length).toBe(1); // 应该只有一条记录
  });

  it('should handle symbols with different kinds on same line', () => {
    const symbols: SemanticSymbol[] = [
      {
        path: 'test.ts',
        hash: 'hash1',
        language: 'typescript',
        name: 'A',
        kind: 'class',
        source: 'tree-sitter',
        startLine: 1,
        endLine: 5,
        containerName: null,
      },
      {
        path: 'test.ts',
        hash: 'hash1',
        language: 'typescript',
        name: 'A',
        kind: 'interface',
        source: 'tree-sitter',
        startLine: 1, // Same start_line
        endLine: 3,  // Different end_line
        containerName: null,
      },
    ];

    replaceSemanticSymbols(db, ['test.ts'], symbols);

    const rows = db.prepare('SELECT * FROM semantic_symbols ORDER BY kind').all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ name: 'A', kind: 'class', end_line: 5 });
    expect(rows[1]).toMatchObject({ name: 'A', kind: 'interface', end_line: 3 });
  });

  it('should handle symbols from different sources on same line', () => {
    const symbols: SemanticSymbol[] = [
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'func',
        kind: 'function',
        source: 'tree-sitter',
        startLine: 1,
        endLine: 3,
        containerName: null,
      },
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'func',
        kind: 'function',
        source: 'ctags',
        startLine: 1, // Same start_line
        endLine: 3,  // Same end_line, but different source
        containerName: null,
      },
    ];

    replaceSemanticSymbols(db, ['test.py'], symbols);

    const rows = db.prepare('SELECT * FROM semantic_symbols ORDER BY source').all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ source: 'ctags' });
    expect(rows[1]).toMatchObject({ source: 'tree-sitter' });
  });

  it('should handle NULL end_line', () => {
    const symbols: SemanticSymbol[] = [
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'var1',
        kind: 'constant',
        source: 'ctags',
        startLine: 1,
        endLine: null, // NULL end_line
        containerName: null,
      },
      {
        path: 'test.py',
        hash: 'hash1',
        language: 'python',
        name: 'var2',
        kind: 'constant',
        source: 'ctags',
        startLine: 1,
        endLine: null, // Same NULL end_line, but different name
        containerName: null,
      },
    ];

    replaceSemanticSymbols(db, ['test.py'], symbols);

    const rows = db.prepare('SELECT * FROM semantic_symbols ORDER BY name').all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ name: 'var1', end_line: null });
    expect(rows[1]).toMatchObject({ name: 'var2', end_line: null });
  });
});
