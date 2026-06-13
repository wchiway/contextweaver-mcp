/**
 * TS ↔ Rust SemanticSplitter 差分对拍（P1 chunks 一致性锁）
 *
 * 对真实代码样本，TS splitter.split(tree,...) 与 Rust splitFile(...) 在相同配置下
 * 逐 chunk 对比: displayCode / vectorText / nwsSize / 所有偏移 / contextPath。
 *
 * 前置：需先构建 napi 模块。.node 缺失则整个 describe 跳过。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SemanticSplitter } from '../../src/chunking/SemanticSplitter.js';
import { getParser } from '../../src/chunking/ParserPool.js';
import type { ProcessedChunk } from '../../src/chunking/types.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');
const hasNative = existsSync(nativeEntry);

interface RustSplitterConfig {
  maxChunkSize?: number;
  minChunkSize?: number;
  chunkOverlap?: number;
  maxRawChars?: number;
}
type RustSplitFile = (
  code: string,
  filePath: string,
  language: string,
  config?: RustSplitterConfig,
) => ProcessedChunk[];

const splitFile: RustSplitFile | null = hasNative
  ? (require(nativeEntry).splitFile as RustSplitFile)
  : null;

// P1 scope grammars: typescript / javascript / python / rust / go / java / c /
// cpp / c_sharp / ruby / php / shell
const SAMPLES: { lang: string; file: string; code: string }[] = [
  {
    lang: 'typescript',
    file: 'sample.ts',
    code: `// header comment
import { foo } from './foo';

/** doc for add */
export function add(a: number, b: number): number {
  return a + b;
}

class Calculator {
  private total = 0;

  // accumulate
  add(n: number): void {
    this.total += n;
  }

  reset(): void {
    this.total = 0;
  }
}

interface Shape {
  area(): number;
}
`,
  },
  {
    lang: 'javascript',
    file: 'sample.js',
    code: `// utils
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

class Store {
  constructor() {
    this.state = {};
  }

  set(k, v) {
    this.state[k] = v;
  }
}
`,
  },
  {
    lang: 'python',
    file: 'sample.py',
    code: `import os

# module-level comment
def greet(name):
    """Say hello."""
    return f"Hello, {name}"

class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        raise NotImplementedError

def main():
    a = Animal("cat")
    print(greet(a.name))
`,
  },
  {
    lang: 'rust',
    file: 'sample.rs',
    code: `use std::collections::HashMap;

/// Adds two numbers.
fn add(a: i32, b: i32) -> i32 {
    a + b
}

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    // distance from origin
    fn norm(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

enum Color {
    Red,
    Green,
    Blue,
}
`,
  },
  {
    lang: 'go',
    file: 'sample.go',
    code: `package main

import "fmt"

// Greeter greets.
type Greeter struct {
	Name string
}

func (g Greeter) Hello() string {
	return "Hello, " + g.Name
}

func add(a, b int) int {
	return a + b
}

func main() {
	fmt.Println(add(1, 2))
}
`,
  },
  {
    lang: 'java',
    file: 'Sample.java',
    code: `package com.example;

/** A simple counter. */
public class Counter {
    private int count;

    public void increment() {
        count++;
    }

    public int get() {
        return count;
    }
}

interface Named {
    String name();
}
`,
  },
  {
    lang: 'c',
    file: 'sample.c',
    code: `#include <stdio.h>

/* point struct */
struct Point {
    double x;
    double y;
};

int add(int a, int b) {
    return a + b;
}

int main(void) {
    printf("%d\\n", add(1, 2));
    return 0;
}
`,
  },
  {
    lang: 'cpp',
    file: 'sample.cpp',
    code: `#include <string>

namespace geo {

class Point {
public:
    Point(double x, double y) : x_(x), y_(y) {}
    double norm() const;

private:
    double x_;
    double y_;
};

}  // namespace geo

int main() {
    return 0;
}
`,
  },
  {
    lang: 'c_sharp',
    file: 'Sample.cs',
    code: `using System;

namespace App
{
    // entity
    public class User
    {
        public string Name { get; set; }

        public void Greet()
        {
            Console.WriteLine($"Hi {Name}");
        }
    }

    public interface IRepo
    {
        User Find(int id);
    }
}
`,
  },
  {
    lang: 'ruby',
    file: 'sample.rb',
    code: `module Greeting
  # base class
  class Animal
    def initialize(name)
      @name = name
    end

    def speak
      raise NotImplementedError
    end
  end

  def self.hello(name)
    "Hello, #{name}"
  end
end
`,
  },
  {
    lang: 'php',
    file: 'sample.php',
    code: `<?php

namespace App;

// service
class Calculator
{
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }

    public function reset(): void
    {
    }
}

function helper(string $s): string
{
    return trim($s);
}
`,
  },
  {
    lang: 'shell',
    file: 'sample.sh',
    code: `#!/usr/bin/env bash
set -euo pipefail

# greet the user
greet() {
  local name="$1"
  echo "Hello, $name"
}

main() {
  greet "world"
}

main "$@"
`,
  },
];

// 多组配置，覆盖小块/大块/有无 overlap
const CONFIGS: RustSplitterConfig[] = [
  { maxChunkSize: 500, minChunkSize: 50, chunkOverlap: 40 }, // processor.ts 实际配置
  { maxChunkSize: 30, minChunkSize: 5, chunkOverlap: 0 }, // 强制细碎切分
  { maxChunkSize: 80, minChunkSize: 10, chunkOverlap: 20 }, // 中等 + overlap
];

function normalize(c: ProcessedChunk) {
  return {
    displayCode: c.displayCode,
    vectorText: c.vectorText,
    nwsSize: c.nwsSize,
    startIndex: c.metadata.startIndex,
    endIndex: c.metadata.endIndex,
    rawSpan: c.metadata.rawSpan,
    vectorSpan: c.metadata.vectorSpan,
    contextPath: c.metadata.contextPath,
  };
}

describe.skipIf(!hasNative)('SemanticSplitter TS↔Rust 差分对拍', () => {
  for (const sample of SAMPLES) {
    for (const [ci, config] of CONFIGS.entries()) {
      it(`[${sample.lang} cfg#${ci}] chunks 逐字段一致`, async () => {
        const parser = await getParser(sample.lang);
        expect(parser).not.toBeNull();
        const tree = parser!.parse(sample.code);

        const tsSplitter = new SemanticSplitter(config);
        const tsChunks = tsSplitter.split(tree, sample.code, sample.file, sample.lang);
        const rsChunks = (splitFile as RustSplitFile)(
          sample.code,
          sample.file,
          sample.lang,
          config,
        );

        expect(rsChunks.length).toBe(tsChunks.length);
        for (let i = 0; i < tsChunks.length; i++) {
          expect(normalize(rsChunks[i]), `chunk #${i}`).toEqual(normalize(tsChunks[i]));
        }
      });
    }
  }
});
