/**
 * TS ↔ Rust symbols 差分对拍（P2 符号提取一致性锁）
 *
 * 对各语言样本，Rust extractSymbols 与 TS extractTreeSitterSymbols 对比
 * name / kind / startLine / endLine。
 *
 * tags.scm 查询源两侧逐字一致（Rust 用 include_str! 内嵌 npm 包的同一文件 + 同样补丁）。
 * 但 @keqingmoe/tree-sitter 与 Rust tree-sitter 的 Query.matches 顺序可能不同，
 * 故按 (name,kind,startLine,endLine) 排序后比较集合。
 *
 * 前置：需先构建 napi 模块。.node 缺失则整个 describe 跳过。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getParser } from '../../src/chunking/ParserPool.js';
import { extractTreeSitterSymbols } from '../../src/semantic/treeSitterTags.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');
const hasNative = existsSync(nativeEntry);

interface RustSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}
type RustExtract = (code: string, language: string) => RustSymbol[];

const rustExtract: RustExtract | null = hasNative
  ? (require(nativeEntry).extractSymbols as RustExtract)
  : null;

const SAMPLES: { lang: string; code: string }[] = [
  {
    lang: 'typescript',
    code: `export function add(a: number, b: number): number {
  return a + b;
}

class Calculator {
  total = 0;
  add(n: number): void {}
  reset(): void {}
}

interface Shape {
  area(): number;
}

enum Color { Red, Green }
`,
  },
  {
    lang: 'javascript',
    code: `function debounce(fn) {
  return fn;
}

class Store {
  set(k, v) {}
}
`,
  },
  {
    lang: 'python',
    code: `def greet(name):
    return name

class Animal:
    def __init__(self):
        pass

    def speak(self):
        pass
`,
  },
  {
    lang: 'go',
    code: `package main

type Greeter struct {
	Name string
}

func (g Greeter) Hello() string {
	return g.Name
}

func add(a, b int) int {
	return a + b
}
`,
  },
  {
    lang: 'rust',
    code: `fn add(a: i32, b: i32) -> i32 {
    a + b
}

struct Point {
    x: f64,
}

impl Point {
    fn norm(&self) -> f64 {
        self.x
    }
}

enum Color {
    Red,
}

trait Shape {
    fn area(&self) -> f64;
}
`,
  },
  {
    lang: 'java',
    code: `public class Counter {
    public void increment() {}
    public int get() { return 0; }
}

interface Named {
    String name();
}
`,
  },
  {
    lang: 'c',
    code: `struct Point {
    double x;
};

int add(int a, int b) {
    return a + b;
}
`,
  },
  {
    lang: 'cpp',
    code: `class Point {
public:
    double norm() const;
};

int add(int a, int b) {
    return a + b;
}
`,
  },
  {
    lang: 'c_sharp',
    code: `namespace App
{
    public class User
    {
        public void Greet() {}
    }
}
`,
  },
  {
    lang: 'ruby',
    code: `class Animal
  def speak
  end
end

module Greeting
  def self.hello
  end
end
`,
  },
  {
    lang: 'php',
    code: `<?php
class Calculator
{
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }
}

function helper(string $s): string
{
    return $s;
}
`,
  },
];

function sortSyms(syms: RustSymbol[]): RustSymbol[] {
  return [...syms].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.endLine - b.endLine;
  });
}

describe.skipIf(!hasNative)('symbols TS↔Rust 差分对拍', () => {
  for (const sample of SAMPLES) {
    it(`[${sample.lang}] symbols 集合一致`, async () => {
      const parser = await getParser(sample.lang);
      expect(parser).not.toBeNull();
      const tree = parser!.parse(sample.code);
      const grammar = parser!.getLanguage();

      const tsSymbols = await extractTreeSitterSymbols({
        tree,
        grammar,
        relPath: `sample.${sample.lang}`,
        hash: 'h',
        language: sample.lang,
      });
      const tsNorm: RustSymbol[] = tsSymbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        startLine: s.startLine,
        endLine: s.endLine ?? -1,
      }));

      const rsSymbols = (rustExtract as RustExtract)(sample.code, sample.lang);

      expect(sortSyms(rsSymbols)).toEqual(sortSyms(tsNorm));
    });
  }
});
