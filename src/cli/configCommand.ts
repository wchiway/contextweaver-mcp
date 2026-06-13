/**
 * Config 命令：环境变量配置管理
 *
 * 功能：
 * - contextweaver config list: 查看当前配置
 * - contextweaver config set KEY VALUE: 设置单个环境变量
 * - contextweaver config wizard: 交互式配置向导
 * - contextweaver config validate: 验证配置有效性
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CAC } from 'cac';
import { checkEmbeddingEnv, checkRerankerEnv } from '../config.js';
import { logger } from '../utils/logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.contextweaver');
const ENV_FILE = path.join(CONFIG_DIR, '.env');

/**
 * 环境变量键定义
 */
const ENV_KEYS = {
  // Embedding
  EMBEDDINGS_API_KEY: { desc: 'Embedding API Key', required: true, secret: true },
  EMBEDDINGS_BASE_URL: { desc: 'Embedding API Base URL', required: true, secret: false },
  EMBEDDINGS_MODEL: { desc: 'Embedding Model', required: true, secret: false },
  EMBEDDINGS_MAX_CONCURRENCY: { desc: 'Embedding 并发数', required: false, secret: false },
  EMBEDDINGS_DIMENSIONS: { desc: 'Embedding 向量维度', required: false, secret: false },

  // Reranker
  RERANK_API_KEY: { desc: 'Reranker API Key', required: true, secret: true },
  RERANK_BASE_URL: { desc: 'Reranker API Base URL', required: true, secret: true },
  RERANK_MODEL: { desc: 'Reranker Model', required: true, secret: false },
  RERANK_TOP_N: { desc: 'Reranker Top N', required: false, secret: false },

  // Search
  CW_SEARCH_WVEC: { desc: '向量搜索权重', required: false, secret: false },
  CW_SEARCH_WLEX: { desc: '词法搜索权重', required: false, secret: false },
  CW_SEARCH_RERANK_TOP_N: { desc: 'Rerank Top N', required: false, secret: false },
  CW_SEARCH_MAX_TOTAL_CHARS: { desc: '最大输出字符数', required: false, secret: false },
  CW_SEARCH_VECTOR_TOP_K: { desc: '向量召回 Top K', required: false, secret: false },
  CW_SEARCH_SMART_MAX_K: { desc: '智能最大 K', required: false, secret: false },
  CW_SEARCH_IMPORT_FILES_PER_SEED: { desc: '每个种子导入文件数', required: false, secret: false },

  // Ignore
  IGNORE_PATTERNS: { desc: '忽略模式（逗号分隔）', required: false, secret: false },
} as const;

type EnvKey = keyof typeof ENV_KEYS;

/**
 * 解析 .env 文件
 */
async function parseEnvFile(): Promise<Map<string, string>> {
  const envMap = new Map<string, string>();

  try {
    const content = await fs.readFile(ENV_FILE, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过注释和空行
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      envMap.set(key, value);
    }
  } catch (err) {
    const error = err as { code?: string };
    if (error.code !== 'ENOENT') {
      throw err;
    }
    // 文件不存在，返回空 Map
  }

  return envMap;
}

/**
 * 写入 .env 文件
 */
async function writeEnvFile(envMap: Map<string, string>): Promise<void> {
  // 确保目录存在
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  // 构建内容
  const lines: string[] = ['# ContextWeaver 配置', ''];

  // Embedding 分组
  lines.push('# Embedding API');
  for (const key of Object.keys(ENV_KEYS) as EnvKey[]) {
    if (key.startsWith('EMBEDDINGS_')) {
      const value = envMap.get(key) || '';
      lines.push(`${key}=${value}`);
    }
  }

  lines.push('');
  lines.push('# Reranker');
  for (const key of Object.keys(ENV_KEYS) as EnvKey[]) {
    if (key.startsWith('RERANK_')) {
      const value = envMap.get(key) || '';
      lines.push(`${key}=${value}`);
    }
  }

  lines.push('');
  lines.push('# 搜索参数（可选）');
  for (const key of Object.keys(ENV_KEYS) as EnvKey[]) {
    if (key.startsWith('CW_SEARCH_')) {
      const value = envMap.get(key);
      if (value) {
        lines.push(`${key}=${value}`);
      } else {
        lines.push(`# ${key}=`);
      }
    }
  }

  lines.push('');
  lines.push('# 忽略模式');
  const ignorePatterns = envMap.get('IGNORE_PATTERNS');
  if (ignorePatterns) {
    lines.push(`IGNORE_PATTERNS=${ignorePatterns}`);
  } else {
    lines.push('# IGNORE_PATTERNS=.venv,node_modules');
  }

  await fs.writeFile(ENV_FILE, lines.join('\n') + '\n');
}

/**
 * 列出当前配置
 */
async function listConfig(): Promise<void> {
  const envMap = await parseEnvFile();

  console.log(`\n配置文件: ${ENV_FILE}\n`);

  // 必需配置
  console.log('必需配置:');
  for (const [key, meta] of Object.entries(ENV_KEYS)) {
    if (!meta.required) continue;

    const value = envMap.get(key);
    const displayValue = value
      ? meta.secret
        ? maskSecret(value)
        : value
      : '(未设置)';

    console.log(`  ${key.padEnd(30)} = ${displayValue}`);
  }

  // 可选配置
  console.log('\n可选配置:');
  for (const [key, meta] of Object.entries(ENV_KEYS)) {
    if (meta.required) continue;

    const value = envMap.get(key);
    if (value) {
      console.log(`  ${key.padEnd(30)} = ${value}`);
    }
  }

  console.log('');
}

/**
 * 设置环境变量
 */
async function setConfig(key: string, value: string): Promise<void> {
  // 验证 key
  if (!(key in ENV_KEYS)) {
    logger.error(`无效的配置键: ${key}`);
    logger.info('可用的配置键:');
    for (const k of Object.keys(ENV_KEYS)) {
      console.log(`  - ${k}`);
    }
    process.exit(1);
  }

  const envMap = await parseEnvFile();
  envMap.set(key, value);
  await writeEnvFile(envMap);

  logger.info(`已设置 ${key} = ${ENV_KEYS[key as EnvKey].secret ? maskSecret(value) : value}`);
}

/**
 * 验证配置有效性
 */
async function validateConfig(): Promise<void> {
  logger.info('开始验证配置...\n');

  // 检查文件是否存在
  try {
    await fs.access(ENV_FILE);
  } catch {
    logger.error(`配置文件不存在: ${ENV_FILE}`);
    logger.info('请先运行 `contextweaver init` 初始化配置');
    process.exit(1);
  }

  // 重新加载环境变量（模拟生产环境加载）
  const envMap = await parseEnvFile();
  for (const [key, value] of envMap.entries()) {
    process.env[key] = value;
  }

  // 检查 Embedding
  const embResult = checkEmbeddingEnv();
  if (embResult.isValid) {
    logger.info('✓ Embedding 配置有效');
  } else {
    logger.error('✗ Embedding 配置无效');
    logger.error(`  缺失: ${embResult.missingVars.join(', ')}`);
  }

  // 检查 Reranker
  const rerankResult = checkRerankerEnv();
  if (rerankResult.isValid) {
    logger.info('✓ Reranker 配置有效');
  } else {
    logger.error('✗ Reranker 配置无效');
    logger.error(`  缺失: ${rerankResult.missingVars.join(', ')}`);
  }

  if (!embResult.isValid || !rerankResult.isValid) {
    process.exit(1);
  }

  logger.info('\n配置验证通过！');
}

/**
 * 掩码敏感信息
 */
function maskSecret(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

/**
 * 交互式配置向导
 */
async function configWizard(): Promise<void> {
  logger.info('ContextWeaver 配置向导\n');

  const envMap = await parseEnvFile();

  // 使用简单的 readline 交互
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  try {
    console.log('=== Embedding 配置 ===\n');

    const embKey = await question(
      `EMBEDDINGS_API_KEY [${envMap.get('EMBEDDINGS_API_KEY') ? '已设置' : '未设置'}]: `,
    );
    if (embKey.trim()) {
      envMap.set('EMBEDDINGS_API_KEY', embKey.trim());
    }

    const embUrl = await question(
      `EMBEDDINGS_BASE_URL [${envMap.get('EMBEDDINGS_BASE_URL') || 'https://api.siliconflow.cn/v1/embeddings'}]: `,
    );
    if (embUrl.trim()) {
      envMap.set('EMBEDDINGS_BASE_URL', embUrl.trim());
    } else if (!envMap.has('EMBEDDINGS_BASE_URL')) {
      envMap.set('EMBEDDINGS_BASE_URL', 'https://api.siliconflow.cn/v1/embeddings');
    }

    const embModel = await question(
      `EMBEDDINGS_MODEL [${envMap.get('EMBEDDINGS_MODEL') || 'BAAI/bge-m3'}]: `,
    );
    if (embModel.trim()) {
      envMap.set('EMBEDDINGS_MODEL', embModel.trim());
    } else if (!envMap.has('EMBEDDINGS_MODEL')) {
      envMap.set('EMBEDDINGS_MODEL', 'BAAI/bge-m3');
    }

    const embDim = await question(
      `EMBEDDINGS_DIMENSIONS [${envMap.get('EMBEDDINGS_DIMENSIONS') || '1024'}]: `,
    );
    if (embDim.trim()) {
      envMap.set('EMBEDDINGS_DIMENSIONS', embDim.trim());
    } else if (!envMap.has('EMBEDDINGS_DIMENSIONS')) {
      envMap.set('EMBEDDINGS_DIMENSIONS', '1024');
    }

    console.log('\n=== Reranker 配置 ===\n');

    const rerankKey = await question(
      `RERANK_API_KEY [${envMap.get('RERANK_API_KEY') ? '已设置' : '未设置'}]: `,
    );
    if (rerankKey.trim()) {
      envMap.set('RERANK_API_KEY', rerankKey.trim());
    }

    const rerankUrl = await question(
      `RERANK_BASE_URL [${envMap.get('RERANK_BASE_URL') || 'https://api.siliconflow.cn/v1/rerank'}]: `,
    );
    if (rerankUrl.trim()) {
      envMap.set('RERANK_BASE_URL', rerankUrl.trim());
    } else if (!envMap.has('RERANK_BASE_URL')) {
      envMap.set('RERANK_BASE_URL', 'https://api.siliconflow.cn/v1/rerank');
    }

    const rerankModel = await question(
      `RERANK_MODEL [${envMap.get('RERANK_MODEL') || 'BAAI/bge-reranker-v2-m3'}]: `,
    );
    if (rerankModel.trim()) {
      envMap.set('RERANK_MODEL', rerankModel.trim());
    } else if (!envMap.has('RERANK_MODEL')) {
      envMap.set('RERANK_MODEL', 'BAAI/bge-reranker-v2-m3');
    }

    await writeEnvFile(envMap);
    logger.info('\n配置已保存！');
  } finally {
    rl.close();
  }
}

/**
 * 注册 config 命令
 */
export function registerConfigCommand(cli: CAC): void {
  cli
    .command('config <action> [...args]', '管理环境变量配置')
    .usage('contextweaver config <action> [...args]')
    .example('contextweaver config list              # 查看当前配置')
    .example('contextweaver config set KEY VALUE     # 设置环境变量')
    .example('contextweaver config validate          # 验证配置')
    .example('contextweaver config wizard            # 交互式配置向导')
    .action(async (action: string, varArgs: string[]) => {
      // varArgs 是一个数组，包含所有可变参数
      const args = Array.isArray(varArgs) ? varArgs : [];

      try {
        switch (action) {
          case 'list':
          case 'ls':
            await listConfig();
            break;

          case 'set': {
            if (args.length < 2) {
              logger.error('用法: contextweaver config set <key> <value>');
              logger.info('\n可用的配置键:');
              for (const k of Object.keys(ENV_KEYS)) {
                console.log(`  - ${k}`);
              }
              process.exit(1);
            }
            const [key, value] = args;
            await setConfig(key, value);
            break;
          }

          case 'validate':
            await validateConfig();
            break;

          case 'wizard':
            await configWizard();
            break;

          default:
            logger.error(`未知的操作: ${action}`);
            logger.info('\n可用操作:');
            console.log('  list (ls)  - 查看当前配置');
            console.log('  set        - 设置单个环境变量');
            console.log('  validate   - 验证配置有效性');
            console.log('  wizard     - 交互式配置向导');
            process.exit(1);
        }
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ err, stack: error.stack }, `配置操作失败: ${error.message}`);
        process.exit(1);
      }
    });
}
