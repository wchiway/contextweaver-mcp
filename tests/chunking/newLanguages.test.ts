import { describe, expect, it } from 'vitest';
import { getParser } from '../../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../../src/chunking/SemanticSplitter.js';

interface Case {
  lang: string;
  file: string;
  code: string;
  /** contextPath 中预期至少出现的语义片段（任一 chunk 命中即可） */
  expectInContext: string[];
}

const cases: Case[] = [
  {
    lang: 'ruby',
    file: 'a.rb',
    code: `module Mod\n  class Foo\n    def bar(x)\n      x + 1\n    end\n  end\nend\n`,
    expectInContext: ['Foo', 'bar'],
  },
  {
    lang: 'php',
    file: 'a.php',
    code: `<?php\nclass Foo {\n  public function bar($x) {\n    return $x + 1;\n  }\n}\nfunction baz() { return 1; }\n`,
    expectInContext: ['Foo', 'bar'],
  },
  {
    lang: 'kotlin',
    file: 'a.kt',
    code: `package app\nclass Foo {\n  fun bar(x: Int): Int {\n    return x + 1\n  }\n}\nfun baz() = 1\n`,
    expectInContext: ['Foo', 'bar'],
  },
  {
    lang: 'swift',
    file: 'a.swift',
    code: `class Foo {\n  func bar(_ x: Int) -> Int {\n    return x + 1\n  }\n}\nfunc baz() -> Int { return 1 }\n`,
    expectInContext: ['Foo', 'bar'],
  },
  {
    lang: 'lua',
    file: 'a.lua',
    code: `local M = {}\nfunction M.bar(x)\n  return x + 1\nend\nlocal function baz()\n  return 1\nend\nreturn M\n`,
    expectInContext: ['bar'],
  },
  {
    lang: 'shell',
    file: 'a.sh',
    code: `#!/bin/bash\nbar() {\n  echo $(($1 + 1))\n}\nfunction baz {\n  echo 1\n}\nbar 5\n`,
    expectInContext: ['bar'],
  },
];

describe('new language AST chunking', () => {
  for (const c of cases) {
    it(`chunks ${c.lang} with semantic context`, async () => {
      const parser = await getParser(c.lang);
      expect(parser, `getParser(${c.lang}) returned null`).not.toBeNull();

      const tree = parser!.parse(c.code);
      expect(tree.rootNode.hasError, `${c.lang} parse error`).toBe(false);

      const splitter = new SemanticSplitter({ maxChunkSize: 5 });
      const chunks = splitter.split(tree, c.code, c.file, c.lang);

      expect(chunks.length, `${c.lang} produced no chunks`).toBeGreaterThan(0);

      const allContext = chunks.flatMap((ch) => ch.metadata.contextPath).join(' ');
      for (const needle of c.expectInContext) {
        expect(
          allContext,
          `${c.lang} contextPath missing "${needle}" (got: ${allContext})`,
        ).toContain(needle);
      }
    });
  }
});
