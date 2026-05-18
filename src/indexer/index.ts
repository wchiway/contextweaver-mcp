/**
 * Indexer Service - 向量索引编排层
 *
 * 负责协调 chunking → embedding → 写入 LanceDB 的完整流程
 * 核心特性：
 * - 自愈机制：检测 vector_index_hash != hash 的文件进行补索引
 * - 单调版本更新：先插入新版本再删除旧版本，避免缺失窗口
 * - 批量处理：优化 embedding API 调用
 */

import type Database from 'better-sqlite3';
import { type EmbeddingClient, getEmbeddingClient } from '../api/embedding.js';
import type { ProcessedChunk } from '../chunking/types.js';
import { batchUpdateVectorIndexHash, clearVectorIndexHash } from '../db/index.js';
import type { ProcessResult } from '../scanner/processor.js';
import {
  batchDeleteFileChunksFts,
  batchUpsertChunkFts,
  isChunksFtsInitialized,
} from '../search/fts.js';
import { logger } from '../utils/logger.js';
import { type ChunkRecord, getVectorStore, type VectorStore } from '../vectorStore/index.js';

// ===========================================
// 类型定义
// ===========================================

/** 索引统计 */
export interface IndexStats {
  indexed: number;
  deleted: number;
  errors: number;
  skipped: number;
}

/** 索引文件信息 */
interface FileToIndex {
  path: string;
  hash: string;
  chunks: ProcessedChunk[];
}

// ===========================================
// Indexer 类
// ===========================================

export class Indexer {
  private projectId: string;
  private vectorStore: VectorStore | null = null;
  private embeddingClient: EmbeddingClient;
  private vectorDim: number;

  constructor(projectId: string, vectorDim = 1024) {
    this.projectId = projectId;
    this.vectorDim = vectorDim;
    this.embeddingClient = getEmbeddingClient();
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    this.vectorStore = await getVectorStore(this.projectId, this.vectorDim);
  }

  /**
   * 处理扫描结果，更新向量索引
   *
   * @param db SQLite 数据库实例
   * @param results 文件处理结果
   * @param onProgress 可选的进度回调 (indexed, total) => void
   */
  async indexFiles(
    db: Database.Database,
    results: ProcessResult[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<IndexStats> {
    if (!this.vectorStore) {
      await this.init();
    }

    const stats: IndexStats = {
      indexed: 0,
      deleted: 0,
      errors: 0,
      skipped: 0,
    };

    // 分类处理结果
    const toIndex: FileToIndex[] = [];
    const toDelete: string[] = [];
    const noChunkSettled: Array<{ path: string; hash: string }> = [];

    for (const result of results) {
      switch (result.status) {
        case 'added':
        case 'modified':
          if (result.chunks.length > 0) {
            toIndex.push({
              path: result.relPath,
              hash: result.hash,
              chunks: result.chunks,
            });
          } else {
            // chunks 为空（解析失败或空文件）
            // 仅 modified 文件可能有旧向量记录需要清除，added 文件从未存在过向量记录
            if (result.status === 'modified') {
              toDelete.push(result.relPath);
            }
            noChunkSettled.push({
              path: result.relPath,
              hash: result.hash,
            });
            stats.skipped++;
          }
          break;

        case 'deleted':
          toDelete.push(result.relPath);
          break;

        case 'unchanged':
          stats.skipped++;
          break;

        case 'skipped':
        case 'error':
          stats.skipped++;
          break;
      }
    }

    // 处理删除
    if (toDelete.length > 0) {
      try {
        await this.deleteFiles(db, toDelete);
        stats.deleted = toDelete.length;
      } catch (err) {
        const error = err as { message?: string };
        logger.error(
          { error: error.message, count: toDelete.length },
          '删除阶段失败，已标记重试',
        );
        stats.errors += toDelete.length;
      }
    }

    // chunks 为空的文件视为已收敛：标记 vector_index_hash=hash
    // 避免这些文件在下一轮被持续判定为“需要自愈”
    if (noChunkSettled.length > 0) {
      batchUpdateVectorIndexHash(db, noChunkSettled);
      logger.debug({ count: noChunkSettled.length }, '无可索引 chunk，标记向量索引状态为已收敛');
    }

    // 批量处理需要索引的文件
    if (toIndex.length > 0) {
      const indexResult = await this.batchIndex(db, toIndex, onProgress);
      stats.indexed = indexResult.success;
      stats.errors = indexResult.errors;
    }

    logger.info(
      {
        indexed: stats.indexed,
        vectorRecordsDeleted: stats.deleted,
        errors: stats.errors,
        skipped: stats.skipped,
      },
      '向量索引完成',
    );

    return stats;
  }

  /**
   * 批量索引文件（内存优化版）
   *
   * 优化策略：
   * 1. 文件按批次处理（每批 100 个文件），避免一次性加载所有 embedding 到内存
   * 2. 每批独立完成：collect texts → embedBatch → write LanceDB → write FTS → update SQLite
   * 3. 批次间释放中间数据引用，让 GC 回收内存
   * 4. ProgressTracker 跨批次累计，总数基于所有文件
   */
  private async batchIndex(
    db: Database.Database,
    files: FileToIndex[],
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ success: number; errors: number }> {
    if (files.length === 0) {
      return { success: 0, errors: 0 };
    }

    const FILE_BATCH_SIZE = 100;
    let totalSuccess = 0;
    let totalErrors = 0;

    // 计算所有文件的总 chunk 数，用于全局进度追踪
    const totalChunks = files.reduce((sum, f) => sum + f.chunks.length, 0);
    if (totalChunks === 0) {
      return { success: 0, errors: 0 };
    }

    let completedChunks = 0;

    logger.info(
      { totalFiles: files.length, totalChunks, batches: Math.ceil(files.length / FILE_BATCH_SIZE) },
      '开始分批索引',
    );

    for (let batchStart = 0; batchStart < files.length; batchStart += FILE_BATCH_SIZE) {
      const batchFiles = files.slice(batchStart, batchStart + FILE_BATCH_SIZE);
      const batchNum = Math.floor(batchStart / FILE_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(files.length / FILE_BATCH_SIZE);

      // ===== 阶段 1: 收集本批次需要 embedding 的文本 =====
      const batchTexts: string[] = [];
      const indexByFileChunk: number[][] = [];

      for (let fileIdx = 0; fileIdx < batchFiles.length; fileIdx++) {
        const file = batchFiles[fileIdx];
        indexByFileChunk[fileIdx] = [];
        for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
          const idx = batchTexts.length;
          batchTexts.push(file.chunks[chunkIdx].vectorText);
          indexByFileChunk[fileIdx][chunkIdx] = idx;
        }
      }

      if (batchTexts.length === 0) {
        totalSuccess += batchFiles.length;
        continue;
      }

      // ===== 阶段 2: 批量获取 embeddings =====
      logger.info(
        { batch: `${batchNum}/${totalBatches}`, texts: batchTexts.length, files: batchFiles.length },
        '批次 Embedding 开始',
      );

      let embeddings: number[][];
      const EMBED_BATCH_SIZE = 10;
      try {
        // 包装 onProgress，将 embedding 子批次进度映射到全局 chunk 进度
        const batchOnProgress = onProgress
          ? (_completed: number, _total: number) => {
              // 每个 embedding 子批次完成时报告全局进度
              onProgress(completedChunks + Math.min(_completed * EMBED_BATCH_SIZE, batchTexts.length), totalChunks);
            }
          : undefined;

        const results = await this.embeddingClient.embedBatch(batchTexts, EMBED_BATCH_SIZE, batchOnProgress);
        embeddings = results.map((r) => r.embedding);
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error(
          { error: error.message, stack: error.stack, batch: `${batchNum}/${totalBatches}` },
          '批次 Embedding 失败',
        );
        clearVectorIndexHash(
          db,
          batchFiles.map((f) => f.path),
        );
        totalErrors += batchFiles.length;
        completedChunks += batchTexts.length;
        continue; // 继续处理下一批
      }

      // ===== 阶段 3: 组装 ChunkRecords =====
      const filesToUpsert: Array<{ path: string; hash: string; records: ChunkRecord[] }> = [];
      const ftsChunks: Array<{
        chunkId: string;
        filePath: string;
        chunkIndex: number;
        breadcrumb: string;
        content: string;
      }> = [];
      const successFiles: Array<{ path: string; hash: string }> = [];
      const errorFiles: string[] = [];

      for (let fileIdx = 0; fileIdx < batchFiles.length; fileIdx++) {
        const file = batchFiles[fileIdx];

        try {
          const records: ChunkRecord[] = [];

          for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
            const chunk = file.chunks[chunkIdx];
            const embIdx = indexByFileChunk[fileIdx][chunkIdx];

            if (embIdx === undefined) {
              throw new Error(`找不到 chunk 的 embedding: ${file.path}#${chunkIdx}`);
            }

            const record: ChunkRecord = {
              chunk_id: `${file.path}#${file.hash}#${chunkIdx}`,
              file_path: file.path,
              file_hash: file.hash,
              chunk_index: chunkIdx,
              vector: embeddings[embIdx],
              display_code: chunk.displayCode,
              vector_text: chunk.vectorText,
              language: chunk.metadata.language,
              breadcrumb: chunk.metadata.contextPath.join(' > '),
              start_index: chunk.metadata.startIndex,
              end_index: chunk.metadata.endIndex,
              raw_start: chunk.metadata.rawSpan.start,
              raw_end: chunk.metadata.rawSpan.end,
              vec_start: chunk.metadata.vectorSpan.start,
              vec_end: chunk.metadata.vectorSpan.end,
            };

            records.push(record);

            ftsChunks.push({
              chunkId: record.chunk_id,
              filePath: record.file_path,
              chunkIndex: record.chunk_index,
              breadcrumb: record.breadcrumb,
              content: `${record.breadcrumb}\n${record.display_code}`,
            });
          }

          filesToUpsert.push({ path: file.path, hash: file.hash, records });
          successFiles.push({ path: file.path, hash: file.hash });
        } catch (err) {
          const error = err as { message?: string; stack?: string };
          logger.error(
            { path: file.path, error: error.message, stack: error.stack },
            '组装 ChunkRecord 失败',
          );
          errorFiles.push(file.path);
        }
      }

      // ===== 阶段 4-6: 伪事务 (LanceDB → FTS → SQLite mark) =====
      // 任一阶段失败均执行补偿：
      // - LanceDB 失败：clearVectorIndexHash，下次重试
      // - FTS 失败：反向删除 LanceDB 新 hash 的 chunks，保留旧版本，不写 mark
      // - SQLite mark 失败：LanceDB 与 FTS 已有新版本，下次扫描会因 hash 匹配跳过自愈（可接受）
      if (filesToUpsert.length > 0) {
        // 阶段 4: LanceDB 写入
        try {
          await this.vectorStore?.batchUpsertFiles(filesToUpsert);
        } catch (err) {
          const error = err as { message?: string; stack?: string };
          logger.error({ error: error.message, stack: error.stack }, 'LanceDB 批量写入失败');
          clearVectorIndexHash(
            db,
            batchFiles.map((f) => f.path),
          );
          totalErrors += batchFiles.length;
          completedChunks += batchTexts.length;
          continue;
        }

        // 阶段 5: FTS 写入（失败时回滚 LanceDB）
        if (isChunksFtsInitialized(db) && ftsChunks.length > 0) {
          try {
            const pathsToDelete = filesToUpsert.map((f) => f.path);
            batchDeleteFileChunksFts(db, pathsToDelete);
            batchUpsertChunkFts(db, ftsChunks);
          } catch (err) {
            const error = err as { message?: string; stack?: string };
            logger.error(
              { error: error.message, stack: error.stack, batch: `${batchNum}/${totalBatches}` },
              'FTS 写入失败，回滚 LanceDB 新版本',
            );
            // 补偿：反向删除本批次刚 upsert 的新 hash 记录
            try {
              await this.vectorStore?.deleteFilesByHash(
                filesToUpsert.map((f) => ({ path: f.path, hash: f.hash })),
              );
            } catch (rollbackErr) {
              const rbError = rollbackErr as { message?: string };
              logger.error(
                { error: rbError.message },
                'LanceDB 回滚失败，孤儿数据将由下次 GC 清理',
              );
            }
            clearVectorIndexHash(
              db,
              batchFiles.map((f) => f.path),
            );
            totalErrors += batchFiles.length;
            completedChunks += batchTexts.length;
            continue;
          }
        }

        // 阶段 6: SQLite 标记收敛
        if (successFiles.length > 0) {
          batchUpdateVectorIndexHash(db, successFiles);
        }
      }

      totalSuccess += successFiles.length;
      totalErrors += errorFiles.length;
      completedChunks += batchTexts.length;

      logger.info(
        {
          batch: `${batchNum}/${totalBatches}`,
          success: successFiles.length,
          errors: errorFiles.length,
        },
        '批次索引完成',
      );
    }

    logger.info({ success: totalSuccess, errors: totalErrors }, '全部批次索引完成');

    return { success: totalSuccess, errors: totalErrors };
  }

  /**
   * 删除文件的向量和 FTS 索引
   *
   * 顺序：先删 FTS（SQLite 事务，可靠）→ 再删 LanceDB（可能失败）
   * 任一阶段失败均通过 clearVectorIndexHash 触发下次扫描自愈
   */
  private async deleteFiles(db: Database.Database, paths: string[]): Promise<void> {
    if (!this.vectorStore || paths.length === 0) return;

    // 1. 先删 FTS（SQLite 事务）
    if (isChunksFtsInitialized(db)) {
      try {
        batchDeleteFileChunksFts(db, paths);
      } catch (err) {
        const error = err as { message?: string };
        logger.error({ error: error.message, paths }, 'FTS 删除失败');
        clearVectorIndexHash(db, paths);
        throw err;
      }
    }

    // 2. 再删 LanceDB
    try {
      await this.vectorStore.deleteFiles(paths);
    } catch (err) {
      const error = err as { message?: string };
      logger.error({ error: error.message, paths }, 'LanceDB 删除失败，孤儿数据将由 GC 清理');
      clearVectorIndexHash(db, paths);
      throw err;
    }

    logger.debug({ count: paths.length }, '删除文件索引');
  }

  /**
   * 向量搜索
   */
  async search(queryVector: number[], limit = 10, filter?: string) {
    if (!this.vectorStore) {
      await this.init();
    }
    return this.vectorStore?.search(queryVector, limit, filter);
  }

  /**
   * 文本搜索（先 embedding 再向量搜索）
   */
  async textSearch(query: string, limit = 10, filter?: string) {
    const queryVector = await this.embeddingClient.embed(query);
    return this.search(queryVector, limit, filter);
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    if (!this.vectorStore) {
      await this.init();
    }
    await this.vectorStore?.clear();
  }

  /**
   * 垃圾回收：清理 LanceDB 中的孤儿 chunks
   *
   * 孤儿来源：
   * - 事务补偿失败遗留（FTS 回滚成功但 LanceDB 删除失败）
   * - 跨进程崩溃导致的 hash 不匹配残留
   * - 删除流程失败遗留
   *
   * 算法：以 SQLite files 表 (path, hash) 为权威源，删除 LanceDB 中不存在的组合。
   * 同步清理 chunks_fts：仅当 path 在 SQLite 完全不存在时才删（hash 变化的 FTS 由 upsert 覆盖）。
   *
   * 性能护栏：time budget 默认 5s，超时则跳过避免阻塞扫描主流程。
   */
  async gc(
    db: Database.Database,
    options: { maxScanMs?: number } = {},
  ): Promise<{ orphans: number; truncated?: boolean }> {
    if (!this.vectorStore) {
      await this.init();
    }

    const startTime = Date.now();
    const timeBudget = options.maxScanMs ?? 5000;

    // 1. 拉取 LanceDB 所有 (path, hash) 组合
    let vectorPairs: Array<{ path: string; hash: string }>;
    try {
      vectorPairs = (await this.vectorStore?.listFileHashes()) ?? [];
    } catch (err) {
      const error = err as { message?: string };
      logger.warn({ error: error.message }, 'GC: listFileHashes 失败，跳过');
      return { orphans: 0 };
    }

    if (vectorPairs.length === 0) return { orphans: 0 };

    if (Date.now() - startTime > timeBudget) {
      logger.warn(
        { elapsed: Date.now() - startTime, budget: timeBudget },
        'GC 超时（拉取阶段），本次跳过',
      );
      return { orphans: 0, truncated: true };
    }

    // 2. 构建 SQLite 权威集合
    const sqliteRows = db.prepare('SELECT path, hash FROM files').all() as Array<{
      path: string;
      hash: string;
    }>;
    const validPairs = new Set(sqliteRows.map((r) => `${r.path} ${r.hash}`));
    const sqlitePaths = new Set(sqliteRows.map((r) => r.path));

    // 3. 找出孤儿
    const orphans = vectorPairs.filter((p) => !validPairs.has(`${p.path} ${p.hash}`));

    if (orphans.length === 0) return { orphans: 0 };

    logger.info({ count: orphans.length }, 'GC: 发现孤儿 chunks');

    // 4. 删除 LanceDB 孤儿
    try {
      await this.vectorStore?.deleteFilesByHash(orphans);
    } catch (err) {
      const error = err as { message?: string };
      logger.warn({ error: error.message }, 'GC: LanceDB 删除失败，下次重试');
      return { orphans: 0 };
    }

    // 5. 同步清理 chunks_fts（仅 path 已从 SQLite 移除的情况）
    const pathsToFtsClean = Array.from(new Set(orphans.map((o) => o.path))).filter(
      (p) => !sqlitePaths.has(p),
    );
    if (pathsToFtsClean.length > 0 && isChunksFtsInitialized(db)) {
      try {
        batchDeleteFileChunksFts(db, pathsToFtsClean);
      } catch (err) {
        const error = err as { message?: string };
        logger.warn({ error: error.message }, 'GC: chunks_fts 清理失败');
      }
    }

    return { orphans: orphans.length };
  }

  /**
   * 获取索引统计
   */
  async getStats(): Promise<{ totalChunks: number }> {
    if (!this.vectorStore) {
      await this.init();
    }
    const count = (await this.vectorStore?.count()) ?? 0;
    return { totalChunks: count };
  }
}

// ===========================================
// 工厂函数
// ===========================================

const indexers = new Map<string, Indexer>();

/**
 * 获取或创建 Indexer 实例
 */
export async function getIndexer(projectId: string, vectorDim = 1024): Promise<Indexer> {
  let indexer = indexers.get(projectId);
  if (!indexer) {
    indexer = new Indexer(projectId, vectorDim);
    await indexer.init();
    indexers.set(projectId, indexer);
  }
  return indexer;
}

/**
 * 关闭所有 Indexer
 */
export function closeAllIndexers(): void {
  indexers.clear();
}
