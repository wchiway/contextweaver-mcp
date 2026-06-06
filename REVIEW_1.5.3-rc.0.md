# ContextWeaver v1.5.3-rc.0 全面 Review 报告

**Review 日期**: 2026-06-05  
**目标版本**: v1.5.3-rc.0  
**基准版本**: v1.5.2  
**Review 范围**: 代码质量、架构设计、测试覆盖、CI/CD 集成

---

## 📊 变更概览

### 统计数据
- **32 个文件变更**
- **2,881 行新增**，226 行删除
- **净增代码**: ~2,655 行
- **测试通过率**: 785/788 (99.6%)
- **测试失败**: 3 个 (getSymbolDefinition.test.ts)

### 核心功能
1. **语义边与调用图** (v1.5.3-beta.1)
   - Tree-sitter 调用提取器 (11 种语言)
   - 本地调用图构建
   - semantic_edges 表 (385 条边)

2. **符号列表工具** (v1.5.3-beta.1)
   - list-symbols MCP 工具
   - tree-sitter tags 符号提取
   - semantic_symbols 表

3. **MCP Registry 集成** (v1.5.3-rc.0)
   - server.json 配置
   - GitHub Actions 自动发布
   - 文档清理

---

## ✅ 优点总结

### 1. 架构设计
- **职责清晰**: 调用提取、符号匹配、图构建分离
- **配置驱动**: `CALL_CONFIGS` 支持 11 种语言扩展
- **渐进式迁移**: Schema v3 → v4 → v5，版本隔离良好
- **复合主键**: semantic_symbols 避免重复符号

### 2. 错误处理
- 不支持语言返回空数组（非抛错）
- NULL 检查完整
- 长表达式过滤 (>100/200 字符)
- tags.scm 加载失败不崩溃

### 3. 性能优化
- **SQL 层过滤**: 路径/kind/language 在数据库完成
- **查询缓存**: tags.scm Query 对象缓存
- **参数化查询**: 防止 SQL 注入

### 4. CI/CD 自动化
- release.yml 和 prerelease.yml 都集成 MCP 发布
- AI changelog 生成
- 版本一致性检查

---

## ⚠️ 发现的问题

### 🔴 严重问题 (Must Fix)

#### 1. **测试失败** - getSymbolDefinition.test.ts (3/3 测试)
**现象**:
```
SqliteError: no such table: semantic_symbols
```

**原因**: 测试 mock 配置问题，`initDb()` 返回的数据库实例没有 semantic_symbols 表

**影响**: 
- 核心功能 get-symbol-definition 未经测试验证
- CI/CD 可能失败（如果运行测试）
- 无法保证功能正确性

**修复优先级**: P0 - 阻塞发布

**建议修复**:
```typescript
// Option 1: 确保 mock 的 initDb 返回正确的 state.db
vi.mock('../../src/db/index.js', () => ({
  generateProjectId: vi.fn(() => 'test-project'),
  initDb: vi.fn(() => state.db),
}));

// Option 2: 在 setupDb 中手动创建 semantic_symbols 表（当前实现）
// 需要验证为什么仍然失败
```

**验证步骤**:
1. 在测试中添加 console.log 验证 mock 是否生效
2. 检查动态 import 是否绕过了 vitest mock
3. 考虑使用 `vi.mock` 的 `factory` 模式而非 `importOriginal`

---

#### 2. **treeSitterTags.ts 逻辑漏洞** - 引用节点被错误提取
**位置**: `src/semantic/treeSitterTags.ts:140-142`

**问题**:
```typescript
function isDefinition(captureName: string): boolean {
  return captureName.startsWith('definition.');
}
// 这个函数定义了但从未被调用！
```

所有 `@reference.*` 捕获也会被插入 semantic_symbols 表。

**影响**:
- `list-symbols` 返回错误结果（包含调用站点、引用点）
- `get-symbol-definition` 可能匹配到引用而非定义
- 数据污染，混淆定义与引用

**修复**:
```typescript
// 在 extractTreeSitterSymbols 中添加过滤
if (!definitionCapture || !nameCapture) {
  continue;
}

// 添加：只保留定义点
if (!isDefinition(definitionCapture.name)) {
  continue;
}
```

**测试验证**:
```python
# Python 文件
def foo(): pass  # 定义
foo()  # 调用（引用）

# 应该只提取定义，不提取调用
```

---

#### 3. **semantic_symbols 主键冲突风险**
**位置**: `src/db/index.ts:395`

**问题**:
```sql
PRIMARY KEY (path, hash, source, kind, name, start_line)
```

**冲突场景**:
```python
# 同一行多个同名符号
def foo(): pass; def foo(): pass

# 或
class A { foo() {} }  # method
interface A { foo(): void; }  # 同名不同 kind，但 start_line 相同
```

**影响**: 
- `INSERT OR REPLACE` 会覆盖前一个符号
- 符号丢失，查询结果不完整

**建议**:
```sql
-- Option 1: 添加 start_column
PRIMARY KEY (path, hash, source, kind, name, start_line, start_column)

-- Option 2: 使用自增 ID + 唯一索引
id INTEGER PRIMARY KEY AUTOINCREMENT,
UNIQUE INDEX idx_semantic_symbols_unique ON semantic_symbols(
  path, hash, source, kind, name, start_line
)
```

---

#### 4. **MCP Registry 认证方式可能不支持**
**位置**: `.github/workflows/release.yml:227`, `prerelease.yml:237`

**问题**:
```bash
echo "$GITHUB_TOKEN" | mcp-publisher login github --token-stdin
```

根据 MCP Registry 文档，GitHub 认证使用**设备流程**（device flow），`--token-stdin` 参数可能不存在。

**影响**:
- Workflow 中的 MCP 发布步骤会失败
- 需要手动发布到 MCP Registry
- 自动化流程不完整

**验证**:
```bash
mcp-publisher login github --help
```

**修复方案**:
1. 使用 Personal Access Token (需要配置 secret)
2. 使用 DNS 认证（预先配置）
3. 使用 GitHub App 认证
4. 如果不支持自动化，在文档中说明需要手动发布

---

### 🟡 中等问题 (Should Fix)

#### 5. **callGraphBuilder 代码重复**
**位置**: `src/semantic/callGraphBuilder.ts:120-182`

**问题**: 注释说"使用现有的 replaceSemanticEdges"，但实际重新实现了 INSERT 逻辑。

**建议**: 复用 `replaceSemanticEdges` 或提取公共函数。

---

#### 6. **list-symbols Glob 转换不完整**
**位置**: `src/mcp/tools/listSymbols.ts:92-98`

**问题**:
```typescript
.replace(/\*\*/g, '%')  // ** → %
.replace(/\*/g, '%')    // * → %
```

不支持：
- `?` 单字符通配符
- `[abc]` 字符集
- `\*` 转义

**建议**: 文档中明确说明只支持 `*` 和 `**`。

---

#### 7. **路径过滤前缀匹配陷阱**
**位置**: `src/mcp/tools/listSymbols.ts:101-103`

**问题**: `src/search` 会匹配 `src/search-v2/...`

**建议**:
```typescript
conditions.push('(path LIKE ? OR path = ?)');
params.push(`${filter}/%`, filter);
```

---

#### 8. **server.json 版本不一致**
**位置**: `server.json`

**问题**:
```json
"version": "1.5.3",           // 顶层
"packages": [{ "version": "1.5.3-rc.0" }]  // package
```

**建议**: 顶层 version 应与 package version 一致：
```json
"version": "1.5.3-rc.0"
```

---

#### 9. **semantic_edges 缺少唯一性约束**
**位置**: `src/db/index.ts:401-417`

**问题**: 自增 ID 允许重复边

**建议**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_edges_unique 
ON semantic_edges(source_path, source_hash, target_path, symbol_name, source_line);
```

---

#### 10. **缺少级联删除策略**
**影响**: 文件删除时，semantic_symbols/edges 的旧数据会残留

**建议**: 添加定期 GC 任务或 Foreign Key 约束。

---

### 🟢 轻微问题 (Nice to Have)

#### 11. **treeSitterCalls 性能问题**
**位置**: `src/semantic/treeSitterCalls.ts:152`

```typescript
const sourceCode = tree.rootNode.text;  // 每次读取完整源码
```

**建议**: 传入 `sourceCode` 参数而非从 tree 读取。

---

#### 12. **限定符提取逻辑简单**
**位置**: `src/semantic/treeSitterCalls.ts:119`

只提取第一层限定符，遗漏嵌套访问 (`a.b.c()`)。

**建议**: 文档说明只提取第一层。

---

#### 13. **containerName 始终为 null**
**位置**: `src/semantic/treeSitterTags.ts:208`

tags.scm 不提供容器信息。

**建议**: 文档说明 tree-sitter 源的符号不包含容器信息。

---

#### 14. **补丁覆盖不完整**
**位置**: `src/semantic/treeSitterTags.ts:42-71`

- `const`/`let`/`var` 未区分
- 未处理箭头函数赋值
- 未处理方法定义

**建议**: 扩展补丁或在文档中说明限制。

---

#### 15. **同步文件读取**
**位置**: `src/semantic/treeSitterTags.ts:98`

```typescript
let tagsSource = readFileSync(tagsPath, 'utf8');
```

阻塞事件循环。

**建议**: 使用 `fs.promises.readFile`。

---

#### 16. **Query 对象内存累积**
**位置**: `src/semantic/treeSitterTags.ts:74`

`queryCache` 长期持有 Query 对象，多项目索引可能内存累积。

**建议**: LRU 缓存或项目级缓存清理。

---

#### 17. **Workflow 缺少错误处理**
**位置**: `.github/workflows/release.yml`, `prerelease.yml`

mcp-publisher 失败不会阻止 workflow 成功。

**建议**: 添加验证步骤
```bash
- name: Verify MCP Registry publication
  run: |
    sleep 5
    curl -f "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.wchiway/contextweaver"
```

---

#### 18. **package.json mcpName 检查缺失**
**建议**: 添加预检步骤
```bash
- name: Verify mcpName exists
  run: |
    if ! grep -q '"mcpName"' package.json; then
      echo "Error: mcpName not found in package.json"
      exit 1
    fi
```

---

## 📈 测试覆盖分析

### 通过的测试 (785/788)
- ✅ `semantic-graph.test.ts` (226 行) - 符号/边的 CRUD
- ✅ `updateCommand.test.ts` (268 行) - CLI 命令
- ✅ 修改的测试: migration, pending-marks, GraphExpander

### 失败的测试 (3/788)
- ❌ `getSymbolDefinition.test.ts` - 全部 3 个测试失败
  - prefers breadcrumb exact matches over plain FTS fallback hits
  - uses hint_path to rank same-name breadcrumb matches by common prefix length
  - falls back to top-level const definitions and reports correct line numbers

### 测试质量评估
- **覆盖率**: 99.6% 通过，但核心功能未覆盖
- **真实性**: 使用真实 SQLite 数据库 (`:memory:`)
- **边界测试**: 包含空数组、多文件、hash mismatch 等场景

---

## 🎯 发布建议

### 必须修复 (阻塞发布)
1. ❌ 修复 getSymbolDefinition.test.ts 测试失败
2. ❌ 修复 treeSitterTags.ts 引用节点提取漏洞

### 强烈建议修复 (影响质量)
3. 🟡 验证 MCP Registry 认证方式
4. 🟡 修复 semantic_symbols 主键冲突风险
5. 🟡 统一 server.json 版本号

### 可选优化 (后续版本)
6. 🟢 重构 callGraphBuilder 代码重复
7. 🟢 完善 list-symbols Glob 支持
8. 🟢 添加语义表级联删除策略

---

## 📝 发布检查清单

### 代码质量
- [ ] 修复所有测试失败
- [ ] 验证 treeSitterTags 只提取定义点
- [ ] 添加 semantic_symbols 主键冲突测试

### CI/CD
- [ ] 验证 mcp-publisher 认证方式
- [ ] 统一 server.json 版本号
- [ ] 添加 MCP 发布验证步骤

### 文档
- [x] README 删除 changelog
- [ ] 添加 tree-sitter tags 限制说明
- [ ] 添加 list-symbols Glob 模式说明

### 测试
- [ ] 运行完整测试套件并通过
- [ ] 手动验证 MCP 工具功能
  - `list-symbols --path-filter src/`
  - `get-symbol-definition --symbol foo`

---

## 🔍 测试验证建议

### 1. 修复后验证
```bash
# 修复 getSymbolDefinition.test.ts 后
pnpm test getSymbolDefinition

# 验证引用过滤
# 创建测试文件包含定义+引用，索引后查询 semantic_symbols
contextweaver index tests/fixtures/python-calls
sqlite3 ~/.contextweaver/<projectId>/index.db "SELECT * FROM semantic_symbols WHERE kind='call'"
# 应该返回 0 行（call 是引用，不是定义）
```

### 2. 集成测试
```bash
# 端到端测试 MCP 工具
echo '{"method":"list-symbols","params":{"repo_path":"/path/to/repo","path_filter":"src/"}}' | \
  contextweaver mcp

echo '{"method":"get-symbol-definition","params":{"repo_path":"/path/to/repo","symbol":"foo"}}' | \
  contextweaver mcp
```

### 3. Workflow 验证
```bash
# 手动触发 prerelease workflow
gh workflow run prerelease.yml -f version=1.5.3-rc.1

# 检查 MCP 发布是否成功
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.wchiway/contextweaver"
```

---

## 💡 架构改进建议

### 短期 (v1.5.3 或 v1.5.4)
1. 实现跨文件调用解析 (Phase 2)
2. 添加 LSP 后端支持（备选方案）
3. 符号表增量更新优化

### 中期 (v1.6.x)
1. 调用图可视化导出（Graphviz/Mermaid）
2. 语义搜索：结合符号表+向量检索
3. 符号引用计数统计

### 长期
1. 支持多工作区索引
2. 符号重命名检测（Git history）
3. 死代码检测（未引用符号）

---

## 📊 代码质量评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构设计** | 9/10 | 职责清晰，扩展性好 |
| **代码质量** | 7/10 | 有严重 bug，但整体良好 |
| **错误处理** | 8/10 | 边界检查完整，需补充部分场景 |
| **测试覆盖** | 6/10 | 高覆盖率但核心功能未测试 |
| **文档完整性** | 7/10 | 缺少限制说明 |
| **CI/CD 成熟度** | 8/10 | 自动化完整，需验证认证 |

**综合评分**: **7.5/10**

---

## ✅ 结论

**发布建议**: **延迟发布**，优先修复阻塞问题后发布 v1.5.3-rc.1。

**理由**:
1. ❌ 3 个测试失败 - 核心功能未验证
2. ❌ treeSitterTags 逻辑漏洞 - 数据污染风险
3. ⚠️ MCP Registry 认证可能失败 - 自动化不完整

**修复时间估算**:
- 测试修复: 2-4 小时
- treeSitterTags 漏洞: 1 小时
- MCP 认证验证: 2 小时

**总计**: 5-7 小时

---

## 📞 联系与反馈

**Reviewer**: Claude (Anthropic)  
**Review 工具**: Code analysis + Test execution + Manual verification  
**下一步**: 根据本报告修复问题，发布 v1.5.3-rc.1

---

**Report Generated**: 2026-06-05 17:12 UTC  
**ContextWeaver Version**: 1.5.3-rc.0  
**Review Status**: ⚠️ Issues Found - Action Required
