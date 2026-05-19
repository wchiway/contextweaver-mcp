/**
 * VectorStore - LanceDB 适配层
 *
 * 负责 chunks 表的管理，支持：
 * - 单调版本更新（先插后删）避免缺失窗口
 * - 批量插入和查询
 * - 文件级删除
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');

// ===========================================
// 类型定义
// ===========================================

/** Chunk 记录（存储在 LanceDB 中） */
export interface ChunkRecord {
  /** 主键: file_path#file_hash#chunk_index */
  chunk_id: string;
  /** 相对路径 */
  file_path: string;
  /** 文件内容 hash */
  file_hash: string;
  /** 文件内序号 */
  chunk_index: number;
  /** embedding 向量 */
  vector: number[];
  /** 语言 */
  language: string;
  /** 面包屑路径 */
  breadcrumb: string;
  /** 语义起始偏移量 */
  start_index: number;
  /** 语义结束偏移量 */
  end_index: number;
  /** rawSpan.start - 与 files.content 配合切出原始正文（C2） */
  raw_start: number;
  /** rawSpan.end - 与 files.content 配合切出原始正文（C2） */
  raw_end: number;
  /** vectorSpan.start */
  vec_start: number;
  /** vectorSpan.end */
  vec_end: number;
}

/** 向量搜索结果 */
export interface SearchResult extends ChunkRecord {
  _distance: number;
}

/** 旧 LanceDB 行（v2 schema，含 display_code） */
export interface OldChunkRecord extends ChunkRecord {
  display_code: string;
  vector_text?: string;
}

/**
 * 抽样校验：对比 oldRows 中的 display_code 与 files.content.slice(raw_start, raw_end)
 *
 * 用于 C2 LanceDB schema 迁移前的安全校验。差异比例超过阈值时返回 abort=true。
 * 抽样以 step = max(1, floor(totalRows / sampleSize)) 等距抽取，避免全表扫描。
 *
 * SQLite 中已不存在的 path（如已删文件）跳过，不计入 mismatch。
 *
 * 导出供独立单元测试。
 */
export function sampleCheckDisplayCode(
  oldRows: OldChunkRecord[],
  getContent: (path: string) => string | null,
  options: { sampleSize?: number; maxMismatchRatio?: number } = {},
): { abort: boolean; sampled: number; mismatched: number; ratio: number } {
  const sampleSize = options.sampleSize ?? 100;
  const maxMismatchRatio = options.maxMismatchRatio ?? 0.01;

  if (oldRows.length === 0) {
    return { abort: false, sampled: 0, mismatched: 0, ratio: 0 };
  }

  const indices: number[] = [];
  const step = Math.max(1, Math.floor(oldRows.length / sampleSize));
  for (let i = 0; i < oldRows.length && indices.length < sampleSize; i += step) {
    indices.push(i);
  }

  let sampled = 0;
  let mismatched = 0;
  for (const idx of indices) {
    const r = oldRows[idx];
    const content = getContent(r.file_path);
    if (content === null) continue; // path 已删，跳过
    sampled++;
    // CRIT-A: 使用 start_index/end_index（与 displayCode 同源），而非 raw_start/raw_end
    // raw_start = prevEnd 包含前置 gap，与 display_code 字段语义不符
    const safeStart = Math.max(0, Math.min(r.start_index, content.length));
    const safeEnd = Math.max(safeStart, Math.min(r.end_index, content.length));
    const expected = content.slice(safeStart, safeEnd);
    if (expected !== r.display_code) {
      mismatched++;
    }
  }

  const ratio = sampled > 0 ? mismatched / sampled : 0;
  return { abort: ratio > maxMismatchRatio, sampled, mismatched, ratio };
}

// ===========================================
// VectorStore 类
// ===========================================

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private projectId: string;
  private dbPath: string;
  private vectorDim: number;

  constructor(projectId: string, vectorDim = 1024) {
    this.projectId = projectId;
    this.dbPath = path.join(BASE_DIR, projectId, 'vectors.lance');
    this.vectorDim = vectorDim;
  }

  /**
   * 初始化连接
   */
  async init(): Promise<void> {
    if (this.db) return;

    // 确保目录存在
    const projectDir = path.join(BASE_DIR, this.projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    this.db = await lancedb.connect(this.dbPath);

    // 获取或创建 chunks 表
    const tableNames = await this.db.tableNames();
    if (tableNames.includes('chunks')) {
      this.table = await this.db.openTable('chunks');
    }
    // 表不存在时，首次插入会自动创建
  }

  /**
   * 确保表存在（首次插入时调用）
   */
  private async ensureTable(records: ChunkRecord[]): Promise<void> {
    if (this.table) return;
    if (!this.db) throw new Error('VectorStore not initialized');
    if (records.length === 0) return;

    // 创建表并插入初始数据
    // 注意：LanceDB 期望 Record<string, unknown>[]，但 ChunkRecord 没有索引签名
    // 运行时两者等价，使用类型断言绕过 TypeScript 的严格检查
    this.table = await this.db.createTable(
      'chunks',
      records as unknown as Record<string, unknown>[],
    );
  }

  /**
   * C2 迁移：移除 chunks 表中的 display_code / vector_text 列
   *
   * LanceDB 不支持 ALTER DROP COLUMN，方案为 dropTable + recreate：
   * 1. 读取所有现有 chunks，仅保留新 schema 字段（含 raw_start/raw_end 用于回查正文）
   * 2. 抽样校验：display_code vs files.content.slice(raw_start, raw_end)
   *    差异比例 > sampleMaxMismatchRatio 则中止迁移
   * 3. drop chunks 表 + 用新 schema 重建
   *
   * 幂等：若表中已无 display_code 列，直接返回。
   *
   * @returns 迁移摘要；migrated=false 表示无需迁移或被中止
   */
  async migrateRemoveDisplayCode(
    db: import('better-sqlite3').Database,
    options: { sampleSize?: number; sampleMaxMismatchRatio?: number } = {},
  ): Promise<{ migrated: boolean; totalRows: number; mismatched?: number; reason?: string }> {
    if (!this.db) throw new Error('VectorStore not initialized');

    // CRIT-B: 检查持久化状态，决定是否需要恢复
    const { getLanceDbMigrationState, setLanceDbMigrationState, clearAllVectorIndexHash } =
      await import('../db/index.js');
    const persistedState = getLanceDbMigrationState(db);

    // 'done': 已迁移完成，直接退出
    if (persistedState === 'done') {
      return { migrated: false, totalRows: 0, reason: 'already_migrated_persisted' };
    }

    // 'aborted': 上次校验失败，等待人工干预（CRIT-C 负责入口逻辑）
    if (persistedState === 'aborted') {
      return { migrated: false, totalRows: 0, reason: 'aborted_awaiting_manual' };
    }

    // 'pending': 上次迁移崩溃中断
    // - 此时所有 vector_index_hash 已被清空，文件会被自愈机制重建
    // - LanceDB 状态可能是：旧表（崩溃前 dropTable 未执行）/ 表已 drop / 部分新表
    // - 安全处理：如果表已不存在，setLanceDbMigrationState('done') 即可
    //   （新写入会用新 schema 自然产生新表）；如果旧表残留，继续走迁移流程
    if (persistedState === 'pending') {
      if (!this.table) {
        // 表已 drop，迁移半完成；新数据会用新 schema 写入
        setLanceDbMigrationState(db, 'done');
        return { migrated: true, totalRows: 0, reason: 'recovered_pending_no_table' };
      }
      // 表仍存在 → 继续走下面的标准流程（会再次 drop+recreate）
    }

    if (!this.table) {
      // 全新库，没有任何 chunks → 直接标 'done'
      setLanceDbMigrationState(db, 'done');
      return { migrated: false, totalRows: 0, reason: 'empty' };
    }

    // 检查 schema 是否含 display_code
    const schema = await this.table.schema();
    const hasDisplayCode = schema.fields.some((f) => f.name === 'display_code');
    if (!hasDisplayCode) {
      // 已是新 schema（手工迁移过的库等）→ 标 'done'
      setLanceDbMigrationState(db, 'done');
      return { migrated: false, totalRows: 0, reason: 'already_migrated' };
    }

    const sampleSize = options.sampleSize ?? 100;
    const maxMismatchRatio = options.sampleMaxMismatchRatio ?? 0.01;

    // 1. 读取全表
    const oldRows = (await this.table.query().toArray()) as OldChunkRecord[];

    const totalRows = oldRows.length;

    // 2. 抽样校验
    if (totalRows > 0) {
      const stmt = db.prepare('SELECT content FROM files WHERE path = ?');
      const getContent = (path: string): string | null => {
        const row = stmt.get(path) as { content: string | null } | undefined;
        return row?.content ?? null;
      };
      const check = sampleCheckDisplayCode(oldRows, getContent, {
        sampleSize,
        maxMismatchRatio,
      });
      if (check.abort) {
        // CRIT-C: 持久化 abort 状态，阻止后续写入污染 schema
        setLanceDbMigrationState(db, 'aborted');
        return {
          migrated: false,
          totalRows,
          mismatched: check.mismatched,
          reason: `mismatch_ratio_${check.ratio.toFixed(3)}_exceeds_${maxMismatchRatio}`,
        };
      }
    }

    // 3. 构造新 schema 记录（剥离 display_code / vector_text）
    const newRows = oldRows.map((r) => ({
      chunk_id: r.chunk_id,
      file_path: r.file_path,
      file_hash: r.file_hash,
      chunk_index: r.chunk_index,
      vector: r.vector,
      language: r.language,
      breadcrumb: r.breadcrumb,
      start_index: r.start_index,
      end_index: r.end_index,
      raw_start: r.raw_start,
      raw_end: r.raw_end,
      vec_start: r.vec_start,
      vec_end: r.vec_end,
    }));

    // 4. CRIT-B: 标记 pending + 清 vector_index_hash 全表
    //    这一步必须在 dropTable 之前，保证崩溃后自愈机制能触发全量重建。
    const cleared = clearAllVectorIndexHash(db);
    setLanceDbMigrationState(db, 'pending');

    // 5. drop + recreate（崩溃风险窗口）
    await this.db.dropTable('chunks');
    this.table = null;
    if (newRows.length > 0) {
      this.table = await this.db.createTable(
        'chunks',
        newRows as unknown as Record<string, unknown>[],
      );
    }

    // 6. 标记 done
    setLanceDbMigrationState(db, 'done');

    return { migrated: true, totalRows, reason: `cleared_${cleared}_vector_index_hash` };
  }

  /**
   * 单调版本更新：先插入新版本，再删除旧版本
   *
   * 这保证了：
   * - 最坏情况（崩溃）是新旧版本共存（不缺失）
   * - 正常情况下旧版本被清理
   */
  async upsertFile(filePath: string, newHash: string, records: ChunkRecord[]): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized');

    if (records.length === 0) {
      // 如果没有新 chunks，也要删除旧版本（文件可能变成空/无法解析）
      await this.deleteFile(filePath);
      return;
    }

    // 1. 插入新版本
    if (!this.table) {
      await this.ensureTable(records);
    } else {
      await this.table.add(records as unknown as Record<string, unknown>[]);
    }

    // 2. 删除旧版本（file_hash != newHash）
    if (this.table) {
      await this.table.delete(
        `file_path = '${this.escapeString(filePath)}' AND file_hash != '${this.escapeString(newHash)}'`,
      );
    }
  }

  /**
   * 批量 upsert 多个文件（性能优化版，带分批机制）
   *
   * 流程：
   * 1. 将文件分成小批次（每批最多 BATCH_FILES 个文件或 BATCH_RECORDS 条记录）
   * 2. 每批执行：插入新 records → 删除旧版本
   *
   * 分批是必要的，因为 LanceDB native 模块在处理超大数据时可能崩溃
   *
   * @param files 文件列表，每个包含 path、hash 和 records
   */
  async batchUpsertFiles(
    files: Array<{ path: string; hash: string; records: ChunkRecord[] }>,
  ): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized');
    if (files.length === 0) return;

    // 分批参数（经验值，避免 native 模块崩溃）
    const BATCH_FILES = 50; // 每批最多 50 个文件
    const BATCH_RECORDS = 5000; // 每批最多 5000 条 records

    // 构建批次
    const batches: Array<typeof files> = [];
    let currentBatch: typeof files = [];
    let currentRecordCount = 0;

    for (const file of files) {
      // 检查是否需要开始新批次
      if (
        currentBatch.length >= BATCH_FILES ||
        currentRecordCount + file.records.length > BATCH_RECORDS
      ) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = [];
        currentRecordCount = 0;
      }
      currentBatch.push(file);
      currentRecordCount += file.records.length;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    // 逐批处理
    for (const batch of batches) {
      // 收集本批次的所有 records
      const batchRecords: ChunkRecord[] = [];
      for (const file of batch) {
        batchRecords.push(...file.records);
      }

      if (batchRecords.length === 0) {
        // 本批次没有 chunks，只删除旧版本
        const pathsToDelete = batch.map((f) => f.path);
        await this.deleteFiles(pathsToDelete);
        continue;
      }

      // H4 修复：预删除 (path, newHash) 组合
      //
      // 场景：上次崩溃后 LanceDB 残留同 (path, newHash) 的孤儿（如 FTS 回滚成功但
      // LanceDB 删除失败的边界情况）。LanceDB 无 PK，直接 add 会让 chunk_id 重复，
      // 导致向量搜索返回重复行。
      //
      // 策略：先按 (path, newHash) 精确删除（覆盖孤儿），再 add 新数据，
      // 最后按 path AND != newHash 清理任何更旧的版本（兜底）。
      if (this.table && batch.length > 0) {
        await this.deleteFilesByHash(
          batch.map((f) => ({ path: f.path, hash: f.hash })),
        );
      }

      // 1. 批量插入本批次的 records
      if (!this.table) {
        await this.ensureTable(batchRecords);
      } else {
        await this.table.add(batchRecords as unknown as Record<string, unknown>[]);
      }

      // 2. 批量删除本批次的旧版本（hash != newHash）
      if (this.table && batch.length > 0) {
        const deleteConditions = batch
          .map(
            (f) =>
              `(file_path = '${this.escapeString(f.path)}' AND file_hash != '${this.escapeString(f.hash)}')`,
          )
          .join(' OR ');
        await this.table.delete(deleteConditions);
      }
    }
  }

  /**
   * 列出所有 chunks 的 (file_path, file_hash) 唯一组合
   *
   * 用于 GC 阶段对比 SQLite 权威数据，识别孤儿 chunks。
   * 性能优化：仅 select 两列，按 (path, hash) 去重后返回。
   */
  async listFileHashes(): Promise<Array<{ path: string; hash: string }>> {
    if (!this.table) return [];

    // LanceDB 0.22 query().select() 支持列投影
    const rows = (await this.table
      .query()
      .select(['file_path', 'file_hash'])
      .toArray()) as Array<{ file_path: string; file_hash: string }>;

    const seen = new Set<string>();
    const result: Array<{ path: string; hash: string }> = [];
    for (const r of rows) {
      const key = `${r.file_path} ${r.file_hash}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ path: r.file_path, hash: r.file_hash });
      }
    }
    return result;
  }

  /**
   * 删除文件的所有 chunks
   */
  async deleteFile(filePath: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`file_path = '${this.escapeString(filePath)}'`);
  }

  /**
   * 按 (file_path, file_hash) 精确删除 chunks
   *
   * 用于事务补偿：当下游写入（如 FTS）失败时，反向删除已 upsert 的新版本，
   * 保留旧版本不动，确保 vector_index_hash 仍指向旧 hash 时 LanceDB 状态一致。
   */
  async deleteFilesByHash(items: Array<{ path: string; hash: string }>): Promise<void> {
    if (!this.table || items.length === 0) return;

    const BATCH_SIZE = 500;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const conditions = batch
        .map(
          (it) =>
            `(file_path = '${this.escapeString(it.path)}' AND file_hash = '${this.escapeString(it.hash)}')`,
        )
        .join(' OR ');
      await this.table.delete(conditions);
    }
  }

  /**
   * 批量删除文件（性能优化：单次 DELETE 替代 N 次循环）
   * 当文件数超过 500 时分批处理，防止 LanceDB filter 字符串过长
   */
  async deleteFiles(filePaths: string[]): Promise<void> {
    if (!this.table || filePaths.length === 0) return;

    const BATCH_SIZE = 500;

    if (filePaths.length <= BATCH_SIZE) {
      // 小批量：单次查询
      const conditions = filePaths.map((p) => `file_path = '${this.escapeString(p)}'`).join(' OR ');
      await this.table.delete(conditions);
    } else {
      // 大批量：分批处理
      for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
        const batch = filePaths.slice(i, i + BATCH_SIZE);
        const conditions = batch.map((p) => `file_path = '${this.escapeString(p)}'`).join(' OR ');
        await this.table.delete(conditions);
      }
    }
  }

  /**
   * 向量搜索
   */
  async search(queryVector: number[], limit = 10, filter?: string): Promise<SearchResult[]> {
    if (!this.table) return [];

    let query = this.table.vectorSearch(queryVector).limit(limit);

    if (filter) {
      query = query.where(filter);
    }

    const results = await query.toArray();
    return results as SearchResult[];
  }

  /**
   * 获取文件的所有 chunks（按 chunk_index 排序）
   */
  async getFileChunks(filePath: string): Promise<ChunkRecord[]> {
    if (!this.table) return [];

    const results = await this.table
      .query()
      .where(`file_path = '${this.escapeString(filePath)}'`)
      .toArray();

    // 按 chunk_index 排序，确保返回顺序稳定
    const chunks = results as ChunkRecord[];
    return chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  }

  /**
   * 批量获取多个文件的 chunks（性能优化：单次查询替代 N 次循环）
   * 当文件数超过 500 时分批处理，防止 LanceDB filter 字符串过长
   *
   * 适用于 GraphExpander 扩展、词法召回等需要批量获取的场景
   * @returns Map<filePath, ChunkRecord[]>，每个文件的 chunks 已按 chunk_index 排序
   */
  async getFilesChunks(filePaths: string[]): Promise<Map<string, ChunkRecord[]>> {
    const result = new Map<string, ChunkRecord[]>();
    if (!this.table || filePaths.length === 0) return result;

    const BATCH_SIZE = 500;

    // 分批查询（小于等于 BATCH_SIZE 时只执行一次）
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      const conditions = batch.map((p) => `file_path = '${this.escapeString(p)}'`).join(' OR ');
      const rows = await this.table.query().where(conditions).toArray();

      // 按文件分组
      for (const row of rows as ChunkRecord[]) {
        let arr = result.get(row.file_path);
        if (!arr) {
          arr = [];
          result.set(row.file_path, arr);
        }
        arr.push(row);
      }
    }

    // 每个文件内按 chunk_index 排序
    for (const arr of result.values()) {
      arr.sort((a, b) => a.chunk_index - b.chunk_index);
    }

    return result;
  }

  /**
   * 获取表的总记录数
   */
  async count(): Promise<number> {
    if (!this.table) return 0;
    return await this.table.countRows();
  }

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.dropTable('chunks');
      this.table = null;
    } catch {
      // 表不存在，忽略
    }
  }

  /**
   * 获取向量维度
   */
  getVectorDim(): number {
    return this.vectorDim;
  }

  /**
   * 转义字符串（防止 SQL 注入）
   */
  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    this.db = null;
    this.table = null;
  }
}

// ===========================================
// 工厂函数
// ===========================================

const vectorStores = new Map<string, VectorStore>();

/**
 * 获取或创建 VectorStore 实例
 */
export async function getVectorStore(projectId: string, vectorDim = 1024): Promise<VectorStore> {
  let store = vectorStores.get(projectId);
  if (!store) {
    store = new VectorStore(projectId, vectorDim);
    await store.init();
    vectorStores.set(projectId, store);
  }
  return store;
}

/**
 * 关闭所有 VectorStore 连接
 */
export async function closeAllVectorStores(): Promise<void> {
  for (const store of vectorStores.values()) {
    await store.close();
  }
  vectorStores.clear();
}
