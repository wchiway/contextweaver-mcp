/**
 * sampleCheckDisplayCode 测试（C2 迁移 + CRIT-A 修复）
 *
 * 抽样校验：display_code 与 files.content.slice(start_index, end_index) 一致性。
 * 注意：CRIT-A 之前用 raw_start/raw_end 切片是错误的（含前置 gap），
 * 现已改为用 start_index/end_index（与 SemanticSplitter 中 displayCode 同源）。
 */

import { describe, expect, it } from 'vitest';
import {
  type OldChunkRecord,
  sampleCheckDisplayCode,
} from '../../src/vectorStore/index.js';

/** 构造测试行：默认 start_index = raw_start，模拟首个 chunk 无 gap 场景 */
function makeRow(
  path: string,
  start_index: number,
  end_index: number,
  display_code: string,
  rawSpan?: { start: number; end: number },
): OldChunkRecord {
  const raw_start = rawSpan?.start ?? start_index;
  const raw_end = rawSpan?.end ?? end_index;
  return {
    chunk_id: `${path}#h#${start_index}`,
    file_path: path,
    file_hash: 'h',
    chunk_index: start_index,
    vector: [],
    display_code,
    language: 'typescript',
    breadcrumb: 'x',
    start_index,
    end_index,
    raw_start,
    raw_end,
    vec_start: start_index,
    vec_end: end_index,
  };
}

describe('sampleCheckDisplayCode (C2 迁移抽样校验)', () => {
  it('[S1] 全部一致 → abort=false, mismatched=0', () => {
    const rows = [
      makeRow('a.ts', 0, 5, 'hello'),
      makeRow('a.ts', 6, 11, 'world'),
    ];
    const files = new Map([['a.ts', 'hello world']]);
    const result = sampleCheckDisplayCode(rows, (p) => files.get(p) ?? null);

    expect(result.abort).toBe(false);
    expect(result.mismatched).toBe(0);
    expect(result.sampled).toBe(2);
    expect(result.ratio).toBe(0);
  });

  it('[S2] 全部不一致 → abort=true', () => {
    const rows = [
      makeRow('a.ts', 0, 5, 'WRONG'),
      makeRow('a.ts', 6, 11, 'ALSO_WRONG'),
    ];
    const files = new Map([['a.ts', 'hello world']]);
    const result = sampleCheckDisplayCode(rows, (p) => files.get(p) ?? null);

    expect(result.abort).toBe(true);
    expect(result.mismatched).toBe(2);
    expect(result.ratio).toBe(1);
  });

  it('[S3] 1% 阈值：1/100 不匹配 → 不 abort', () => {
    const rows: OldChunkRecord[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(makeRow('a.ts', i, i + 1, String.fromCharCode(97 + (i % 26))));
    }
    // 故意制造 1 个 mismatch
    rows[50].display_code = 'X';

    const content = Array.from({ length: 100 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    const result = sampleCheckDisplayCode(rows, () => content, {
      sampleSize: 100,
      maxMismatchRatio: 0.01,
    });

    expect(result.sampled).toBe(100);
    expect(result.mismatched).toBe(1);
    expect(result.ratio).toBe(0.01);
    expect(result.abort).toBe(false); // 0.01 > 0.01 = false（等于不 abort）
  });

  it('[S4] 1% 阈值：2/100 不匹配 → abort', () => {
    const rows: OldChunkRecord[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(makeRow('a.ts', i, i + 1, String.fromCharCode(97 + (i % 26))));
    }
    rows[10].display_code = 'X';
    rows[50].display_code = 'Y';

    const content = Array.from({ length: 100 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    const result = sampleCheckDisplayCode(rows, () => content, {
      sampleSize: 100,
      maxMismatchRatio: 0.01,
    });

    expect(result.mismatched).toBe(2);
    expect(result.ratio).toBe(0.02);
    expect(result.abort).toBe(true);
  });

  it('[S5] SQLite 中 path 已删 → 跳过，不计 mismatch', () => {
    const rows = [
      makeRow('exists.ts', 0, 5, 'hello'),
      makeRow('deleted.ts', 0, 5, 'whatever'),
    ];
    const files = new Map([['exists.ts', 'hello']]);
    const result = sampleCheckDisplayCode(rows, (p) => files.get(p) ?? null);

    expect(result.sampled).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.abort).toBe(false);
  });

  it('[S6] 空表 → abort=false', () => {
    const result = sampleCheckDisplayCode([], () => null);
    expect(result.abort).toBe(false);
    expect(result.sampled).toBe(0);
  });

  it('[S7] 大表等距抽样：sampleSize=10, totalRows=1000', () => {
    const rows: OldChunkRecord[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push(makeRow('a.ts', i, i + 1, 'x'));
    }
    const result = sampleCheckDisplayCode(rows, () => 'x'.repeat(1001), {
      sampleSize: 10,
    });
    expect(result.sampled).toBe(10);
    expect(result.mismatched).toBe(0);
  });

  it('[S8] end_index 越界 → 按 length 截断校验', () => {
    const rows = [makeRow('a.ts', 0, 999, 'abc')]; // content 只有 "abc"
    const result = sampleCheckDisplayCode(rows, () => 'abc');
    expect(result.mismatched).toBe(0); // slice(0, 999) on "abc" 仍是 "abc"
  });

  it('[S9] CRIT-A 关键场景：raw_start ≠ start_index（含 gap）→ 用 start_index 校验通过', () => {
    // 模拟 SemanticSplitter 真实产物：
    // 文件内容: "hello\n   world"
    // chunk0: start=[0,5) "hello"，rawSpan=[0,5)
    // chunk1: start=[9,14) "world"，rawSpan=[5,14) 含前置 gap "\n   "
    const content = 'hello\n   world';
    const rows = [
      makeRow('a.ts', 0, 5, 'hello', { start: 0, end: 5 }),
      makeRow('a.ts', 9, 14, 'world', { start: 5, end: 14 }), // raw_start=5 ≠ start_index=9
    ];
    const result = sampleCheckDisplayCode(rows, () => content);

    expect(result.sampled).toBe(2);
    expect(result.mismatched).toBe(0); // 修复前用 raw_start 会得到 "\n   w"，必然 mismatch
    expect(result.abort).toBe(false);
  });

  it('[S10] CRIT-A 反例：start_index 错误（指向 gap）→ 应 abort', () => {
    // 故意把 start_index 设错（指向 raw_start），display_code 与切片不符
    const content = 'hello\n   world';
    const rows = [
      makeRow('a.ts', 5, 14, 'world', { start: 5, end: 14 }), // start_index=5 错误，正确应是 9
    ];
    const result = sampleCheckDisplayCode(rows, () => content, { maxMismatchRatio: 0 });

    expect(result.mismatched).toBe(1);
    expect(result.abort).toBe(true); // 阈值 0 时 1/1 > 0 触发
  });
});
