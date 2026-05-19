# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

ContextWeaver 是一个为 AI 代码助手设计的语义检索引擎，采用混合搜索（向量 + 词法）、智能上下文扩展和 Token 感知打包策略。

## Development Commands

```bash
# Build
pnpm build                    # 编译 TypeScript (tsup)

# Development
pnpm dev                      # Watch 模式开发

# Run locally
pnpm start                    # 运行编译后的 CLI
node dist/index.js            # 直接运行

# CLI usage
contextweaver init            # 初始化配置文件 (~/.contextweaver/.env)
contextweaver index [path]    # 索引代码库
contextweaver search          # 本地搜索
contextweaver mcp             # 启动 MCP 服务端
contextweaver migrate         # 查看 LanceDB 迁移状态（v1.4.0+）
contextweaver migrate --reset # 清空 LanceDB 并重置迁移状态（解除 aborted）
```

## Architecture

### Core Pipeline

```
索引: Crawler → Processor → SemanticSplitter → Indexer → VectorStore/SQLite
搜索: Query → Vector+FTS Recall → RRF Fusion → Rerank → GraphExpander → ContextPacker
```

### Key Modules

| Module | Location | Responsibility |
|--------|----------|----------------|
| **SearchService** | `src/search/SearchService.ts` | 混合搜索核心，协调向量/词法召回、RRF 融合、Rerank 精排 |
| **GraphExpander** | `src/search/GraphExpander.ts` | 三阶段上下文扩展 (E1 邻居/E2 面包屑/E3 导入) |
| **ContextPacker** | `src/search/ContextPacker.ts` | 段落合并和 Token 预算控制 |
| **ChunkContentLoader** | `src/search/ChunkContentLoader.ts` | 按 `(path, start_index, end_index)` 从 `files.content` 批量切片（v1.4.0+，替代 LanceDB display_code 列） |
| **SemanticSplitter** | `src/chunking/SemanticSplitter.ts` | AST 语义分片器 (Tree-sitter)，写入 metadata 前用 `SourceAdapter.toCharOffset` 统一到 UTF-16 字符域 |
| **VectorStore** | `src/vectorStore/index.ts` | LanceDB 适配层；仅暴露纯 vector 操作（`hasDisplayCodeColumn`/`readAllRowsRaw`/`dropAndRecreateChunks`） |
| **Database** | `src/db/index.ts` | SQLite + FTS5 元数据和全文索引；schema_version=3 |
| **Bootstrap** | `src/db/bootstrap.ts` | 跨库初始化协调（v1.4.0+）：pending_marks 重放 + LanceDB schema 迁移 |
| **MCP Server** | `src/mcp/server.ts` | Model Context Protocol 服务端实现 |

### Data Architecture (v1.4.0+)

**SQLite (`~/.contextweaver/<projectId>/index.db`)**
- `files`: 文件元数据 + 完整正文（`content` 列，文本切片唯一来源）
- `files_fts`: 外部内容表，倒排索引指向 `files`（schema v2 引入）
- `chunks_fts`: chunk 级倒排索引，per-file 整体替换避免 hash 残留（schema v2）
- `metadata`: schema_version / embedding_dimensions / lancedb_migration_displaycode_state / lancedb_migration_lock
- `pending_marks`: outbox（v1.4.0），FTS 写入成功但 vector_index_hash 标记失败时启动重放

**LanceDB (`~/.contextweaver/<projectId>/vectors.lance`)**
- `chunks`: 仅向量 + 定位元数据（`start_index/end_index/raw_*/vec_*`）。**v1.4.0 起不再存 `display_code/vector_text`**——正文回查 `files.content`，索引体积降低 30-50%。

### Critical Invariants

- **正文唯一源**: `files.content`。`ChunkContentLoader` 使用 `start_index/end_index`（与 `displayCode` 同源）切片。`raw_start/raw_end` 含前置 gap，**不可**用于切片。
- **偏移域**: 所有 LanceDB 偏移字段都在 UTF-16 字符域，由 `SourceAdapter.toCharOffset` 在写入前归一。UTF-8 字节偏移会破坏多字节字符切片。
- **跨库一致性**: 写入顺序 LanceDB → (FTS + outbox) → SQLite mark + 清 outbox。任一阶段失败均有补偿；mark 阶段失败时下次启动 `replayPendingMarks` 重放。
- **LanceDB 迁移状态机**: `lancedb_migration_displaycode_state` ∈ `{pending, done, aborted}`，跨进程互斥用 `lancedb_migration_lock`（10 分钟僵尸阈值）。`aborted` 状态下 Indexer 拒绝写入；用户运行 `migrate --reset` 解除。
- **chunk_id 去重**: LanceDB 无 PK，`batchUpsertFiles` 在 `add` 前先按 `(path, newHash)` 预删除以防崩溃重试残留孤儿。

### Import Resolvers

跨文件依赖解析器位于 `src/search/resolvers/`，支持 JS/TS、Python、Go、Java、Rust、C#、C++。

### Configuration

- 环境变量配置: `~/.contextweaver/.env`
- 搜索参数配置: `src/search/config.ts`
- 日志文件: `~/.contextweaver/logs/app.YYYY-MM-DD.log`

## Code Conventions

- TypeScript ESM 模块 (`"type": "module"`)
- 使用 tsup 打包
- Node.js >= 20
- pnpm 作为包管理器
- 测试：vitest（单测 + 真实 LanceDB 集成测试），`pnpm test` 当前 109/109 通过
