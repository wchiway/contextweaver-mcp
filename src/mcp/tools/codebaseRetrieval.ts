/**
 * codebase-retrieval MCP Tool
 *
 * 代码检索工具
 *
 * 设计理念：
 * - 意图与术语分离：LLM 只需区分"语义意图"和"精确术语"
 * - 回归代理本能：工具只负责定位，跨文件探索由 Agent 自主发起
 */

import { z } from 'zod';
import { generateProjectId } from '../../db/index.js';
// 注意：SearchService 和 scan 改为延迟导入，避免在 MCP 启动时就加载 native 模块
import type { ContextPack, SearchConfig, Segment } from '../../search/types.js';
import { logger } from '../../utils/logger.js';
import { checkEnvOrRespond, ensureIndexed, type ProgressCallback } from './shared.js';

// 工具 Schema (暴露给 LLM)

export const codebaseRetrievalSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  information_request: z
    .string()
    .describe(
      "The SEMANTIC GOAL. Describe the functionality, logic, or behavior you are looking for in full natural language sentences. Focus on 'how it works' rather than exact names. (e.g., 'Trace the execution flow of the login process')",
    ),
  technical_terms: z
    .array(z.string())
    .optional()
    .describe(
      'HARD FILTERS. Precise identifiers to narrow down results. Only use symbols KNOWN to exist to avoid false negatives.',
    ),
  mode: z
    .enum(['quick', 'balanced', 'deep'])
    .optional()
    .describe(
      'Optional retrieval profile. quick reduces cost, balanced uses defaults, deep increases recall and expansion.',
    ),
  include_globs: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('Optional file glob allowlist applied after retrieval.'),
  exclude_globs: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('Optional file glob denylist applied after retrieval.'),
  language: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe('Optional language allowlist applied after retrieval.'),
  max_total_chars: z
    .number()
    .int()
    .min(20000)
    .max(80000)
    .optional()
    .describe('Optional per-call output budget in characters.'),
  max_files: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Optional maximum number of files returned after packing.'),
  max_segments_per_file: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Optional maximum non-contiguous segments per file.'),
  return_debug: z.boolean().optional().describe('Include per-call debug metadata when true.'),
  output_format: z
    .enum(['markdown', 'json', 'both'])
    .optional()
    .describe('Response format. Defaults to markdown for backward compatibility.'),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalSchema>;

export interface CodebaseRetrievalFormatOptions {
  outputFormat?: 'markdown' | 'json' | 'both';
  returnDebug?: boolean;
}

function modeConfig(mode: CodebaseRetrievalInput['mode']): Partial<SearchConfig> {
  switch (mode) {
    case 'quick':
      return {
        vectorTopK: 40,
        vectorTopM: 30,
        lexTotalChunks: 20,
        fusedTopM: 30,
        rerankTopN: 5,
        smartMaxK: 5,
        importFilesPerSeed: 0,
      };
    case 'deep':
      return {
        vectorTopK: 120,
        vectorTopM: 80,
        lexTotalChunks: 60,
        fusedTopM: 80,
        rerankTopN: 15,
        smartMaxK: 12,
        importFilesPerSeed: 5,
      };
    case 'balanced':
    case undefined:
      return {};
  }
}

function requestConfigOverrides(args: CodebaseRetrievalInput): Partial<SearchConfig> {
  return {
    ...modeConfig(args.mode),
    ...(args.max_total_chars !== undefined ? { maxTotalChars: args.max_total_chars } : {}),
    ...(args.max_segments_per_file !== undefined
      ? { maxSegmentsPerFile: args.max_segments_per_file }
      : {}),
  };
}

// 工具处理函数

/**
 * 处理 codebase-retrieval 工具调用
 *
 * @param args 工具输入参数
 * @param onProgress 可选的进度回调（用于 MCP 进度通知）
 */
export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, information_request, technical_terms } = args;

  logger.info(
    {
      repo_path,
      information_request,
      technical_terms,
    },
    'MCP codebase-retrieval 调用开始',
  );

  // 0. 检查必需的环境变量是否已配置（Embedding + Reranker 都是必需的）
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    logger.warn({ missingVars: allMissingVars }, 'MCP 环境变量未配置');
    return await checkEnvOrRespond(allMissingVars);
  }

  // 1. 生成项目 ID（与 CLI 保持一致：路径 + 目录创建时间）
  const projectId = generateProjectId(repo_path);

  // 2. 确保代码库已索引（自动初始化 + 增量更新）
  await ensureIndexed(repo_path, projectId, { onProgress });

  // 3. 合并查询
  // - information_request 驱动语义向量搜索
  // - technical_terms 增强词法（FTS）匹配
  const semanticQuery = information_request.trim();
  const lexicalQuery = [information_request, ...(technical_terms || [])].filter(Boolean).join(' ');

  logger.info(
    {
      projectId: projectId.slice(0, 10),
      semanticQuery,
      lexicalQuery,
    },
    'MCP 查询构建',
  );

  // 4. 延迟导入 SearchService（避免 MCP 启动时加载 native 模块）
  const { SearchService } = await import('../../search/SearchService.js');
  const { getSearchConfigOverrides } = await import('../../search/loadConfig.js');

  // 5. 创建 SearchService 实例
  const configOverrides = {
    ...getSearchConfigOverrides(),
    ...requestConfigOverrides(args),
  };
  const service = new SearchService(projectId, repo_path, configOverrides);
  await service.init();
  logger.debug('SearchService 初始化完成');

  // 6. 执行搜索
  const contextPack = await service.buildContextPack({
    semanticQuery,
    lexicalQuery,
    technicalTerms: technical_terms ?? [],
  });

  // 详细日志：seeds 信息
  if (contextPack.seeds.length > 0) {
    logger.info(
      {
        seeds: contextPack.seeds.map((s) => ({
          file: s.filePath,
          chunk: s.chunkIndex,
          score: s.score.toFixed(4),
          source: s.source,
        })),
      },
      'MCP 搜索 seeds',
    );
  } else {
    logger.warn('MCP 搜索无 seeds 命中');
  }

  // 详细日志：扩展结果
  if (contextPack.expanded.length > 0) {
    logger.debug(
      {
        expandedCount: contextPack.expanded.length,
        expanded: contextPack.expanded.slice(0, 5).map((e) => ({
          file: e.filePath,
          chunk: e.chunkIndex,
          score: e.score.toFixed(4),
        })),
      },
      'MCP 扩展结果 (前5)',
    );
  }

  // 详细日志：打包后的文件段落
  logger.info(
    {
      seedCount: contextPack.seeds.length,
      expandedCount: contextPack.expanded.length,
      fileCount: contextPack.files.length,
      totalSegments: contextPack.files.reduce((acc, f) => acc + f.segments.length, 0),
      files: contextPack.files.map((f) => ({
        path: f.filePath,
        segments: f.segments.length,
        lines: f.segments.map((s) => `L${s.startLine}-${s.endLine}`),
      })),
      timingMs: contextPack.debug?.timingMs,
    },
    'MCP codebase-retrieval 完成',
  );

  // 7. 格式化输出
  return formatCodebaseRetrievalResponse(contextPack, {
    outputFormat: args.output_format,
    returnDebug: args.return_debug,
  });
}

// 响应格式化

/**
 * 格式化为 MCP 响应格式
 */
export function formatCodebaseRetrievalResponse(
  pack: ContextPack,
  options: CodebaseRetrievalFormatOptions = {},
): { content: Array<{ type: 'text'; text: string }> } {
  const outputFormat = options.outputFormat ?? 'markdown';
  if (outputFormat === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(toJsonPayload(pack, options), null, 2),
        },
      ],
    };
  }

  if (outputFormat === 'both') {
    return {
      content: [
        {
          type: 'text',
          text: formatMarkdown(pack),
        },
        {
          type: 'text',
          text: JSON.stringify(toJsonPayload(pack, options), null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: formatMarkdown(pack),
      },
    ],
  };
}

function formatMarkdown(pack: ContextPack): string {
  const { files, seeds } = pack;

  // 构建文件内容块
  const fileBlocks = files
    .map((file) => {
      const segments = file.segments.map((seg) => formatSegment(seg)).join('\n\n');
      return segments;
    })
    .join('\n\n---\n\n');

  // 构建摘要
  const summary = [
    `Found ${seeds.length} relevant code blocks`,
    `Files: ${files.length}`,
    `Total segments: ${files.reduce((acc, f) => acc + f.segments.length, 0)}`,
  ].join(' | ');

  return `${summary}\n\n${fileBlocks}`;
}

function toJsonPayload(pack: ContextPack, options: CodebaseRetrievalFormatOptions) {
  return {
    query: pack.query,
    summary: {
      seedCount: pack.seeds.length,
      expandedCount: pack.expanded.length,
      fileCount: pack.files.length,
      totalSegments: pack.files.reduce((acc, f) => acc + f.segments.length, 0),
    },
    files: pack.files.map((file) => ({
      path: file.filePath,
      segments: file.segments.map((seg) => ({
        path: seg.filePath,
        startLine: seg.startLine,
        endLine: seg.endLine,
        score: seg.score,
        breadcrumb: seg.breadcrumb,
        text: seg.text,
      })),
    })),
    ...(options.returnDebug && pack.debug ? { debug: pack.debug } : {}),
  };
}

/**
 * 格式化单个代码段
 */
function formatSegment(seg: Segment): string {
  const lang = detectLanguage(seg.filePath);
  const header = `## ${seg.filePath} (L${seg.startLine}-${seg.endLine})`;
  const breadcrumb = seg.breadcrumb ? `> ${seg.breadcrumb}` : '';
  const code = `\`\`\`${lang}\n${seg.text}\n\`\`\``;

  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

/**
 * 根据文件扩展名检测语言
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}
