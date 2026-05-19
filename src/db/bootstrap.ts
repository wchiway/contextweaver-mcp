/**
 * Bootstrap - SQLite 与 LanceDB 跨库初始化协调（H3 修复）
 *
 * 把原先散落在 VectorStore.migrateRemoveDisplayCode + Indexer.indexFiles +
 * SearchService.init 的协调逻辑集中到此模块。
 *
 * VectorStore 现在只暴露纯 vector 操作（hasDisplayCodeColumn / readAllRowsRaw /
 * dropAndRecreateChunks），SQLite 状态机、advisory lock、抽样校验、
 * pending_marks 重放等编排在此完成。
 *
 * 每个 db 只应 bootstrap 一次（调用方用 WeakSet 守护）。
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import {
  type OldChunkRecord,
  sampleCheckDisplayCode,
  type VectorStore,
} from '../vectorStore/index.js';
import {
  clearAllVectorIndexHash,
  getLanceDbMigrationState,
  releaseLanceDbMigrationLock,
  replayPendingMarks,
  setLanceDbMigrationState,
  tryAcquireLanceDbMigrationLock,
} from './index.js';

export interface BootstrapResult {
  /** pending_marks 重放统计 */
  replay: { applied: number; discarded: number };
  /** LanceDB 迁移结果 */
  migration: {
    migrated: boolean;
    totalRows: number;
    mismatched?: number;
    reason?: string;
  };
}

export interface BootstrapOptions {
  sampleSize?: number;
  sampleMaxMismatchRatio?: number;
}

/**
 * 启动时一次性初始化：pending_marks 重放 + LanceDB schema 迁移
 *
 * 调用方：Indexer.indexFiles 与 SearchService.init（用 WeakSet 守护一次性）
 *
 * 失败处理：单步失败不阻塞整体流程（个别错误记 warn 日志，调用方继续）。
 */
export async function bootstrap(
  db: Database.Database,
  vectorStore: VectorStore,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    replay: { applied: 0, discarded: 0 },
    migration: { migrated: false, totalRows: 0 },
  };

  // 1. pending_marks 重放
  try {
    result.replay = replayPendingMarks(db);
    if (result.replay.applied > 0 || result.replay.discarded > 0) {
      logger.info(result.replay, 'pending_marks 启动重放：标记上次未收敛的索引状态');
    }
  } catch (err) {
    const error = err as { message?: string };
    logger.warn({ error: error.message }, 'pending_marks 重放失败，本次跳过');
  }

  // 2. LanceDB schema 迁移
  try {
    result.migration = await migrateRemoveDisplayCode(db, vectorStore, options);
    if (result.migration.migrated) {
      logger.info(
        { totalRows: result.migration.totalRows, reason: result.migration.reason },
        'LanceDB schema 迁移完成：chunks 表已移除 display_code/vector_text',
      );
    } else if (result.migration.reason?.startsWith('mismatch_ratio_')) {
      logger.error(
        { reason: result.migration.reason, mismatched: result.migration.mismatched },
        'LanceDB schema 迁移中止：display_code 与 files.content 抽样差异过大，' +
          '请检查索引一致性或运行 `contextweaver migrate --reset`',
      );
    }
  } catch (err) {
    const error = err as { message?: string };
    logger.warn({ error: error.message }, 'LanceDB schema 迁移失败，本次跳过');
  }

  return result;
}

/**
 * LanceDB display_code 移除迁移（H3 抽出版本）
 *
 * 编排：
 * 1. 早退 done/aborted 状态（无需锁）
 * 2. 获取 advisory lock（H2 跨进程互斥）
 * 3. 锁内重新读取状态（防并发）
 * 4. 检测 vector 表 schema 是否需迁移
 * 5. 抽样校验（用 SQLite files.content）
 * 6. clearAllVectorIndexHash + setState('pending')（CRIT-B 崩溃前置）
 * 7. drop + recreate（崩溃风险窗口）
 * 8. setState('done')
 * 9. finally: releaseLock
 */
export async function migrateRemoveDisplayCode(
  db: Database.Database,
  vectorStore: VectorStore,
  options: BootstrapOptions = {},
): Promise<{ migrated: boolean; totalRows: number; mismatched?: number; reason?: string }> {
  // 早退
  const earlyState = getLanceDbMigrationState(db);
  if (earlyState === 'done') {
    return { migrated: false, totalRows: 0, reason: 'already_migrated_persisted' };
  }
  if (earlyState === 'aborted') {
    return { migrated: false, totalRows: 0, reason: 'aborted_awaiting_manual' };
  }

  // H2: 跨进程锁
  if (!tryAcquireLanceDbMigrationLock(db)) {
    return { migrated: false, totalRows: 0, reason: 'lock_held_by_other_process' };
  }

  try {
    // 锁内重读状态
    const persistedState = getLanceDbMigrationState(db);
    if (persistedState === 'done') {
      return { migrated: false, totalRows: 0, reason: 'already_migrated_persisted' };
    }
    if (persistedState === 'aborted') {
      return { migrated: false, totalRows: 0, reason: 'aborted_awaiting_manual' };
    }

    const hasCol = await vectorStore.hasDisplayCodeColumn();

    // 'pending': 上次迁移崩溃中断
    if (persistedState === 'pending') {
      if (hasCol === null) {
        // 表已 drop，迁移半完成；新数据用新 schema 自然产生新表
        setLanceDbMigrationState(db, 'done');
        return { migrated: true, totalRows: 0, reason: 'recovered_pending_no_table' };
      }
      // 表仍存在 → 走标准流程（会再 drop+recreate）
    }

    if (hasCol === null) {
      // 全新库
      setLanceDbMigrationState(db, 'done');
      return { migrated: false, totalRows: 0, reason: 'empty' };
    }

    if (!hasCol) {
      // 已是新 schema
      setLanceDbMigrationState(db, 'done');
      return { migrated: false, totalRows: 0, reason: 'already_migrated' };
    }

    const sampleSize = options.sampleSize ?? 100;
    const maxMismatchRatio = options.sampleMaxMismatchRatio ?? 0.01;

    // 读取全表
    const oldRows = await vectorStore.readAllRowsRaw();
    const totalRows = oldRows.length;

    // 抽样校验
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
        setLanceDbMigrationState(db, 'aborted');
        return {
          migrated: false,
          totalRows,
          mismatched: check.mismatched,
          reason: `mismatch_ratio_${check.ratio.toFixed(3)}_exceeds_${maxMismatchRatio}`,
        };
      }
    }

    // 构造新 schema
    // 注意：LanceDB query 返回的 vector 可能是特殊 Vector 类型而非 plain array，
    // 直接传给 createTable 会触发 type inference 错误。这里强制转为 Array。
    const newRows = oldRows.map((r: OldChunkRecord) => ({
      chunk_id: r.chunk_id,
      file_path: r.file_path,
      file_hash: r.file_hash,
      chunk_index: r.chunk_index,
      vector: Array.from(r.vector as unknown as ArrayLike<number>),
      language: r.language,
      breadcrumb: r.breadcrumb,
      start_index: r.start_index,
      end_index: r.end_index,
      raw_start: r.raw_start,
      raw_end: r.raw_end,
      vec_start: r.vec_start,
      vec_end: r.vec_end,
    }));

    // CRIT-B: 标记 pending + 清 vector_index_hash 全表
    const cleared = clearAllVectorIndexHash(db);
    setLanceDbMigrationState(db, 'pending');

    // drop + recreate（崩溃风险窗口）
    await vectorStore.dropAndRecreateChunks(newRows as unknown as Record<string, unknown>[]);

    // 标记 done
    setLanceDbMigrationState(db, 'done');

    return { migrated: true, totalRows, reason: `cleared_${cleared}_vector_index_hash` };
  } finally {
    releaseLanceDbMigrationLock(db);
  }
}
