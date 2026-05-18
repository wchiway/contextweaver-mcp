# Critical 数据架构修复计划

> **目标版本**：v1.2.0
> **范围**：仅修复 §1.1 / §1.2 / §1.3 三个 Critical 问题
> **兼容性策略**：自动检测旧 schema，启动时透明迁移
> **风险等级**：中（涉及持久化层 schema 变更，需完备回滚和测试）

---

## 用户决策点（已确认）

| 决策项 | 选定方案 |
|---|---|
| 旧数据兼容 | 自动检测 + 迁移（首次启动 v1.2.0 时执行） |
| FTS 失败策略 | 失败时整批回滚（同步撤销 LanceDB upsert + 不写 `vector_index_hash`） |
| 1.1 存储范围 | 仅 FTS5 外部内容表模式 |
| 1.3 孤儿清理 | 每次 `index` 后自动 GC 扫描 |

---

## 一、修复 1.2 — 跨库写入事务性

### 1.1 问题摘要

`indexer/index.ts:343-353` 阶段 5（FTS 写入）失败被 `logger.warn` 静默吞掉，但阶段 6 仍写入 `vector_index_hash`，导致：
- LanceDB 有向量记录
- `chunks_fts` 缺失对应行
- SQLite `vector_index_hash == hash` → 下次扫描**不会重试**
- 用户搜索时词法召回永久缺这部分文件

### 1.2 修复方案

把"LanceDB upsert → FTS upsert → SQLite mark"改造为**伪事务**（saga 模式）：
- 失败时执行**补偿动作**回滚已成功的步骤
- 仅当三步全部成功才标记 `vector_index_hash`

### 1.3 实施步骤

#### Step 1.2.1 — 增加 LanceDB 反向删除能力

文件：`src/vectorStore/index.ts`

新增方法 `deleteFilesByHash(items: Array<{path, hash}>)`：删除指定 `(path, hash)` 组合的记录。用于阶段 5 失败时回滚阶段 4 刚插入的新版本。

```ts
async deleteFilesByHash(items: Array<{ path: string; hash: string }>): Promise<void>
```

实现要点：
- WHERE 条件用 `OR` 拼接 `(file_path='X' AND file_hash='Y')`
- 复用 `escapeString`
- 分批 500 项防 filter 字符串过长

#### Step 1.2.2 — 改造 Indexer 阶段顺序与错误处理

文件：`src/indexer/index.ts`，方法 `batchIndex`（行 175-377）

将阶段 4/5/6 包装为 try/catch 块：

```text
try {
  Stage 4: LanceDB.batchUpsertFiles(filesToUpsert)
  try {
    Stage 5: chunks_fts upsert (移除现有的 try/catch)
  } catch (ftsErr) {
    // 补偿: 回滚 LanceDB
    await vectorStore.deleteFilesByHash(filesToUpsert.map(f => ({path, hash})))
    throw ftsErr  // 不进入 Stage 6
  }
  Stage 6: batchUpdateVectorIndexHash(successFiles)
} catch (err) {
  // 任何阶段失败: 这批文件 vector_index_hash 保持旧值, 下次自愈
  logger.error({err, batch}, '批次写入失败,已回滚')
  totalErrors += batchFiles.length
  continue  // 处理下一批
}
```

#### Step 1.2.3 — 加固 chunks_fts upsert 原子性

文件：`src/search/fts.ts:164-187`

`batchUpsertChunkFts` 当前已经是单个事务（`db.transaction`），但需要：
- 确保 `delete + insert` 同事务（已是）
- 错误向上抛出，不要 catch 后吞掉

无需改动函数本身，仅在调用方 `indexer/index.ts:344` **移除外层 try/catch**。

#### Step 1.2.4 — 删除场景同样需要补偿

文件：`src/indexer/index.ts:382-394` (`deleteFiles`)

当前顺序：
```
vectorStore.deleteFiles(paths)
chunks_fts deleteFileChunksFts(paths)
```

风险类似：第一步成功、第二步失败 → FTS 有孤儿。

修复方案：
- 把 SQLite FTS 删除放**第一步**（SQLite 事务可靠，失败概率低）
- LanceDB 删除放第二步
- 单批级别如失败，记录 `errorPaths` 进入下次扫描重试（依赖 `vector_index_hash` 重置）

具体改动：在删除失败时，对失败路径调用 `clearVectorIndexHash`，强制下次 scan 重新走 `getFilesNeedingVectorIndex`。

#### Step 1.2.5 — 测试用例

文件：`tests/indexer/transaction.test.ts`（新建）

- `[T1] LanceDB upsert 成功 + FTS 抛错 → LanceDB 应被回滚到旧 hash 状态`
- `[T2] LanceDB upsert 成功 + FTS 成功 + SQLite mark 抛错 → vector_index_hash 仍为旧值`
- `[T3] 多批次中第二批失败 → 第一批已收敛, 第二批 vector_index_hash 未变`
- `[T4] delete 路径 FTS 失败 → vector_index_hash 被 clear,下次 scan 重试`

需要 Mock 注入：用 vitest `vi.spyOn` 让 `batchUpsertChunkFts` 抛错。

### 1.4 验收标准

- [ ] FTS 写入失败时，LanceDB 不残留新 hash 的 chunks
- [ ] FTS 写入失败时，`vector_index_hash` 保持旧值
- [ ] 下次 scan 触发 `getFilesNeedingVectorIndex` 重试，最终收敛
- [ ] 所有新增测试通过
- [ ] 现有 47 个测试无回归

### 1.5 工作量估算

- 编码：1.5 天
- 测试：1 天
- Code Review + 联调：0.5 天
- **总计：3 人天**

---

## 二、修复 1.1 — FTS5 外部内容表（消除全文重复存储）

### 2.1 问题摘要

当前 `files_fts` 是独立 contentful FTS5 表，与 `files.content` 各存一份原文。50MB 代码库 = SQLite 100MB+。

### 2.2 修复方案

将 `files_fts` 改为 `content='files'` 外部内容表模式：
- FTS5 仅存倒排索引，不存正文
- 查询时透明回 `files` 表取 content
- 节省 ~33% 磁盘
- 不影响 LanceDB `display_code`（本轮不动）

### 2.3 实施步骤

#### Step 2.1 — Schema 设计

新 schema：

```sql
CREATE VIRTUAL TABLE files_fts USING fts5(
    path,
    content,
    content='files',
    content_rowid='rowid',
    tokenize='trigram'
);

-- 同步触发器 (FTS5 标准做法)
CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
END;

CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, path, content) VALUES('delete', old.rowid, old.path, old.content);
END;

CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, path, content) VALUES('delete', old.rowid, old.path, old.content);
    INSERT INTO files_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
END;
```

**关键约束**：
- `files` 表必须有可用 rowid → 当前 `path TEXT PRIMARY KEY` 不是 INTEGER PRIMARY KEY，但 SQLite 仍会自动生成 rowid，✅ 可用
- `content` 列在 `files` 中可为 NULL（skipped 文件） → trigger 中需过滤 NULL，否则插入失败

#### Step 2.2 — 触发器空值防护

修正版触发器：

```sql
CREATE TRIGGER files_ai AFTER INSERT ON files
WHEN new.content IS NOT NULL
BEGIN
    INSERT INTO files_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
END;

CREATE TRIGGER files_ad AFTER DELETE ON files
WHEN old.content IS NOT NULL
BEGIN
    INSERT INTO files_fts(files_fts, rowid, path, content) VALUES('delete', old.rowid, old.path, old.content);
END;

CREATE TRIGGER files_au AFTER UPDATE ON files
WHEN old.content IS NOT NULL OR new.content IS NOT NULL
BEGIN
    -- 老内容存在才删除
    INSERT INTO files_fts(files_fts, rowid, path, content)
    SELECT 'delete', old.rowid, old.path, old.content WHERE old.content IS NOT NULL;
    -- 新内容存在才插入
    INSERT INTO files_fts(rowid, path, content)
    SELECT new.rowid, new.path, new.content WHERE new.content IS NOT NULL;
END;
```

#### Step 2.3 — 改造 fts.ts

文件：`src/search/fts.ts`

**移除的代码**：
- `batchUpsertFileFts` (行 312-327) — 触发器自动处理
- `batchDeleteFileFts` (行 332-340) — 触发器自动处理
- `syncFilesFts` (行 88-106) — 外部内容表无需手动同步

**修改的代码**：
- `initFilesFts` (行 56-81) — 改为创建外部内容表 + 触发器
- `searchFilesFts` SQL 不变（FTS5 自动 join 回源表）

**调用方移除**：
- `db/index.ts:247` — 移除 `batchUpsertFileFts` 调用
- `db/index.ts:294` — 移除 `batchDeleteFileFts` 调用
- 保留 `db/index.ts:302` 的 `DELETE FROM files_fts` 用于 `clear()`（外部内容表也支持）

#### Step 2.4 — Schema 版本与迁移

文件：`src/db/index.ts`

新增 `metadata` 表已有，新增键 `schema_version`：

```ts
const CURRENT_SCHEMA_VERSION = 2;  // v1.1.0 隐式为 1

function migrateSchema(db: Database.Database): void {
  const current = getSchemaVersion(db) ?? 1;
  if (current >= CURRENT_SCHEMA_VERSION) return;

  logger.info({ from: current, to: CURRENT_SCHEMA_VERSION }, '执行 schema 迁移');

  if (current < 2) migrateToV2(db);

  setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
}

function migrateToV2(db: Database.Database): void {
  // 1. 备份旧表名 (用于失败回滚)
  db.exec('ALTER TABLE files_fts RENAME TO files_fts_v1_backup');

  // 2. 创建新外部内容表
  initFilesFts(db);  // 走新逻辑

  // 3. 重建索引: 外部内容表的 'rebuild' 命令
  db.exec("INSERT INTO files_fts(files_fts) VALUES('rebuild')");

  // 4. 删除备份
  db.exec('DROP TABLE files_fts_v1_backup');
}
```

**回滚策略**：迁移失败时备份表仍在，下次启动可手动恢复；同时 logger 输出明确错误。

#### Step 2.5 — 调用顺序调整

`initDb` 当前先创建 `files`，再 `initFilesFts`，再 `initChunksFts`。
新增：

```ts
export function initDb(projectId: string): Database.Database {
  // ...创建 files / metadata 表（不变）...

  // 新增: schema 迁移 (必须在 FTS 初始化前)
  migrateSchema(db);

  initFilesFts(db);   // v2 走外部内容表分支
  initChunksFts(db);  // 不变,本轮不动

  // ...pragma 不变...
}
```

#### Step 2.6 — 测试用例

文件：`tests/db/migration.test.ts`（新建）

- `[M1] v1 schema 启动 v1.2.0 → 自动迁移到 v2, 数据无丢失`
- `[M2] 迁移后 batchUpsert files → 触发器自动同步 files_fts`
- `[M3] batchDelete files → 触发器自动从 files_fts 删除`
- `[M4] 迁移失败模拟 → 备份表存在, 原表未损坏`
- `[M5] content 为 NULL 的文件 → 触发器跳过, 不报错`
- `[M6] searchFilesFts 在新 schema 下结果与旧 schema 一致 (用 fixture 验证)`

### 2.4 验收标准

- [ ] 新建项目使用 v2 schema
- [ ] v1.1.0 创建的项目首次启动 v1.2.0 自动迁移
- [ ] 迁移后磁盘占用减少 25% 以上（用 fixtures 验证）
- [ ] FTS 搜索结果与迁移前一致（BM25 分数允许 ±5% 误差）
- [ ] `batchUpsert` / `batchDelete` 调用方无需感知变化
- [ ] 现有 FTS 相关测试无回归

### 2.5 工作量估算

- Schema 设计 + 触发器：0.5 天
- 迁移逻辑：1 天
- 测试（迁移 + 触发器 + 回归）：1.5 天
- **总计：3 人天**

---

## 三、修复 1.3 — 自动 GC 扫描

### 3.1 问题摘要

LanceDB 中可能残留：
- 旧 hash 的 chunks（崩溃中断 `delete WHERE file_hash != newHash`）
- 已删除文件未被 deleteFile 触达的 chunks
- 文件改名场景的旧路径 chunks

无 GC 机制 → 向量库只增不减，长期使用后膨胀。

### 3.2 修复方案

`scan()` 完成后自动执行轻量 GC：
- 以 SQLite `files` 表为权威源
- 检查 LanceDB chunks 中所有 `(file_path, file_hash)` 是否在 SQLite 中存在
- 不存在 = 孤儿 → 删除

### 3.3 实施步骤

#### Step 3.1 — 新增 VectorStore 接口

文件：`src/vectorStore/index.ts`

```ts
/**
 * 获取所有 chunks 的 (path, hash) 唯一组合
 * 用于 GC 对比
 */
async listFileHashes(): Promise<Array<{ path: string; hash: string }>> {
  if (!this.table) return [];
  const rows = await this.table.query()
    .select(['file_path', 'file_hash'])
    .toArray();

  // 去重 (一个文件多 chunk 共享同一 path+hash)
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
```

**性能考虑**：LanceDB `select` 仅取需要列，10 万 chunks 大约几十 ms。

#### Step 3.2 — GC 主逻辑

文件：`src/indexer/index.ts`（新增方法）

```ts
async gc(db: Database.Database): Promise<{ orphans: number }> {
  if (!this.vectorStore) await this.init();

  // 1. 拉取 LanceDB 中所有 (path, hash)
  const vectorPairs = await this.vectorStore!.listFileHashes();
  if (vectorPairs.length === 0) return { orphans: 0 };

  // 2. 构建 SQLite 中权威的 (path, hash) 集合
  const sqliteRows = db.prepare('SELECT path, hash FROM files').all() as Array<{ path: string; hash: string }>;
  const valid = new Set(sqliteRows.map(r => `${r.path} ${r.hash}`));

  // 3. 找出孤儿
  const orphans = vectorPairs.filter(p => !valid.has(`${p.path} ${p.hash}`));

  if (orphans.length === 0) return { orphans: 0 };

  logger.info({ count: orphans.length }, 'GC 发现孤儿 chunks');

  // 4. 删除孤儿 (用新增的 deleteFilesByHash, 复用 1.2.1 的方法)
  await this.vectorStore!.deleteFilesByHash(orphans);

  // 5. 同步清理 chunks_fts (按 file_path, 因为 FTS 不存 hash 维度)
  //    注意: 仅当该 path 在 SQLite 完全不存在时才删 FTS
  //    若 path 仍在 SQLite (只是 hash 变了), FTS 已被新一轮 upsert 覆盖, 无需动
  const orphanPaths = new Set(orphans.map(o => o.path));
  const sqlitePaths = new Set(sqliteRows.map(r => r.path));
  const pathsToFtsClean = Array.from(orphanPaths).filter(p => !sqlitePaths.has(p));
  if (pathsToFtsClean.length > 0 && isChunksFtsInitialized(db)) {
    batchDeleteFileChunksFts(db, pathsToFtsClean);
  }

  return { orphans: orphans.length };
}
```

#### Step 3.3 — 集成到 scan 流程

文件：`src/scanner/index.ts`

在 `scan()` 函数末尾（行 280-285，`invalidateAllExpanderCaches()` 之前）：

```ts
// GC: 清理孤儿 chunks
if (options.vectorIndex !== false) {
  try {
    const embeddingConfig = getEmbeddingConfig();
    const indexer = await getIndexer(projectId, embeddingConfig.dimensions);
    const gcResult = await indexer.gc(db);
    if (gcResult.orphans > 0) {
      logger.info({ orphans: gcResult.orphans }, 'GC 完成');
    }
  } catch (err) {
    // GC 失败不影响主流程
    logger.warn({ err }, 'GC 跳过');
  }
}
```

**关键设计**：
- 失败不传播（GC 是优化，不是正确性必需）
- 仅在向量索引启用时执行
- 复用现有 indexer 实例

#### Step 3.4 — 性能护栏

GC 在大型项目可能慢（50K chunks），加性能护栏：

```ts
async gc(db: Database.Database, options: { maxScanMs?: number } = {}): Promise<{ orphans: number; truncated?: boolean }> {
  const startTime = Date.now();
  const timeBudget = options.maxScanMs ?? 5000;

  // ... 拉取 vectorPairs ...

  if (Date.now() - startTime > timeBudget) {
    logger.warn({ elapsed: Date.now() - startTime }, 'GC 超时,本次跳过');
    return { orphans: 0, truncated: true };
  }
  // ...
}
```

默认 5 秒预算。后续可加 `cw doctor --gc --no-timeout` 暴力清理命令。

#### Step 3.5 — 测试用例

文件：`tests/indexer/gc.test.ts`（新建）

- `[G1] LanceDB 含 hash X1 的 chunks,SQLite files.hash=X2 → GC 删除 X1`
- `[G2] LanceDB 含 path A 的 chunks,SQLite 无 A → GC 删除 A 全部 chunks + FTS`
- `[G3] LanceDB 含 path A hash H,SQLite 也有 path A hash H → 不动`
- `[G4] GC 时间超出预算 → truncated=true, orphans=0,不影响主流程`
- `[G5] 集成测试: scan 后无孤儿`

### 3.4 验收标准

- [ ] scan 完成后自动执行 GC，日志可见 `orphans` 数量
- [ ] 模拟崩溃后再 scan，孤儿被清理
- [ ] GC 默认 5s 时间预算，超时不阻塞 scan 主流程
- [ ] 新增测试通过

### 3.5 工作量估算

- 编码：1 天
- 测试：0.5 天
- **总计：1.5 人天**

---

## 四、整体交付计划

### 4.1 时间线

| 阶段 | 工作量 | 累计 |
|---|---|---|
| 修复 1.2（事务回滚） | 3 天 | 3 天 |
| 修复 1.1（FTS 外部内容表） | 3 天 | 6 天 |
| 修复 1.3（自动 GC） | 1.5 天 | 7.5 天 |
| 集成测试 + 回归 | 1.5 天 | 9 天 |
| 文档 + Release Notes | 0.5 天 | 9.5 天 |

**总工期：约 2 周（单人全职）**

### 4.2 实施顺序

**推荐顺序：1.2 → 1.3 → 1.1**

理由：
- 1.2 是纯正确性问题，无 schema 变动，先做最稳
- 1.3 复用 1.2 新增的 `deleteFilesByHash`，自然衔接
- 1.1 涉及 schema 迁移，放最后单独发布以便单独验证

### 4.3 Git 分支策略

```
main
└── release/1.2.0
    ├── fix/transaction-rollback     (1.2)
    ├── feat/auto-gc                  (1.3)
    └── feat/fts5-external-content    (1.1)
```

每个分支独立 PR，独立 review，合并到 `release/1.2.0` 集成测试。

### 4.4 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| FTS5 触发器在某些 SQLite 版本不支持 | 低 | 启动时探测 `sqlite_version()`，<3.9 直接拒绝（FTS5 本身需 3.9+） |
| 大型项目迁移耗时长（>30s）阻塞首次启动 | 中 | 迁移期间显示进度日志；提供 `CW_SKIP_MIGRATION=1` 应急开关 |
| LanceDB 0.22 `select(['file_path', 'file_hash'])` 不支持仅列查询 | 中 | 已查 LanceDB 0.22 API 支持 `select`；若不支持降级为 `toArray()` 后内存过滤 |
| 用户中断迁移导致备份表残留 | 低 | 启动时检查 `files_fts_v1_backup` 表，若存在且 `files_fts` 已就绪，自动 DROP |
| GC 删除误判（hash 写入瞬间） | 低 | GC 仅在 scan 末尾运行，此时所有 vector_index_hash 已收敛；且 GC 失败不影响功能 |

### 4.5 发布前 Checklist

- [ ] 全部新增测试通过
- [ ] 现有测试无回归（`pnpm test`）
- [ ] 手动测试：v1.1.0 创建的项目升级到 v1.2.0 后搜索正常
- [ ] 手动测试：5 万文件级 monorepo（如 vscode 仓库）索引 + 搜索性能不退化
- [ ] 手动测试：模拟 FTS 失败（Mock 抛错），验证 LanceDB 回滚
- [ ] 手动测试：删除 LanceDB 表外部文件后 scan，GC 不误删
- [ ] README 增加 `Migration Notes` 章节
- [ ] CHANGELOG 列出三项 Critical 修复
- [ ] `package.json` version → 1.2.0
- [ ] tag + release

---

## 五、后续工作（不在本计划范围）

P1 及以下问题保留到 v1.3.0 / v2.0.0 处理：

- **P1**：LanceDB filter SQL 注入面 → 改用 Expr API
- **P1**：无 ANN 索引 → chunks>5K 自动 `create_index(IVF_PQ)`
- **P1**：维度迁移销毁式 → 双向量列共存
- **P2**：projectId 加入 `remote.origin.url` 主锚
- **P2**：files.content 拆出 SQLite → CAS 存储
- **P3**：`cw doctor` 完整诊断命令
