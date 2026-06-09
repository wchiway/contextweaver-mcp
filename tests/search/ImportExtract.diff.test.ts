/**
 * TS ↔ Rust import extract 差分对拍（P1 导入提取一致性锁）
 *
 * 对各 resolver kind 的样本，断言 Rust native extractImports 与 TS 正则
 * extract() 输出逐字相等（顺序敏感）。Rust 输出破坏一致性会直接破坏下游
 * resolve()，故此测试是硬约束。
 *
 * 前置：需先构建 napi 模块。.node 缺失则整个 describe 跳过。
 *
 * TS 基线：直接调用各 resolver 实例的 extract()。由于 resolver 在 native
 * 可用时会路由到 native，这里改为对每个 kind 内联与 resolver 源码一致的
 * 正则作为 TS 基线（与现有 *.diff.test.ts 的对拍范式一致）。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');
const hasNative = existsSync(nativeEntry);

type RustExtract = (kind: string, content: string) => string[];
const rustExtract: RustExtract | null = hasNative
  ? (require(nativeEntry).extractImports as RustExtract)
  : null;

// ── TS 基线：与 src/search/resolvers/*.ts 源码逐字一致的正则提取 ──

function tsJsTs(content: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const p of patterns) for (const m of content.matchAll(p)) out.push(m[1]);
  return out;
}
function tsPython(content: string): string[] {
  const out: string[] = [];
  const p = /^\s*(?:from\s+(\.{0,3}[\w.]*)\s+import|import\s+([\w.]+))/gm;
  for (const m of content.matchAll(p)) {
    const s = m[1] || m[2];
    if (s) out.push(s);
  }
  return out;
}
function tsGo(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]);
  for (const blk of content.matchAll(/import\s*\(\s*([\s\S]*?)\s*\)/g)) {
    for (const lm of blk[1].matchAll(/"([^"]+)"/g)) out.push(lm[1]);
  }
  return out;
}
function tsJava(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+);/gm)) out.push(m[1]);
  return out;
}
function tsRust(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) out.push(`mod:${m[1]}`);
  for (const m of content.matchAll(
    /^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm,
  ))
    out.push(`use:${m[1]}`);
  return out;
}
function tsCpp(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) out.push(m[1]);
  return out;
}
function tsCsharp(content: string): string[] {
  const out: string[] = [];
  const p = /^\s*using\s+(?!static\s)(?!global\s)(?:\w+\s*=\s*)?([\w.]+);/gm;
  for (const m of content.matchAll(p)) out.push(m[1]);
  return out;
}

const TS_BASELINE: Record<string, (c: string) => string[]> = {
  jsts: tsJsTs,
  python: tsPython,
  go: tsGo,
  java: tsJava,
  rust: tsRust,
  cpp: tsCpp,
  csharp: tsCsharp,
};

// ── 覆盖各分支与边界的样本 ──

const SAMPLES: { kind: string; name: string; code: string }[] = [
  {
    kind: 'jsts',
    name: 'static/dynamic/require + 注释内伪 import',
    code: `import { a, b } from './foo';
export * from "./bar";
const m = require('./baz');
await import('./qux');
// import { z } from './should-still-match-regex';
const s = "import x from './in-string'";`,
  },
  {
    kind: 'python',
    name: '相对/绝对/多级点',
    code: `from ..utils import x
from . import y
import os
from my.pkg.mod import z
import a.b.c`,
  },
  {
    kind: 'go',
    name: '单行 + 块导入',
    code: `package main
import "fmt"
import (
\t"os"
\t"github.com/user/repo/pkg"
)`,
  },
  {
    kind: 'java',
    name: 'plain + static',
    code: `import com.example.Foo;
import static com.example.Bar.baz;
import a.b.C;`,
  },
  {
    kind: 'rust',
    name: 'pub mod / mod / use crate|super|self（外部 use std 应被排除）',
    code: `pub mod foo;
mod bar;
use crate::a::b;
use super::c;
use self::d::e;
use std::collections::HashMap;`,
  },
  {
    kind: 'cpp',
    name: '引号 include（忽略尖括号）',
    code: `#include "local.h"
#include <vector>
#  include "a/b.hpp"
#include <string>`,
  },
  {
    kind: 'csharp',
    name: 'plain / alias / 排除 static & global',
    code: `using System.Collections;
using static System.Math;
global using System.Linq;
using Alias = System.Text;
using staticFoo.Bar;`,
  },
];

describe.skipIf(!hasNative)('import extract TS↔Rust 差分对拍', () => {
  for (const s of SAMPLES) {
    it(`[${s.kind}] ${s.name}`, () => {
      const ts = TS_BASELINE[s.kind](s.code);
      const rs = (rustExtract as RustExtract)(s.kind, s.code);
      expect(rs).toEqual(ts);
    });
  }

  it('未知 kind 返回空', () => {
    expect((rustExtract as RustExtract)('kotlin', 'import x.y.Z;')).toEqual([]);
  });

  // repo 内真实源文件抽样：TS 与 Rust 对同一文件提取一致
  it('repo 真实源文件抽样一致', () => {
    const cases: { kind: string; file: string }[] = [
      { kind: 'jsts', file: '../../src/search/GraphExpander.ts' },
      { kind: 'jsts', file: '../../src/search/resolvers/index.ts' },
      { kind: 'rust', file: '../../crates/chunker/src/lib.rs' },
    ];
    for (const c of cases) {
      const abs = path.resolve(here, c.file);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf-8');
      const ts = TS_BASELINE[c.kind](content);
      const rs = (rustExtract as RustExtract)(c.kind, content);
      expect(rs, `mismatch for ${c.file}`).toEqual(ts);
    }
  });
});
