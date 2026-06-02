import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultEnvFileContent } from '../../defaultEnv.js';
import { logger } from '../../utils/logger.js';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');
const INDEX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export type ProgressCallback = (current: number, total?: number, message?: string) => void;

export interface EnsureIndexedOptions {
  onProgress?: ProgressCallback;
  vectorIndex?: boolean;
}

function isProjectIndexed(projectId: string): boolean {
  const dbPath = path.join(BASE_DIR, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

export async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  if (fs.existsSync(envFile)) {
    return;
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  fs.writeFileSync(envFile, getDefaultEnvFileContent());
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

export async function ensureIndexed(
  repoPath: string,
  projectId: string,
  options: EnsureIndexedOptions = {},
): Promise<void> {
  const { onProgress, vectorIndex = true } = options;
  const { withLock } = await import('../../utils/lock.js');
  const { scan } = await import('../../scanner/index.js');

  await withLock(
    projectId,
    'index',
    async () => {
      const wasIndexed = isProjectIndexed(projectId);

      if (!wasIndexed) {
        logger.info(
          { repoPath, projectId: projectId.slice(0, 10), vectorIndex },
          '代码库未初始化，开始首次索引...',
        );
        onProgress?.(0, 100, '代码库未索引，开始首次索引...');
      } else {
        logger.debug({ projectId: projectId.slice(0, 10), vectorIndex }, '执行增量索引...');
      }

      const startTime = Date.now();
      const stats = await scan(repoPath, { vectorIndex, onProgress });
      const elapsed = Date.now() - startTime;

      logger.info(
        {
          projectId: projectId.slice(0, 10),
          isFirstTime: !wasIndexed,
          totalFiles: stats.totalFiles,
          added: stats.added,
          modified: stats.modified,
          deleted: stats.deleted,
          vectorIndex: stats.vectorIndex,
          elapsedMs: elapsed,
        },
        '索引完成',
      );
    },
    INDEX_LOCK_TIMEOUT_MS,
  );
}

export function formatTextResponse(text: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

export function formatEnvMissingResponse(missingVars: string[]): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const configPath = '~/.contextweaver/.env';

  const text = `## ⚠️ 配置缺失

ContextWeaver 需要配置 Embedding API 才能工作。

### 缺失的环境变量
${missingVars.map((v) => `- \`${v}\``).join('\n')}

### 配置步骤

已自动创建配置文件：\`${configPath}\`

请编辑该文件，填写你的 API Key：

\`\`\`bash
# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here  # ← 替换为你的 API Key

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here      # ← 替换为你的 API Key
\`\`\`

保存文件后重新调用此工具即可。
`;

  return formatTextResponse(text);
}

export async function checkEnvOrRespond(missingVars: string[]): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  await ensureDefaultEnvFile();
  return formatEnvMissingResponse(missingVars);
}
