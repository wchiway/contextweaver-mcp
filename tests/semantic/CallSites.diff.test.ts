/**
 * TS ↔ Rust callSites 差分对拍（P2 调用点一致性锁）
 *
 * 对各语言样本，Rust extractCallSites 与 TS extractCallSites 逐 CallSite 对比
 * calleeName / line / qualifier。
 *
 * 前置：需先构建 napi 模块。.node 缺失则整个 describe 跳过。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getParser } from '../../src/chunking/ParserPool.js';
import { extractCallSites, supportsCallExtraction } from '../../src/semantic/treeSitterCalls.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');
const hasNative = existsSync(nativeEntry);

interface RustCallSite {
  calleeName: string;
  line: number;
  qualifier?: string | null;
}
type RustExtract = (code: string, language: string) => RustCallSite[];

const rustExtract: RustExtract | null = hasNative
  ? (require(nativeEntry).extractCallSites as RustExtract)
  : null;

// callSites 支持 11 语言（无 shell）。复用具代表性的调用样本。
const SAMPLES: { lang: string; code: string }[] = [
  {
    lang: 'typescript',
    code: `function run() {
  foo();
  obj.bar(1, 2);
  this.baz();
  helper.deep.method();
}`,
  },
  {
    lang: 'javascript',
    code: `function run() {
  init();
  store.set('k', 1);
  arr.map(x => x);
}`,
  },
  {
    lang: 'python',
    code: `def run():
    foo()
    obj.method()
    self.helper()
    os.path.join("a", "b")
`,
  },
  {
    lang: 'go',
    code: `package main
func run() {
	foo()
	obj.Bar()
	fmt.Println("x")
}`,
  },
  {
    lang: 'rust',
    code: `fn run() {
    foo();
    obj.bar();
    self.helper();
    Vec::new();
}`,
  },
  {
    lang: 'java',
    code: `class A {
  void run() {
    foo();
    obj.bar();
    System.out.println("x");
  }
}`,
  },
  {
    lang: 'c',
    code: `int run() {
    foo();
    obj->bar();
    return baz(1, 2);
}`,
  },
  {
    lang: 'cpp',
    code: `int run() {
    foo();
    obj.bar();
    ns::func();
    return 0;
}`,
  },
  {
    lang: 'c_sharp',
    code: `class A {
  void Run() {
    Foo();
    obj.Bar();
    Console.WriteLine("x");
  }
}`,
  },
  {
    lang: 'ruby',
    code: `def run
  foo
  obj.bar
  puts "x"
end`,
  },
  {
    lang: 'php',
    code: `<?php
function run() {
  foo();
  $obj->bar();
  helper(1, 2);
}`,
  },
];

describe.skipIf(!hasNative)('callSites TS↔Rust 差分对拍', () => {
  for (const sample of SAMPLES) {
    it(`[${sample.lang}] callSites 逐字段一致`, async () => {
      expect(supportsCallExtraction(sample.lang)).toBe(true);

      const parser = await getParser(sample.lang);
      expect(parser).not.toBeNull();
      const tree = parser!.parse(sample.code);

      const tsCalls = extractCallSites(tree, sample.lang);
      const rsCalls = (rustExtract as RustExtract)(sample.code, sample.lang);

      // 规整：TS qualifier 为 undefined，Rust 为 null；统一成 null 比较
      const norm = (c: { calleeName: string; line: number; qualifier?: string | null }) => ({
        calleeName: c.calleeName,
        line: c.line,
        qualifier: c.qualifier ?? null,
      });

      expect(rsCalls.map(norm)).toEqual(tsCalls.map(norm));
    });
  }
});
