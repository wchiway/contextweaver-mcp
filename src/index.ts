#!/usr/bin/env node
// 配置必须最先加载（包含环境变量初始化）
import './config.js';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import { registerMirrorCommands } from './cli/mirrorCommands.js';
import { registerUpdateCommand } from './cli/updateCommand.js';
import { generateProjectId } from './db/index.js';
import { getDefaultEnvFileContent } from './defaultEnv.js';
import { type ScanStats, scan } from './scanner/index.js';
import { startWatchMode } from './scanner/watcher.js';
import { logger } from './utils/logger.js';

// 读取 package.json 获取版本号
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

const cli = cac('contextweaver');

// 自定义版本输出，只显示版本号
if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

cli.command('init', '初始化 ContextWeaver 配置').action(async () => {
  const configDir = path.join(os.homedir(), '.contextweaver');
  const envFile = path.join(configDir, '.env');

  logger.info('开始初始化 ContextWeaver...');

  // 创建配置目录
  try {
    await fs.mkdir(configDir, { recursive: true });
    logger.info(`创建配置目录: ${configDir}`);
  } catch (err) {
    const error = err as { code?: string; message?: string; stack?: string };
    if (error.code !== 'EEXIST') {
      logger.error({ err, stack: error.stack }, `创建配置目录失败: ${error.message}`);
      process.exit(1);
    }
    logger.info(`配置目录已存在: ${configDir}`);
  }

  // 检查是否已存在 .env 文件
  try {
    await fs.access(envFile);
    logger.warn(`.env 文件已存在: ${envFile}`);
    logger.info('初始化完成！');
    return;
  } catch {
    // 文件不存在，继续创建
  }

  // 写入默认 .env 配置
  const defaultEnvContent = getDefaultEnvFileContent();
  try {
    await fs.writeFile(envFile, defaultEnvContent);
    logger.info(`创建 .env 文件: ${envFile}`);
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error({ err, stack: error.stack }, `创建 .env 文件失败: ${error.message}`);
    process.exit(1);
  }

  logger.info('下一步操作:');
  logger.info(`   1. 编辑配置文件: ${envFile}`);
  logger.info('   2. 填写你的 API Key 和其他配置');
  logger.info('初始化完成！');
});

cli
  .command('index [path]', '扫描代码库并建立索引')
  .option('-f, --force', '强制重新索引')
  .action(async (targetPath: string | undefined, options: { force?: boolean }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const projectId = generateProjectId(rootPath);

    logger.info(`开始扫描: ${rootPath}`);
    logger.info(`项目 ID: ${projectId}`);
    if (options.force) {
      logger.info('强制重新索引: 是');
    }

    const startTime = Date.now();

    try {
      const { withLock } = await import('./utils/lock.js');

      // 进度日志节流：只在 30%、60%、90% 时输出（100% 由扫描完成日志代替）
      let lastLoggedPercent = 0;
      const stats: ScanStats = await withLock(
        projectId,
        'index',
        async () =>
          scan(rootPath, {
            force: options.force,
            onProgress: (current, total, message) => {
              if (total !== undefined) {
                const percent = Math.floor((current / total) * 100);
                if (percent >= lastLoggedPercent + 30 && percent < 100) {
                  logger.info(`索引进度: ${percent}% - ${message || ''}`);
                  lastLoggedPercent = Math.floor(percent / 30) * 30;
                }
              }
            },
          }),
        10 * 60 * 1000,
      );

      process.stdout.write('\n');

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`索引完成 (${duration}s)`);
      logger.info(
        `总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
      );
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `索引失败: ${error.message}`);
      process.exit(1);
    }
  });

cli
  .command('watch [path]', '监听文件变化并自动执行增量索引')
  .option('--debounce <ms>', '防抖时间（毫秒，默认 500）')
  .action(async (targetPath: string | undefined, options: { debounce?: string }) => {
    const rootPath = targetPath ? path.resolve(targetPath) : process.cwd();
    const debounceMs = options.debounce ? Number.parseInt(options.debounce, 10) : 500;

    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      logger.error('无效的 --debounce 参数，必须是大于等于 0 的整数');
      process.exit(1);
    }

    try {
      await startWatchMode(rootPath, { debounceMs });
    } catch (err) {
      const error = err as { message?: string; stack?: string };
      logger.error({ err, stack: error.stack }, `watch 模式启动失败: ${error.message}`);
      process.exit(1);
    }
  });

cli.command('mcp', '启动 MCP 服务器').action(async () => {
  // 动态导入并启动 MCP 服务器
  const { startMcpServer } = await import('./mcp/server.js');
  try {
    await startMcpServer();
  } catch (err) {
    const error = err as { message?: string; stack?: string };
    logger.error(
      { error: error.message, stack: error.stack },
      `MCP 服务器启动失败: ${error.message}`,
    );
    process.exit(1);
  }
});

cli
  .command('search', '本地检索（参数对齐 MCP）')
  .option('--repo-path <path>', '代码库根目录（默认当前目录）')
  .option('--information-request <text>', '自然语言问题描述（必填）')
  .option('--technical-terms <terms>', '精确术语（逗号分隔）')
  .option('--mode <mode>', '检索模式：quick | balanced | deep')
  .option('--max-total-chars <n>', '输出字符预算')
  .action(
    async (options: {
      repoPath?: string;
      informationRequest?: string;
      technicalTerms?: string;
      mode?: string;
      maxTotalChars?: string;
    }) => {
      const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
      const informationRequest = options.informationRequest;
      if (!informationRequest) {
        logger.error('缺少 --information-request');
        process.exit(1);
      }

      const technicalTerms = (options.technicalTerms || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const maxTotalChars = options.maxTotalChars
        ? Number.parseInt(options.maxTotalChars, 10)
        : undefined;

      const { handleCodebaseRetrieval } = await import('./mcp/tools/codebaseRetrieval.js');

      const response = await handleCodebaseRetrieval({
        repo_path: repoPath,
        information_request: informationRequest,
        technical_terms: technicalTerms.length > 0 ? technicalTerms : undefined,
        mode:
          options.mode === 'quick' || options.mode === 'balanced' || options.mode === 'deep'
            ? options.mode
            : undefined,
        max_total_chars: Number.isFinite(maxTotalChars) ? maxTotalChars : undefined,
      });

      const text = response.content.map((item) => item.text).join('\n');
      process.stdout.write(`${text}\n`);
    },
  );

cli
  .command('migrate', 'LanceDB 迁移管理（CRIT-B/CRIT-C）')
  .option('--reset', '清空 LanceDB chunks 表并重置迁移状态（用于解除 aborted）')
  .option('-p, --path <path>', '项目路径（默认当前目录）')
  .action(async (options: { reset?: boolean; path?: string }) => {
    const rootPath = options.path ? path.resolve(options.path) : process.cwd();
    const projectId = generateProjectId(rootPath);

    const { initDb, getLanceDbMigrationState, setLanceDbMigrationState, clearAllVectorIndexHash } =
      await import('./db/index.js');
    const db = initDb(projectId);

    const state = getLanceDbMigrationState(db);
    logger.info({ projectId, state }, '当前 LanceDB 迁移状态');

    if (!options.reset) {
      logger.info('如需解除 aborted 状态，使用 --reset 选项');
      db.close();
      return;
    }

    if (state !== 'aborted' && state !== 'pending') {
      logger.info(`状态为 ${state ?? '未设置'}，无需 reset`);
      db.close();
      return;
    }

    // 1. 清空 LanceDB chunks 表
    const { getVectorStore } = await import('./vectorStore/index.js');
    const { getEmbeddingConfig } = await import('./config.js');
    const store = await getVectorStore(projectId, getEmbeddingConfig().dimensions);
    await store.clear();
    logger.info('LanceDB chunks 表已清空');

    // 2. 清空所有 vector_index_hash，让自愈机制全量重建
    const cleared = clearAllVectorIndexHash(db);
    logger.info({ cleared }, 'vector_index_hash 已清空');

    // 3. 重置迁移状态为 done（新表会用新 schema）
    setLanceDbMigrationState(db, 'done');
    logger.info('迁移状态已重置为 done。请重新运行 `contextweaver index` 重建索引。');

    db.close();
  });

cli
  .command('stats', '查看索引/搜索/健康统计')
  .option('--json', '以 JSON 格式输出')
  .option('-p, --path <path>', '项目路径（默认当前目录）')
  .action(async (options: { json?: boolean; path?: string }) => {
    const rootPath = options.path ? path.resolve(options.path) : process.cwd();
    const projectId = generateProjectId(rootPath);

    const { collectStats, renderStatsText } = await import('./stats/index.js');
    const report = await collectStats(projectId);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderStatsText(report)}\n`);
    }
  });

registerMirrorCommands(cli);
registerUpdateCommand(cli, { currentVersion: pkg.version, packageRoot: path.dirname(pkgPath) });

cli.help();
cli.parse();
