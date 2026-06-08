/**
 * TS ↔ Rust SourceAdapter 差分对拍测试（P0 偏移域一致性锁）
 *
 * 验证 crates/chunker 的 Rust SourceAdapter 与 src/chunking/SourceAdapter.ts
 * 在 domain / getTotalNws / nws / slice / toCharOffset 上逐字段一致。
 *
 * 这是迁移正确性最致命的风险点（UTF-16 偏移域）。任一断言失败即阻断后续阶段。
 *
 * 前置：需先构建 napi 模块 —— `pnpm --filter @chiway/contextweaver-chunker build:debug`
 * 若 .node 缺失，整个 describe 跳过（避免未构建环境误报）。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SourceAdapter as TsAdapter } from '../../src/chunking/SourceAdapter.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');

const hasNative = existsSync(nativeEntry);

interface RustAdapterCtor {
  new (code: string, endIndex: number): {
    getDomain(): string;
    nws(start: number, end: number): number;
    getTotalNws(): number;
    slice(start: number, end: number): string;
    toCharOffset(offset: number): number;
  };
}

const RustAdapter: RustAdapterCtor | null = hasNative
  ? (require(nativeEntry).SourceAdapter as RustAdapterCtor)
  : null;

// 多样化语料：纯 ASCII / CJK / emoji(4字节) / 混合 / 含各类空白
const CORPUS: string[] = [
  'function add(a, b) {\n  return a + b;\n}\n',
  'const s = "你好，世界";\nlet n = 42;\n',
  'const rocket = "🚀🌟";\nconst flag = "🇨🇳";\n',
  'a你b🚀c\td\n  e   f',
  '\t\n  \r\n   ',
  'mixed 中文 and 🎉 emoji with\ttabs and\nnewlines 行尾',
  'ascii only with    multiple     spaces',
  'πλ函数定义() => { 返回值 }',
  '',
  'x',
];

function makeTs(code: string, endIndex: number) {
  return new TsAdapter({ code, endIndex });
}

describe.skipIf(!hasNative)('SourceAdapter TS↔Rust 差分对拍', () => {
  for (const [i, code] of CORPUS.entries()) {
    const utf16Len = code.length;
    const utf8Len = Buffer.byteLength(code, 'utf8');

    // 分别在 utf16 域和 utf8 域两种 endIndex 下对拍
    for (const [domainLabel, endIndex] of [
      ['utf16', utf16Len],
      ['utf8', utf8Len],
    ] as const) {
      it(`[#${i} ${domainLabel}] domain/totalNws/toCharOffset/nws/slice 一致`, () => {
        const ts = makeTs(code, endIndex);
        const rs = new (RustAdapter as RustAdapterCtor)(code, endIndex);

        // 1. domain 探测一致
        expect(rs.getDomain()).toBe(ts.getDomain());

        // 2. 总 NWS 一致
        expect(rs.getTotalNws()).toBe(ts.getTotalNws());

        // 3. toCharOffset 在所有偏移点一致
        const maxOffset = endIndex;
        for (let o = 0; o <= maxOffset; o++) {
          expect(rs.toCharOffset(o)).toBe(ts.toCharOffset(o));
        }

        // 4. nws 在多组区间一致
        for (let s = 0; s <= maxOffset; s += 2) {
          for (let e = s; e <= maxOffset; e += 3) {
            expect(rs.nws(s, e)).toBe(ts.nws(s, e));
          }
        }

        // 5. slice 在多组区间一致
        //
        // 跳过落在代理对中间的偏移：JS slice 会保留孤立代理(\uD800-\uDBFF)，
        // 而 Rust→napi 字符串边界会将其规整为 U+FFFD，二者作为 JS 字符串不相等。
        // 这是契约外的非法输入——tree-sitter 节点边界永不落在码点中间，
        // 真实流水线不会触发。仅在本暴力遍历测试中出现，故按契约跳过。
        const splitsSurrogate = (idx: number): boolean => {
          if (idx <= 0 || idx >= code.length) return false;
          const prev = code.charCodeAt(idx - 1);
          return prev >= 0xd800 && prev <= 0xdbff; // 前一个码元是高代理
        };
        for (let s = 0; s <= maxOffset; s += 2) {
          for (let e = s; e <= maxOffset; e += 3) {
            if (ts.getDomain() === 'utf16' && (splitsSurrogate(s) || splitsSurrogate(e))) {
              continue;
            }
            expect(rs.slice(s, e)).toBe(ts.slice(s, e));
          }
        }
      });
    }
  }
});
