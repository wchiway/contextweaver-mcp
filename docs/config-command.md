# Config 命令使用指南

`contextweaver config` 命令用于管理 ContextWeaver 的环境变量配置。

## 快速开始

```bash
# 查看当前配置
contextweaver config list

# 设置单个环境变量
contextweaver config set EMBEDDINGS_MAX_CONCURRENCY 20

# 验证配置有效性
contextweaver config validate

# 使用交互式向导配置
contextweaver config wizard
```

## 子命令

### list / ls

查看当前配置，敏感信息（如 API Key）会被自动掩码。

```bash
contextweaver config list
# 或
contextweaver config ls
```

输出示例：
```
配置文件: /home/user/.contextweaver/.env

必需配置:
  EMBEDDINGS_API_KEY             = sk-e***************************d195
  EMBEDDINGS_BASE_URL            = https://api.siliconflow.cn/v1/embeddings
  EMBEDDINGS_MODEL               = BAAI/bge-m3
  RERANK_API_KEY                 = sk-r***************************a456
  RERANK_BASE_URL                = https://api.siliconflow.cn/v1/rerank
  RERANK_MODEL                   = BAAI/bge-reranker-v2-m3

可选配置:
  EMBEDDINGS_MAX_CONCURRENCY     = 10
  EMBEDDINGS_DIMENSIONS          = 1024
  RERANK_TOP_N                   = 20
```

### set

设置单个环境变量。

```bash
contextweaver config set <key> <value>
```

示例：
```bash
# 设置 Embedding 并发数
contextweaver config set EMBEDDINGS_MAX_CONCURRENCY 20

# 设置向量维度
contextweaver config set EMBEDDINGS_DIMENSIONS 2048

# 设置搜索参数
contextweaver config set CW_SEARCH_WVEC 0.7
```

可用的配置键：

**Embedding 配置：**
- `EMBEDDINGS_API_KEY` - Embedding API Key（必需）
- `EMBEDDINGS_BASE_URL` - Embedding API Base URL（必需）
- `EMBEDDINGS_MODEL` - Embedding 模型名称（必需）
- `EMBEDDINGS_MAX_CONCURRENCY` - 并发请求数（可选，默认 10）
- `EMBEDDINGS_DIMENSIONS` - 向量维度（可选，默认 1024）

**Reranker 配置：**
- `RERANK_API_KEY` - Reranker API Key（必需）
- `RERANK_BASE_URL` - Reranker API Base URL（必需）
- `RERANK_MODEL` - Reranker 模型名称（必需）
- `RERANK_TOP_N` - Rerank Top N（可选，默认 20）

**搜索参数配置：**
- `CW_SEARCH_WVEC` - 向量搜索权重
- `CW_SEARCH_WLEX` - 词法搜索权重
- `CW_SEARCH_RERANK_TOP_N` - Rerank Top N
- `CW_SEARCH_MAX_TOTAL_CHARS` - 最大输出字符数
- `CW_SEARCH_VECTOR_TOP_K` - 向量召回 Top K
- `CW_SEARCH_SMART_MAX_K` - 智能最大 K
- `CW_SEARCH_IMPORT_FILES_PER_SEED` - 每个种子导入文件数

**其他配置：**
- `IGNORE_PATTERNS` - 忽略模式（逗号分隔）

### validate

验证当前配置是否有效，检查必需的环境变量是否已正确设置。

```bash
contextweaver config validate
```

输出示例（成功）：
```
开始验证配置...

✓ Embedding 配置有效
✓ Reranker 配置有效

配置验证通过！
```

输出示例（失败）：
```
开始验证配置...

✗ Embedding 配置无效
  缺失: EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL
✓ Reranker 配置有效
```

### wizard

启动交互式配置向导，逐步引导用户配置所有必需的环境变量。

```bash
contextweaver config wizard
```

向导会依次询问：
1. Embedding 配置（API Key、Base URL、Model、Dimensions）
2. Reranker 配置（API Key、Base URL、Model）

对于已经设置过的配置项，会显示 `[已设置]` 提示，直接按回车跳过即可保留原值。

## 配置文件位置

配置文件默认位于：
```
~/.contextweaver/.env
```

你也可以直接编辑这个文件来修改配置，但使用 `config` 命令更安全，因为它会：
- 验证配置键的有效性
- 保持文件格式一致
- 自动分组相关配置

## 最佳实践

1. **初次配置**：使用 `wizard` 命令进行交互式配置
   ```bash
   contextweaver config wizard
   ```

2. **调整单个参数**：使用 `set` 命令
   ```bash
   contextweaver config set EMBEDDINGS_MAX_CONCURRENCY 20
   ```

3. **验证配置**：在首次配置后或修改配置后运行 `validate`
   ```bash
   contextweaver config validate
   ```

4. **查看当前配置**：使用 `list` 命令
   ```bash
   contextweaver config list
   ```

## 故障排查

### 问题：config set 命令提示 "无效的配置键"

**原因**：配置键名称拼写错误。

**解决方案**：运行不带参数的 `config set` 查看所有可用的配置键：
```bash
contextweaver config set
```

### 问题：config validate 提示配置无效

**原因**：必需的环境变量未设置或设置为默认占位符。

**解决方案**：
1. 运行 `config list` 查看哪些配置缺失
2. 使用 `config set` 设置缺失的配置
3. 或者运行 `config wizard` 重新配置

### 问题：API Key 无法显示

**原因**：这是预期行为。`config list` 会自动掩码敏感信息（API Key）。

**解决方案**：如需查看完整值，直接查看配置文件：
```bash
cat ~/.contextweaver/.env
```

## 相关命令

- `contextweaver init` - 初始化配置文件（首次使用）
- `contextweaver index` - 扫描代码库并建立索引
- `contextweaver search` - 本地检索
