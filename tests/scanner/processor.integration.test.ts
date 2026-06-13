/**
 * processor 集成测试（P3）
 *
 * 验证索引流水线端到端：通过 processFiles 处理真实临时文件，
 * 确认 chunks / symbols / callSites 产物正确。
 *
 * 同时断言 Rust 原生分片器在本环境已加载（构建后应走 native 路径）。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFiles } from '../../src/scanner/processor.js';
import { getNativeChunker } from '../../src/chunking/nativeChunker.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cw-proc-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('processor 集成', () => {
  it('Rust 原生分片器已加载（构建后环境）', () => {
    expect(getNativeChunker()).not.toBeNull();
  });

  it('处理 TypeScript 文件产出 chunks/symbols/callSites', async () => {
    const rel = 'sample.ts';
    const code = `export function add(a: number, b: number): number {
  helper();
  return a + b;
}

class Calc {
  run(): void {
    this.add(1);
  }
}
`;
    const abs = path.join(dir, rel);
    writeFileSync(abs, code, 'utf8');

    const results = await processFiles(dir, [abs], new Map());
    expect(results).toHaveLength(1);
    const r = results[0];

    expect(r.status).toBe('added');
    expect(r.chunks.length).toBeGreaterThan(0);
    // 符号：至少包含 add 函数与 Calc 类
    const symNames = (r.semanticSymbols ?? []).map((s) => s.name);
    expect(symNames).toContain('add');
    expect(symNames).toContain('Calc');
    // 符号来源应为 tree-sitter（AST 成功）
    expect((r.semanticSymbols ?? []).every((s) => s.source === 'tree-sitter')).toBe(true);
    // 调用点：至少包含 helper
    const calleeNames = (r.callSites ?? []).map((c) => c.calleeName);
    expect(calleeNames).toContain('helper');
  });

  it('处理 Python 文件产出符号', async () => {
    const rel = 'sample.py';
    const code = `def greet(name):
    return name

class Animal:
    def speak(self):
        pass
`;
    const abs = path.join(dir, rel);
    writeFileSync(abs, code, 'utf8');

    const results = await processFiles(dir, [abs], new Map());
    const r = results[0];
    const symNames = (r.semanticSymbols ?? []).map((s) => s.name);
    expect(symNames).toContain('greet');
    expect(symNames).toContain('Animal');
  });
});
