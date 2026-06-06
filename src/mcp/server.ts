/**
 * ContextWeaver MCP Server
 *
 * 提供代码库检索能力的 Model Context Protocol 服务器
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import {
  codebaseRetrievalSchema,
  findReferencesSchema,
  getSymbolDefinitionSchema,
  handleCodebaseRetrieval,
  handleFindReferences,
  handleGetSymbolDefinition,
  handleListFiles,
  handleListSymbols,
  handleStats,
  listFilesSchema,
  listSymbolsSchema,
  statsToolSchema,
} from './tools/index.js';

// ===========================================
// 服务器配置
// ===========================================

const SERVER_NAME = 'contextweaver';

// 从最近的 package.json 读取版本，兼容源码 (src/mcp/) 与打包后 (dist/) 两种目录布局
function resolveServerVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        return (
          (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
        );
      } catch {
        break;
      }
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

const SERVER_VERSION = resolveServerVersion();

// ===========================================
// 工具定义
// ===========================================

export const TOOLS = [
  {
    name: 'codebase-retrieval',
    description: `
IMPORTANT: This is the PRIMARY tool for searching the codebase. 
It uses a hybrid engine (Semantic + Exact Match) to find relevant code.
Think of it as the "Google Search" for this repository.

Capabilities:
1. Semantic Search: Understands "what code does" (e.g., "auth logic") via high-dimensional embeddings.
2. Exact Match: Filters by precise symbols (e.g., class names) via FTS (Full Text Search).
3. Localized Context: Returns code with localized context (breadcrumbs) to avoid token overflow.

<RULES>
# 1. Tool Selection (When to use)
- ALWAYS use this tool FIRST for any code exploration or understanding task.
- DO NOT try to guess file paths. If you don't have the exact path, use this tool.
- DO NOT use 'grep' or 'find' for semantic understanding. Only use them for exhaustive text matching (e.g. "Find ALL occurrences of string 'foo'").

# 2. Before Editing (Critical)
- Before creating a plan or editing any file, YOU MUST call this tool to gather context.
- Ask for ALL symbols involved in the edit (classes, functions, types, constants).
- Do not assume you remember the code structure. Verify it with this tool.

# 3. Query Strategy (How to use)
- Split your intent:
  - Put the "Goal/Context" in 'information_request'.
  - Put "Known Class/Func Names" in 'technical_terms'.
- If the first search is too broad, add more specific 'technical_terms'.
</RULES>

Examples of GOOD queries:
* [Goal: Understand Auth] 
  information_request: "How is user authentication flow handled?"
* [Goal: Fix DB Pool bug] 
  information_request: "Logic for database connection pooling and error handling" 
  technical_terms: ["PoolConfig", "Connection", "release"]

Examples of BAD queries:
* "Show me src/main.ts" (Use 'read_file' instead)
* "Find definition of constructor of class Foo" (Use this tool, but put "Foo" in technical_terms)
* "Find all references to function bar across the whole project" (Use 'grep' tool for exhaustive reference counting)
`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        information_request: {
          type: 'string',
          description:
            "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
        },
        technical_terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'HARD FILTERS. An optional list of EXACT, KNOWN identifiers (class/function names, constants) that MUST appear in the code. Only use terms you are 100% sure exist. Leave empty if exploring.',
        },
        mode: {
          type: 'string',
          enum: ['quick', 'balanced', 'deep'],
          description:
            'Optional retrieval profile. quick reduces cost, balanced uses defaults, deep increases recall and expansion.',
        },
        include_globs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file glob allowlist applied after retrieval.',
        },
        exclude_globs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file glob denylist applied after retrieval.',
        },
        language: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional language allowlist applied after retrieval.',
        },
        max_total_chars: {
          type: 'number',
          description: 'Optional per-call output budget in characters.',
        },
        max_files: {
          type: 'number',
          description: 'Optional maximum number of files returned after packing.',
        },
        max_segments_per_file: {
          type: 'number',
          description: 'Optional maximum non-contiguous segments per file.',
        },
        return_debug: {
          type: 'boolean',
          description: 'Include per-call debug metadata when true.',
        },
        low_confidence_behavior: {
          type: 'string',
          enum: ['return_top1', 'return_empty', 'return_with_warning'],
          description: 'Controls MCP behavior when top rerank score is below SmartTopK floor.',
        },
        output_format: {
          type: 'string',
          enum: ['markdown', 'json', 'both'],
          description: 'Response format. Defaults to markdown for backward compatibility.',
        },
      },
      required: ['repo_path', 'information_request'],
    },
  },
  {
    name: 'stats',
    description: `Show ContextWeaver index/search/health statistics for a repository.

Returns three sections:
1. Index process: last index run snapshot + cumulative run count.
2. Search quality/behavior: cumulative queries, cache hit rate, average per-stage latency (retrieve/rerank/expand/pack), average recall.
3. Health/consistency: file count, language breakdown, LanceDB vector row count, embedding dimensions, migration state, pending_marks, and cross-store consistency diagnostics.

Use this to inspect whether the index is healthy and how search is performing.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'list-files',
    description: `List indexed files for quick structural exploration.

Use this when you want:
- repository structure
- file paths, languages, and sizes
- zero embedding API cost

This is a metadata view, not semantic retrieval.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        glob: {
          type: 'string',
          description: 'Optional glob pattern to filter returned file paths.',
        },
        language: {
          type: 'string',
          description: 'Optional language filter matched against files.language.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of files to return. Defaults to 200.',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'find-references',
    description: `Find heuristic text references to a known symbol across indexed chunks.

Use this when:
- you know the exact symbol name
- you want likely usage sites

Limits:
- heuristic text search, not compiler-accurate references
- for exhaustive raw text matching, use grep outside MCP`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        symbol: {
          type: 'string',
          description: 'The exact symbol name to search for.',
        },
        exclude_definition: {
          type: 'boolean',
          description: 'Exclude chunks whose breadcrumb tail matches the symbol name.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of references to return. Defaults to 50.',
        },
      },
      required: ['repo_path', 'symbol'],
    },
  },
  {
    name: 'get-symbol-definition',
    description: `Find likely symbol definitions for a known symbol name.

Use this when:
- you know the exact symbol name
- you want the defining code block

Limits:
- heuristic definition lookup, not compiler-accurate navigation
- ranks breadcrumb matches first, then definition-pattern FTS fallback`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        symbol: {
          type: 'string',
          description: 'The exact symbol name to resolve.',
        },
        hint_path: {
          type: 'string',
          description: 'Optional preferred path used to disambiguate same-name definitions.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of definitions to return. Defaults to 3.',
        },
      },
      required: ['repo_path', 'symbol'],
    },
  },
  {
    name: 'list-symbols',
    description: `List all symbols (functions, classes, interfaces, etc.) in the codebase with optional filtering.

Use this when:
- You want an overview of available symbols in a directory/file
- You need to browse the symbol structure of the codebase
- You want to filter symbols by type, language, or path

Returns:
- Grouped by file, ordered by line number
- Symbol kind (function, class, interface, etc.)
- Line range for each symbol
- Container information (e.g., which class a method belongs to)`,
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'The absolute file system path to the repository root.',
        },
        path_filter: {
          type: 'string',
          description:
            'Optional path filter (prefix or glob pattern, e.g., "src/search" or "**/*.ts")',
        },
        kind_filter: {
          type: 'string',
          description: 'Optional comma-separated symbol kinds (e.g., "function,class,interface")',
        },
        language: {
          type: 'string',
          description: 'Optional language filter (e.g., "typescript", "python", "go")',
        },
        source: {
          type: 'string',
          description: 'Optional source filter ("tree-sitter" or "ctags")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of symbols to return (default: 100, max: 500)',
        },
      },
      required: ['repo_path'],
    },
  },
];

// ===========================================
// 服务器初始化
// ===========================================

/**
 * 启动 MCP 服务器
 */
export async function startMcpServer(): Promise<void> {
  logger.info({ name: SERVER_NAME }, '启动 MCP 服务器');

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 注册工具列表处理器
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('收到 list_tools 请求');
    return { tools: TOOLS };
  });

  // 注册工具调用处理器
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    logger.info({ tool: name }, '收到 call_tool 请求');

    // 提取 progressToken（如果客户端请求进度通知）
    const rawToken = extra._meta?.progressToken;
    const progressToken =
      typeof rawToken === 'string' || typeof rawToken === 'number' ? rawToken : undefined;

    // 创建进度通知回调
    const onProgress = progressToken
      ? async (current: number, total?: number, message?: string) => {
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: current,
                total,
                message,
              },
            });
          } catch (err) {
            // 忽略通知发送失败，不影响主流程
            logger.debug({ error: (err as Error).message }, '发送进度通知失败');
          }
        }
      : undefined;

    try {
      switch (name) {
        case 'codebase-retrieval': {
          const parsed = codebaseRetrievalSchema.parse(args);
          return await handleCodebaseRetrieval(parsed, onProgress);
        }
        case 'stats': {
          const parsed = statsToolSchema.parse(args);
          return await handleStats(parsed);
        }
        case 'list-files': {
          const parsed = listFilesSchema.parse(args);
          return await handleListFiles(parsed, onProgress);
        }
        case 'find-references': {
          const parsed = findReferencesSchema.parse(args);
          return await handleFindReferences(parsed, onProgress);
        }
        case 'get-symbol-definition': {
          const parsed = getSymbolDefinitionSchema.parse(args);
          return await handleGetSymbolDefinition(parsed, onProgress);
        }
        case 'list-symbols': {
          const parsed = listSymbolsSchema.parse(args);
          return await handleListSymbols(parsed, onProgress);
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ error: error.message, stack: error.stack, tool: name }, '工具调用失败');
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // 启动 stdio 传输
  const transport = new StdioServerTransport();
  logger.info('MCP 服务器已启动，等待连接...');
  await server.connect(transport);
}
