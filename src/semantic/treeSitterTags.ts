/**
 * Tree-sitter tags 符号提取器
 *
 * 使用各语言 grammar 自带的 tags.scm 查询文件，在纯 AST 层提取：
 * - @definition.* (function/class/method/interface/module 等定义点)
 * - @reference.* (call/type/implementation 等引用点)
 *
 * 零新增依赖，复用已安装的 tree-sitter grammar 包。
 */

import Parser from '@keqingmoe/tree-sitter';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SemanticSymbol } from './types.js';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// 语言到 npm 包名的映射（与 ParserPool 保持一致）
const GRAMMAR_MODULES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  c_sharp: 'tree-sitter-c-sharp',
  ruby: 'tree-sitter-ruby',
  php: 'tree-sitter-php',
  kotlin: 'tree-sitter-kotlin',
  swift: 'tree-sitter-swift',
  lua: '@tree-sitter-grammars/tree-sitter-lua',
  shell: 'tree-sitter-bash',
};

// 补丁：为上游不完整的 tags.scm 添加常见符号模式
const TAGS_PATCHES: Record<string, string> = {
  typescript: `
; 上游缺少普通 class 定义，补充
(class_declaration
  name: (type_identifier) @name) @definition.class

; 补充函数声明
(function_declaration
  name: (identifier) @name) @definition.function

; 补充 enum 定义
(enum_declaration
  name: (identifier) @name) @definition.class

; 补充变量/常量导出（顶层）
(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.constant
`,
  javascript: `
; 补充 class 定义
(class_declaration
  name: (identifier) @name) @definition.class

; 补充函数声明
(function_declaration
  name: (identifier) @name) @definition.function
`,
};

// 缓存已加载的 tags.scm 查询对象
const queryCache = new Map<string, Parser.Query | null>();

/**
 * 加载指定语言的 tags.scm 查询
 */
async function loadTagsQuery(
  language: string,
  grammar: unknown,
): Promise<Parser.Query | null> {
  const cached = queryCache.get(language);
  if (cached !== undefined) return cached;

  const moduleName = GRAMMAR_MODULES[language];
  if (!moduleName) {
    queryCache.set(language, null);
    return null;
  }

  try {
    // 使用 require.resolve 定位包的 package.json，再拼接 queries/tags.scm
    const packageJsonPath = require.resolve(`${moduleName}/package.json`);
    const packageRoot = dirname(packageJsonPath);
    const tagsPath = resolve(packageRoot, 'queries', 'tags.scm');

    let tagsSource = readFileSync(tagsPath, 'utf8');

    // 应用补丁（补充上游缺失的常见符号模式）
    const patch = TAGS_PATCHES[language];
    if (patch) {
      tagsSource += '\n' + patch;
    }

    // 创建 Query 对象（需要 Language 对象，grammar 已经从 ParserPool 加载）
    const query = new Parser.Query(grammar as Parameters<typeof Parser.Query>[0], tagsSource);

    queryCache.set(language, query);
    return query;
  } catch (err) {
    // tags.scm 不存在或解析失败，记录并缓存 null
    console.warn(`[TreeSitterTags] Failed to load tags.scm for ${language}:`, err);
    queryCache.set(language, null);
    return null;
  }
}

/**
 * 从 capture name 推断符号类型
 *
 * tags.scm 中的 capture 格式：
 * - @definition.function → kind = 'function'
 * - @definition.class → kind = 'class'
 * - @reference.call → kind = 'call'
 */
function captureNameToKind(captureName: string): string {
  // @definition.function → function
  // @reference.call → call
  const parts = captureName.split('.');
  if (parts.length >= 2) {
    return parts[1];
  }
  return 'symbol'; // 兜底
}

/**
 * 判断 capture 是否为定义点（vs 引用点）
 */
function isDefinition(captureName: string): boolean {
  return captureName.startsWith('definition.');
}

/**
 * 使用 Tree-sitter tags.scm 提取符号
 *
 * @param tree 已解析的 AST
 * @param grammar 语言 grammar 对象（从 ParserPool 获取）
 * @param relPath 文件相对路径
 * @param hash 文件内容哈希
 * @param language 语言标识
 * @returns 提取到的符号列表
 */
export async function extractTreeSitterSymbols(options: {
  tree: Parser.Tree;
  grammar: unknown;
  relPath: string;
  hash: string;
  language: string;
}): Promise<SemanticSymbol[]> {
  const { tree, grammar, relPath, hash, language } = options;

  const query = await loadTagsQuery(language, grammar);
  if (!query) {
    return []; // 该语言没有 tags.scm 或加载失败
  }

  try {
    // 使用 matches 而非 captures，每个 match 包含一组配对的 captures
    const matches = query.matches(tree.rootNode);
    const symbols: SemanticSymbol[] = [];

    for (const match of matches) {
      // 每个 match 的 captures 中应该有 @definition.* 和 @name
      let definitionCapture: Parser.QueryCapture | null = null;
      let nameCapture: Parser.QueryCapture | null = null;

      for (const capture of match.captures) {
        if (capture.name.startsWith('definition.') || capture.name.startsWith('reference.')) {
          definitionCapture = capture;
        } else if (capture.name === 'name') {
          nameCapture = capture;
        }
      }

      // 必须同时有定义节点和名称节点
      if (!definitionCapture || !nameCapture) {
        continue;
      }

      const symbolName = nameCapture.node.text;
      if (!symbolName || symbolName.length > 200) {
        continue; // 名称为空或异常长（可能提取错误）
      }

      const kind = captureNameToKind(definitionCapture.name);
      const source = 'tree-sitter' as const;

      symbols.push({
        path: relPath,
        hash,
        language,
        name: symbolName,
        kind,
        source,
        startLine: definitionCapture.node.startPosition.row + 1,
        endLine: definitionCapture.node.endPosition.row + 1,
        containerName: null,
      });
    }

    return symbols;
  } catch (err) {
    console.warn(`[TreeSitterTags] Query execution failed for ${relPath}:`, err);
    return [];
  }
}
