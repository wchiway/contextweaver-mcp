/**
 * H4 测试：LanceDB chunk_id 去重
 *
 * 模拟 LanceDB 无 PK 的特性：直接 add 不去重。
 * 验证 batchUpsertFiles 在崩溃 retry 场景下不会产生重复 chunk_id。
 *
 * 不依赖 native 模块，仅模拟 LanceDB Table 的 add/delete 语义。
 */

import { describe, expect, it } from 'vitest';

/** 模拟 LanceDB chunks 表（无 PK，允许重复 chunk_id） */
class MockTable {
  rows: Array<{
    chunk_id: string;
    file_path: string;
    file_hash: string;
    [k: string]: unknown;
  }> = [];

  async add(records: Array<Record<string, unknown>>): Promise<void> {
    for (const r of records) {
      // 真实 LanceDB 行为：无 PK 校验，直接追加
      this.rows.push(r as MockTable['rows'][number]);
    }
  }

  /**
   * 简化的 filter：仅支持
   * - `file_path = 'X' AND file_hash != 'Y'`
   * - `(file_path = 'X' AND file_hash = 'Y') OR ...`
   */
  async delete(filter: string): Promise<void> {
    // 把 filter 拆成 OR 子句
    const clauses = filter.split(' OR ').map((c) => c.trim().replace(/^\(|\)$/g, ''));
    this.rows = this.rows.filter((row) => {
      // 任何子句匹配 → 删除
      for (const clause of clauses) {
        // 解析: file_path = 'X' AND file_hash <op> 'Y'
        const m = clause.match(
          /file_path\s*=\s*'([^']*)'\s+AND\s+file_hash\s*(=|!=)\s*'([^']*)'/,
        );
        if (!m) continue;
        const [, p, op, h] = m;
        if (row.file_path !== p) continue;
        if (op === '=' && row.file_hash === h) return false; // 删
        if (op === '!=' && row.file_hash !== h) return false; // 删
      }
      return true; // 保留
    });
  }

  countByChunkId(chunkId: string): number {
    return this.rows.filter((r) => r.chunk_id === chunkId).length;
  }
}

/** 模拟 batchUpsertFiles 中 add+delete 的核心逻辑（H4 修复版） */
async function simulateBatchUpsert(
  table: MockTable,
  files: Array<{
    path: string;
    hash: string;
    records: Array<{ chunk_id: string; file_path: string; file_hash: string }>;
  }>,
): Promise<void> {
  // H4: 预删除 (path, newHash)
  const preDeleteFilter = files
    .map((f) => `(file_path = '${f.path}' AND file_hash = '${f.hash}')`)
    .join(' OR ');
  await table.delete(preDeleteFilter);

  // add
  const allRecords = files.flatMap((f) => f.records);
  await table.add(allRecords as Array<Record<string, unknown>>);

  // 删除旧版本
  const oldDeleteFilter = files
    .map((f) => `(file_path = '${f.path}' AND file_hash != '${f.hash}')`)
    .join(' OR ');
  await table.delete(oldDeleteFilter);
}

describe('H4: LanceDB chunk_id 重复防护', () => {
  it('[H4-1] 单次 upsert 不产生重复', async () => {
    const table = new MockTable();
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hA',
        records: [
          { chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' },
          { chunk_id: 'a.ts#hA#1', file_path: 'a.ts', file_hash: 'hA' },
        ],
      },
    ]);

    expect(table.rows).toHaveLength(2);
    expect(table.countByChunkId('a.ts#hA#0')).toBe(1);
    expect(table.countByChunkId('a.ts#hA#1')).toBe(1);
  });

  it('[H4-2] 关键场景：同 (path, hash) 二次 upsert 不产生重复 chunk_id', async () => {
    const table = new MockTable();
    const records = [
      { chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' },
      { chunk_id: 'a.ts#hA#1', file_path: 'a.ts', file_hash: 'hA' },
    ];

    // 第一次写入
    await simulateBatchUpsert(table, [{ path: 'a.ts', hash: 'hA', records }]);
    expect(table.rows).toHaveLength(2);

    // 模拟崩溃后 retry：重新提交同 hash 同记录
    await simulateBatchUpsert(table, [{ path: 'a.ts', hash: 'hA', records }]);

    // H4 修复后：仍只有 2 行，每个 chunk_id 唯一
    expect(table.rows).toHaveLength(2);
    expect(table.countByChunkId('a.ts#hA#0')).toBe(1);
    expect(table.countByChunkId('a.ts#hA#1')).toBe(1);
  });

  it('[H4-3] hash 变化时旧版本被清理（保持原语义）', async () => {
    const table = new MockTable();

    // 写入 hashA
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hA',
        records: [{ chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' }],
      },
    ]);

    // 写入 hashB（hash 变化）
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hB',
        records: [
          { chunk_id: 'a.ts#hB#0', file_path: 'a.ts', file_hash: 'hB' },
          { chunk_id: 'a.ts#hB#1', file_path: 'a.ts', file_hash: 'hB' },
        ],
      },
    ]);

    expect(table.rows).toHaveLength(2);
    expect(table.rows.every((r) => r.file_hash === 'hB')).toBe(true);
    expect(table.countByChunkId('a.ts#hA#0')).toBe(0);
  });

  it('[H4-4] 跨文件 batch：仅清理 batch 内涉及的 path', async () => {
    const table = new MockTable();

    // 写 A 和 B
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hA',
        records: [{ chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' }],
      },
      {
        path: 'b.ts',
        hash: 'hB',
        records: [{ chunk_id: 'b.ts#hB#0', file_path: 'b.ts', file_hash: 'hB' }],
      },
    ]);
    expect(table.rows).toHaveLength(2);

    // 只更新 A（同 hash retry）
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hA',
        records: [{ chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' }],
      },
    ]);

    expect(table.rows).toHaveLength(2); // A 不重复 + B 不动
    expect(table.countByChunkId('b.ts#hB#0')).toBe(1);
  });

  it('[H4-5] 模拟孤儿场景：表中已有同 (path, hash) 残留行，retry 应去重', async () => {
    const table = new MockTable();

    // 模拟上次崩溃残留：手动注入孤儿
    table.rows.push({ chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' });
    table.rows.push({ chunk_id: 'a.ts#hA#1', file_path: 'a.ts', file_hash: 'hA' });

    // retry
    await simulateBatchUpsert(table, [
      {
        path: 'a.ts',
        hash: 'hA',
        records: [
          { chunk_id: 'a.ts#hA#0', file_path: 'a.ts', file_hash: 'hA' },
          { chunk_id: 'a.ts#hA#1', file_path: 'a.ts', file_hash: 'hA' },
        ],
      },
    ]);

    expect(table.rows).toHaveLength(2); // 孤儿被清掉
    expect(table.countByChunkId('a.ts#hA#0')).toBe(1);
    expect(table.countByChunkId('a.ts#hA#1')).toBe(1);
  });
});
