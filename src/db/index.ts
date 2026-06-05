import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initChunksFts, initFilesFts } from '../search/fts.js';
import { logger } from '../utils/logger.js';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');

/**
 * 文件元数据接口
 */
export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  content: string | null;
  language: string;
  /** 已成功写入向量索引的 hash（自愈机制核心字段） */
  vectorIndexHash: string | null;
}

export type VectorManifestStatus = 'pending' | 'ready' | 'failed';

export interface VectorManifestItem {
  path: string;
  hash: string;
  chunkCount: number;
  embeddingDimensions: number;
}

export interface VectorManifestCounts {
  pending: number;
  ready: number;
  failed: number;
}

/**
 * 获取目录的创建时间（birthtime）
 * 优先使用 .git 目录的创建时间，否则使用根目录的创建时间
 * @param projectPath 项目根路径
 * @returns 创建时间的毫秒时间戳，如果无法获取则返回 0
 */
function getDirectoryBirthtime(projectPath: string): number {
  // 优先检查 .git 目录（更稳定的仓库标识）
  const gitDir = path.join(projectPath, '.git');
  try {
    const gitStats = fs.statSync(gitDir);
    if (gitStats.isDirectory() && gitStats.birthtimeMs) {
      return Math.floor(gitStats.birthtimeMs);
    }
  } catch {
    // .git 目录不存在，继续检查根目录
  }

  // 使用根目录的创建时间
  try {
    const rootStats = fs.statSync(projectPath);
    if (rootStats.birthtimeMs) {
      return Math.floor(rootStats.birthtimeMs);
    }
  } catch {
    // 无法获取根目录信息
  }

  return 0;
}

/**
 * 生成项目唯一 ID
 * 基于路径 + 目录创建时间生成，确保删除后重建的同路径代码库会生成不同的 ID
 * @param projectPath 项目根路径
 * @returns 项目 ID (MD5 hash)
 */
export function generateProjectId(projectPath: string): string {
  const birthtime = getDirectoryBirthtime(projectPath);
  const uniqueKey = `${projectPath}::${birthtime}`;
  return crypto.createHash('md5').update(uniqueKey).digest('hex').slice(0, 10);
}

/**
 * 初始化数据库连接
 * @param projectId 项目 ID
 * @returns 数据库实例
 */
export function initDb(projectId: string): Database.Database {
  // 确保目录存在
  const projectDir = path.join(BASE_DIR, projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  const dbPath = path.join(projectDir, 'index.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  // 创建 files 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT,
      language TEXT NOT NULL,
      vector_index_hash TEXT
    )
  `);

  // 迁移：如果表已存在但缺少 vector_index_hash 列，添加它
  try {
    db.exec('ALTER TABLE files ADD COLUMN vector_index_hash TEXT');
  } catch {
    // 列已存在，忽略错误
  }

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);
  `);

  // 创建 metadata 表（存储项目级配置）
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Schema 迁移（必须在 FTS 初始化前）
  migrateSchema(db);

  // 初始化 FTS 表（词法搜索支持）
  initFilesFts(db);
  initChunksFts(db);

  // 性能优化：SQLite PRAGMA
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');

  return db;
}

// ===========================================
// Schema 迁移
// ===========================================

const CURRENT_SCHEMA_VERSION = 4;
const METADATA_KEY_SCHEMA_VERSION = 'schema_version';

/**
 * 获取当前 schema 版本
 * - null：v1.1.0 之前的旧库（未写过 schema_version）
 * - number：已写入版本号
 */
function getSchemaVersion(db: Database.Database): number | null {
  // metadata 表此时已存在（initDb 中先创建）
  const row = db
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .get(METADATA_KEY_SCHEMA_VERSION) as { value: string } | undefined;
  if (!row) return null;
  const parsed = parseInt(row.value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(METADATA_KEY_SCHEMA_VERSION, String(version));
}

/**
 * 检测旧库 files_fts 是否为独立内容表（v1 格式）
 *
 * v1: CREATE VIRTUAL TABLE files_fts USING fts5(path, content, tokenize=...)
 * v2: CREATE VIRTUAL TABLE files_fts USING fts5(..., content='files', ...)
 *
 * 通过查询 sqlite_master.sql 中是否包含 content='files' 判断。
 */
function isOldFilesFtsSchema(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='files_fts'`)
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;
  return !row.sql.includes("content='files'");
}

/**
 * 主迁移入口
 *
 * 调用时机：initDb 中、initFilesFts 之前
 * 保证迁移在 FTS 重建之前完成。
 */
export function migrateSchema(db: Database.Database): void {
  const backupExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts_v1_backup'`)
    .get();
  const currentFtsExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'`)
    .get();
  if (backupExists && currentFtsExists && !isOldFilesFtsSchema(db)) {
    logger.warn('检测到残留备份表 files_fts_v1_backup，清理中');
    db.exec('DROP TABLE files_fts_v1_backup');
  }

  const current = getSchemaVersion(db);

  if (current === null) {
    const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const ftsExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'`)
      .get();

    if (fileCount === 0 && !ftsExists) {
      migrateToV3(db);
      migrateToV4(db);
      setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
      return;
    }
  }

  if ((current ?? 1) < 2) {
    migrateToV2(db);
    setSchemaVersion(db, 2);
  }

  if ((current ?? 2) < 3) {
    migrateToV3(db);
    setSchemaVersion(db, 3);
  }

  if ((current ?? 3) < 4) {
    migrateToV4(db);
    setSchemaVersion(db, 4);
  }
}

/**
 * v1 → v2 迁移：files_fts 改为外部内容表
 *
 * 流程：
 * 1. RENAME 旧 files_fts → files_fts_v1_backup
 * 2. 让调用方 initFilesFts 创建新表（content='files'）
 * 3. INSERT INTO files_fts(files_fts) VALUES('rebuild') 从 files 重建倒排索引
 * 4. DROP 备份表
 *
 * 失败处理：任何步骤抛错都会冒泡，但备份表保留以便人工恢复。
 */
function migrateToV2(db: Database.Database): void {
  // 仅当 files_fts 存在且是旧 schema 时才迁移
  const ftsExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'`)
    .get();

  if (!ftsExists) {
    // 没有 files_fts，无需迁移（initFilesFts 后续创建新表）
    return;
  }

  if (!isOldFilesFtsSchema(db)) {
    // 已经是新 schema，跳过
    return;
  }

  logger.info('执行 schema 迁移 v1 → v2: files_fts 转为外部内容表');

  // 备份旧表（DROP 而非 RENAME，因为 FTS5 虚拟表 RENAME 在某些版本有 bug）
  // 此时正文数据已在 files.content 中，可安全删除 FTS 副本
  db.exec('DROP TABLE files_fts');

  // 后续 initFilesFts 会创建新表 + 触发器
  // 新表创建后，需要从 files 重建索引：这里只设置一个标记，
  // 真正的 rebuild 在 initFilesFts 创建完表后调用
  // 但 initFilesFts 当前不知道是否需要 rebuild，所以我们直接重建
  // —— 改为：在 migrateToV2 内创建表并 rebuild，让 initFilesFts 的 IF NOT EXISTS 跳过
  // 但 detectFtsTokenizer 在 fts.ts 中，这里访问不到 ...
  // 解决方案：导出 detectFtsTokenizer 或在 migrateToV2 中用固定 tokenizer 探测

  // 使用与 initFilesFts 相同的探测逻辑（避免循环依赖，复制实现）
  let tokenizer: 'trigram' | 'unicode61';
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(content, tokenize='trigram');
       DROP TABLE IF EXISTS _fts_probe;`,
    );
    tokenizer = 'trigram';
  } catch {
    tokenizer = 'unicode61';
  }

  db.exec(`
    CREATE VIRTUAL TABLE files_fts USING fts5(
        path,
        content,
        content='files',
        content_rowid='rowid',
        tokenize='${tokenizer}'
    );
  `);

  // 从 files 表重建倒排索引
  // 外部内容表的 'rebuild' 命令会扫描源表所有行
  db.exec(`INSERT INTO files_fts(files_fts) VALUES('rebuild')`);

  logger.info('schema 迁移 v1 → v2 完成');
}

/**
 * v2 → v3 迁移：新增 pending_marks outbox 表
 *
 * 用于 C1 修复：vector_index_hash 更新阶段失败时，已写入 LanceDB+FTS
 * 的成功记录会落入 outbox，下次启动时 replayPendingMarks 重放，
 * 避免重复 embedding。
 *
 * created_at 用于诊断异常积累。
 */
function migrateToV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_marks (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  logger.info('schema 迁移 v2 → v3 完成: pending_marks 表已创建');
}

function migrateToV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_manifest (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedding_dimensions INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vector_manifest_status ON vector_manifest(status);
    CREATE INDEX IF NOT EXISTS idx_vector_manifest_hash ON vector_manifest(hash);
  `);

  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO vector_manifest (
      path,
      hash,
      status,
      chunk_count,
      embedding_dimensions,
      error_message,
      updated_at
    )
    SELECT
      path,
      hash,
      CASE WHEN vector_index_hash = hash THEN 'ready' ELSE 'pending' END,
      0,
      0,
      NULL,
      ?
    FROM files
  `).run(now);

  logger.info('schema 迁移 v3 → v4 完成: vector_manifest 表已创建');
}

/**
 * 插入 outbox 标记（在 FTS 写入成功的同一 SQLite 事务中调用）
 */
export function insertPendingMarks(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  if (items.length === 0) return;
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO pending_marks (path, hash, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at
  `);
  const tx = db.transaction((data: typeof items) => {
    for (const it of data) {
      insert.run(it.path, it.hash, now);
    }
  });
  tx(items);
}

/**
 * 删除 outbox 标记（在 vector_index_hash 标记成功的同一事务中调用）
 */
export function deletePendingMarks(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  const del = db.prepare('DELETE FROM pending_marks WHERE path = ?');
  const tx = db.transaction((items: string[]) => {
    for (const p of items) del.run(p);
  });
  tx(paths);
}

/**
 * 启动时重放 outbox：将 pending_marks 中残留的标记应用到 vector_index_hash
 *
 * 触发场景：上次运行时 LanceDB+FTS 成功写入，但 SQLite 标记阶段崩溃/失败。
 *
 * Hash mismatch 守卫：仅当 files.hash 仍等于 outbox.hash 时才更新，
 * 避免文件已再次变更后误覆盖。不匹配的 outbox 记录也会清理（已无意义）。
 *
 * @returns 已处理的记录数（含 hash 不匹配被丢弃的）
 */
export function replayPendingMarks(db: Database.Database): {
  applied: number;
  discarded: number;
} {
  const rows = db.prepare('SELECT path, hash FROM pending_marks').all() as Array<{
    path: string;
    hash: string;
  }>;
  if (rows.length === 0) return { applied: 0, discarded: 0 };

  const update = db.prepare(`
    UPDATE files SET vector_index_hash = ?
    WHERE path = ? AND hash = ?
  `);
  const markReady = db.prepare(`
    UPDATE vector_manifest
    SET status = 'ready', error_message = NULL, updated_at = ?
    WHERE path = ? AND hash = ?
  `);
  const del = db.prepare('DELETE FROM pending_marks WHERE path = ?');

  let applied = 0;
  let discarded = 0;
  const now = Date.now();

  const tx = db.transaction(() => {
    for (const r of rows) {
      const info = update.run(r.hash, r.path, r.hash);
      if (info.changes > 0) {
        markReady.run(now, r.path, r.hash);
        applied++;
      } else {
        discarded++;
      }
      del.run(r.path);
    }
  });
  tx();

  if (applied > 0 || discarded > 0) {
    logger.info({ applied, discarded }, 'pending_marks 重放完成');
  }
  return { applied, discarded };
}

export function upsertVectorManifestPending(
  db: Database.Database,
  items: VectorManifestItem[],
): void {
  if (items.length === 0) return;
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO vector_manifest (
      path,
      hash,
      status,
      chunk_count,
      embedding_dimensions,
      error_message,
      updated_at
    )
    VALUES (?, ?, 'pending', ?, ?, NULL, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      status = 'pending',
      chunk_count = excluded.chunk_count,
      embedding_dimensions = excluded.embedding_dimensions,
      error_message = NULL,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((data: VectorManifestItem[]) => {
    for (const item of data) {
      upsert.run(item.path, item.hash, item.chunkCount, item.embeddingDimensions, now);
    }
  });
  tx(items);
}

export function markVectorManifestReady(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  if (items.length === 0) return;
  const now = Date.now();
  const update = db.prepare(`
    UPDATE vector_manifest
    SET status = 'ready', error_message = NULL, updated_at = ?
    WHERE path = ? AND hash = ?
  `);
  const tx = db.transaction((data: Array<{ path: string; hash: string }>) => {
    for (const item of data) {
      update.run(now, item.path, item.hash);
    }
  });
  tx(items);
}

export function markVectorManifestFailed(
  db: Database.Database,
  items: Array<{ path: string; hash: string; error?: string }>,
): void {
  if (items.length === 0) return;
  const now = Date.now();
  const update = db.prepare(`
    UPDATE vector_manifest
    SET status = 'failed', error_message = ?, updated_at = ?
    WHERE path = ? AND hash = ?
  `);
  const tx = db.transaction((data: Array<{ path: string; hash: string; error?: string }>) => {
    for (const item of data) {
      update.run(item.error ?? null, now, item.path, item.hash);
    }
  });
  tx(items);
}

export function deleteVectorManifest(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  const del = db.prepare('DELETE FROM vector_manifest WHERE path = ?');
  const tx = db.transaction((items: string[]) => {
    for (const path of items) del.run(path);
  });
  tx(paths);
}

export function getReadyVectorFileHashes(
  db: Database.Database,
  paths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const BATCH_SIZE = 500;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT f.path, f.hash
        FROM files f
        JOIN vector_manifest vm ON vm.path = f.path
        WHERE f.path IN (${placeholders})
          AND f.vector_index_hash = f.hash
          AND vm.hash = f.hash
          AND vm.status = 'ready'
      `)
      .all(...batch) as Array<{ path: string; hash: string }>;

    for (const row of rows) result.set(row.path, row.hash);
  }

  return result;
}

export function getVectorManifestCounts(db: Database.Database): VectorManifestCounts {
  const rows = db
    .prepare('SELECT status, COUNT(*) as count FROM vector_manifest GROUP BY status')
    .all() as Array<{ status: VectorManifestStatus; count: number }>;
  const counts: VectorManifestCounts = { pending: 0, ready: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/**
 * 获取 pending_marks 中的标记数（诊断用）
 */
export function countPendingMarks(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM pending_marks').get() as { c: number };
  return row.c;
}

/**
 * 关闭数据库连接
 */
export function closeDb(db: Database.Database): void {
  db.close();
}

/**
 * 获取所有文件元数据
 */
export function getAllFileMeta(
  db: Database.Database,
): Map<string, Pick<FileMeta, 'mtime' | 'hash' | 'size' | 'vectorIndexHash'>> {
  const rows = db
    .prepare('SELECT path, hash, mtime, size, vector_index_hash FROM files')
    .all() as Array<{
    path: string;
    hash: string;
    mtime: number;
    size: number;
    vector_index_hash: string | null;
  }>;

  const map = new Map();
  for (const row of rows) {
    map.set(row.path, {
      mtime: row.mtime,
      hash: row.hash,
      size: row.size,
      vectorIndexHash: row.vector_index_hash,
    });
  }
  return map;
}

/**
 * 获取需要向量索引的文件路径
 * 自愈机制：返回 vector_index_hash != hash 的文件
 */
export function getFilesNeedingVectorIndex(db: Database.Database): string[] {
  const rows = db
    .prepare(`
      SELECT f.path
      FROM files f
      LEFT JOIN vector_manifest vm ON vm.path = f.path
      WHERE f.vector_index_hash IS NULL
        OR f.vector_index_hash != f.hash
        OR vm.path IS NULL
        OR vm.hash != f.hash
        OR vm.status != 'ready'
    `)
    .all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * 批量更新 vector_index_hash
 * 只有当向量完整写入成功后才调用
 */
export function batchUpdateVectorIndexHash(
  db: Database.Database,
  items: Array<{ path: string; hash: string }>,
): void {
  if (items.length === 0) return;
  const now = Date.now();
  const updateFile = db.prepare('UPDATE files SET vector_index_hash = ? WHERE path = ?');
  const upsertManifest = db.prepare(`
    INSERT INTO vector_manifest (
      path,
      hash,
      status,
      chunk_count,
      embedding_dimensions,
      error_message,
      updated_at
    )
    VALUES (?, ?, 'ready', 0, 0, NULL, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      status = 'ready',
      chunk_count = CASE
        WHEN vector_manifest.hash = excluded.hash THEN vector_manifest.chunk_count
        ELSE excluded.chunk_count
      END,
      embedding_dimensions = CASE
        WHEN vector_manifest.hash = excluded.hash THEN vector_manifest.embedding_dimensions
        ELSE excluded.embedding_dimensions
      END,
      error_message = NULL,
      updated_at = excluded.updated_at
  `);

  const transaction = db.transaction((data: Array<{ path: string; hash: string }>) => {
    for (const item of data) {
      updateFile.run(item.hash, item.path);
      upsertManifest.run(item.path, item.hash, now);
    }
  });

  transaction(items);
}

/**
 * 清除文件的 vector_index_hash（用于标记需要重新索引）
 */
export function clearVectorIndexHash(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  const now = Date.now();
  const clearFile = db.prepare('UPDATE files SET vector_index_hash = NULL WHERE path = ?');
  const markPending = db.prepare(`
    UPDATE vector_manifest
    SET status = 'pending', error_message = NULL, updated_at = ?
    WHERE path = ?
  `);

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      clearFile.run(item);
      markPending.run(now, item);
    }
  });

  transaction(paths);
}

/**
 * 批量插入/更新文件记录
 */
export function batchUpsert(db: Database.Database, files: FileMeta[]): void {
  const insert = db.prepare(`
    INSERT INTO files (path, hash, mtime, size, content, language)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash,
      mtime = excluded.mtime,
      size = excluded.size,
      content = excluded.content,
      language = excluded.language
  `);

  const transaction = db.transaction((items: FileMeta[]) => {
    for (const item of items) {
      insert.run(item.path, item.hash, item.mtime, item.size, item.content, item.language);
    }
  });

  transaction(files);

  // files_fts 同步由 files_ai/au 触发器自动完成（外部内容表模式）
}

/**
 * 批量更新 mtime
 */
export function batchUpdateMtime(
  db: Database.Database,
  items: Array<{ path: string; mtime: number }>,
): void {
  const update = db.prepare('UPDATE files SET mtime = ? WHERE path = ?');

  const transaction = db.transaction((data: Array<{ path: string; mtime: number }>) => {
    for (const item of data) {
      update.run(item.mtime, item.path);
    }
  });

  transaction(items);
}

/**
 * 获取所有已索引的文件路径
 */
export function getAllPaths(db: Database.Database): string[] {
  const rows = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * 批量删除文件
 */
export function batchDelete(db: Database.Database, paths: string[]): void {
  if (paths.length === 0) return;
  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
  const deleteManifest = db.prepare('DELETE FROM vector_manifest WHERE path = ?');

  const transaction = db.transaction((items: string[]) => {
    for (const item of items) {
      deleteManifest.run(item);
      deleteFile.run(item);
    }
  });

  transaction(paths);

  // files_fts 同步由 files_ad 触发器自动完成
}

/**
 * 清空数据库
 */
export function clear(db: Database.Database): void {
  db.exec('DELETE FROM files');
  db.exec('DELETE FROM files_fts');
  db.exec('DELETE FROM chunks_fts');
}

// ===========================================
// Metadata 操作
// ===========================================

const METADATA_KEY_EMBEDDING_DIMENSIONS = 'embedding_dimensions';
const METADATA_KEY_INDEX_VERSION = 'index_version';
const METADATA_KEY_LANCEDB_MIGRATION_STATE = 'lancedb_migration_displaycode_state';
const METADATA_KEY_LANCEDB_MIGRATION_LOCK = 'lancedb_migration_lock';

/** LanceDB display_code 移除迁移状态 */
export type LanceDbMigrationState = 'pending' | 'done' | 'aborted';

/** 迁移锁过期时间（毫秒）：超过此时长视为僵尸锁可被夺取 */
const MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 获取 metadata 值
 */
function getMetadata(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * 设置 metadata 值
 */
function setMetadata(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * 获取存储的 embedding dimensions
 * @returns 存储的维度值，如果没有存储则返回 null
 */
export function getStoredEmbeddingDimensions(db: Database.Database): number | null {
  const value = getMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS);
  if (value === null) return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 设置 embedding dimensions
 */
export function setStoredEmbeddingDimensions(db: Database.Database, dimensions: number): void {
  setMetadata(db, METADATA_KEY_EMBEDDING_DIMENSIONS, String(dimensions));
}

// ===========================================
// 统计埋点（stats.* 前缀，复用 metadata 表，无需 schema 迁移）
// ===========================================

/**
 * 原子累加计数器（stats.* 前缀）
 *
 * 用 SQL 原子 `value = value + ?` upsert，避免 watch 模式下并发查询的读-改-写丢计数。
 * 首次插入时 value 即为 by。
 */
export function incrementStat(db: Database.Database, key: string, by = 1): void {
  const delta = Math.trunc(by);
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
  `).run(key, String(delta), delta);
}

/**
 * 存储 JSON 序列化的统计值（如最近一次索引快照）
 */
export function setStatJson(db: Database.Database, key: string, value: unknown): void {
  setMetadata(db, key, JSON.stringify(value));
}

/**
 * 读取 JSON 反序列化的统计值，解析失败或不存在返回 null
 */
export function getStatJson<T>(db: Database.Database, key: string): T | null {
  const raw = getMetadata(db, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 一次性读取所有 stats.* 计数器（原始字符串值）
 */
export function getAllStats(db: Database.Database): Record<string, string> {
  const rows = db
    .prepare(`SELECT key, value FROM metadata WHERE key LIKE 'stats.%'`)
    .all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/**
 * 索引库健康快照（只读聚合）
 */
export interface HealthSnapshot {
  totalFiles: number;
  totalBytes: number;
  byLanguage: Record<string, number>;
  pendingMarks: number;
  migrationState: LanceDbMigrationState | null;
  embeddingDimensions: number | null;
  indexVersion: number;
}

/**
 * 聚合索引库健康快照（只读，不触发迁移状态机）
 */
export function collectHealthSnapshot(db: Database.Database): HealthSnapshot {
  const agg = db
    .prepare('SELECT COUNT(*) as c, COALESCE(SUM(size), 0) as bytes FROM files')
    .get() as {
    c: number;
    bytes: number;
  };
  const langRows = db
    .prepare('SELECT language, COUNT(*) as c FROM files GROUP BY language')
    .all() as Array<{ language: string; c: number }>;
  const byLanguage: Record<string, number> = {};
  for (const row of langRows) byLanguage[row.language] = row.c;

  return {
    totalFiles: agg.c,
    totalBytes: agg.bytes,
    byLanguage,
    pendingMarks: countPendingMarks(db),
    migrationState: getLanceDbMigrationState(db),
    embeddingDimensions: getStoredEmbeddingDimensions(db),
    indexVersion: getIndexVersion(db),
  };
}

/**
 * 获取当前索引版本号
 *
 * 用于搜索缓存失效：scan() 发生实际写入时递增。
 */
export function getIndexVersion(db: Database.Database): number {
  const value = getMetadata(db, METADATA_KEY_INDEX_VERSION);
  if (value === null) return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 递增索引版本号并返回新值
 */
export function incrementIndexVersion(db: Database.Database): number {
  const next = getIndexVersion(db) + 1;
  setMetadata(db, METADATA_KEY_INDEX_VERSION, String(next));
  return next;
}

/**
 * 获取 LanceDB display_code 移除迁移的状态（CRIT-B）
 *
 * - null/undefined：未启动迁移（旧库或新库）
 * - 'pending'：迁移已开始（已清 vector_index_hash），LanceDB 处于不确定状态
 * - 'done'：迁移完成，LanceDB chunks 表使用新 schema
 * - 'aborted'：抽样校验失败，等待人工干预（CRIT-C）
 */
export function getLanceDbMigrationState(db: Database.Database): LanceDbMigrationState | null {
  const value = getMetadata(db, METADATA_KEY_LANCEDB_MIGRATION_STATE);
  if (value === 'pending' || value === 'done' || value === 'aborted') return value;
  return null;
}

/**
 * 设置 LanceDB 迁移状态（CRIT-B）
 */
export function setLanceDbMigrationState(
  db: Database.Database,
  state: LanceDbMigrationState,
): void {
  setMetadata(db, METADATA_KEY_LANCEDB_MIGRATION_STATE, state);
}

/**
 * 清空全部 vector_index_hash（CRIT-B 迁移前调用）
 *
 * 触发条件：LanceDB schema 即将变化，所有现有 chunks 无效，
 * 让自愈机制（getFilesNeedingVectorIndex）在下次 scan 时重建。
 */
export function clearAllVectorIndexHash(db: Database.Database): number {
  const tx = db.transaction(() => {
    const info = db.prepare('UPDATE files SET vector_index_hash = NULL').run();
    db.prepare(`
      UPDATE vector_manifest
      SET status = 'pending', error_message = NULL, updated_at = ?
    `).run(Date.now());
    return info.changes;
  });
  return tx() as number;
}

/**
 * 尝试获取 LanceDB 迁移锁（H2 修复）
 *
 * 跨进程互斥：SearchService 与 contextweaver index 可能并发触发迁移。
 * SQLite 单写者 + INSERT OR IGNORE 提供原子互斥。
 *
 * - 锁记录：JSON {pid, acquiredAt}
 * - 过期阈值：10 分钟（超时视为僵尸锁，可被新进程夺取）
 *
 * @returns true 表示获取成功（调用方必须在迁移结束后调用 releaseLanceDbMigrationLock）
 */
export function tryAcquireLanceDbMigrationLock(db: Database.Database): boolean {
  const now = Date.now();
  const pid = process.pid;
  const lockValue = JSON.stringify({ pid, acquiredAt: now });

  // 检查现有锁
  const existing = getMetadata(db, METADATA_KEY_LANCEDB_MIGRATION_LOCK);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { pid: number; acquiredAt: number };
      // 同 PID（重入）→ 视为持有
      if (parsed.pid === pid) return true;
      // 未过期 → 失败
      if (now - parsed.acquiredAt < MIGRATION_LOCK_STALE_MS) return false;
      // 过期 → 夺取
      logger.warn(
        { stalePid: parsed.pid, age: now - parsed.acquiredAt },
        '检测到僵尸迁移锁，强制夺取',
      );
    } catch {
      // 锁数据损坏 → 当作过期处理
    }
  }

  // 写入锁（UPSERT 保证幂等）
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(METADATA_KEY_LANCEDB_MIGRATION_LOCK, lockValue);

  // 二次校验：是否被并发进程抢先（race window 极小但理论存在）
  const reread = getMetadata(db, METADATA_KEY_LANCEDB_MIGRATION_LOCK);
  if (reread !== lockValue) return false;
  return true;
}

/**
 * 释放迁移锁
 */
export function releaseLanceDbMigrationLock(db: Database.Database): void {
  db.prepare('DELETE FROM metadata WHERE key = ?').run(METADATA_KEY_LANCEDB_MIGRATION_LOCK);
}
