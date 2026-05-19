/**
 * sampleCheckDisplayCode 测试（C2 迁移）
 *
 * 抽样校验：display_code 与 files.content.slice(raw_start, raw_end) 一致性。
 * 用于 LanceDB schema 迁移前的安全门。
 */

import { describe, expect, it } from 'vitest';
import {
  type OldChunkRecord,
  sampleCheckDisplayCode,
} from '../../src/vectorStore/index.js';

function makeRow(
  path: string,
  raw_start: number,
  raw_end: number,
  display_code: string,
): OldChunkRecord {
  return {
    chunk_id: `${path}#h#${raw_start}`,
    file_path: path,
    file_hash: 'h',
    chunk_index: raw_start,
    vector: [],
    display_code,
    language: 'typescript',
    breadcrumb: 'x',
    start_index: raw_start,
    end_index: raw_end,
    raw_start,
    raw_end,
    vec_start: raw_start,
    vec_end: raw_end,
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

  it('[S8] raw_end 越界 → 按 length 截断校验', () => {
    const rows = [makeRow('a.ts', 0, 999, 'abc')]; // content 只有 "abc"
    const result = sampleCheckDisplayCode(rows, () => 'abc');
    expect(result.mismatched).toBe(0); // slice(0, 999) on "abc" 仍是 "abc"
  });
});
