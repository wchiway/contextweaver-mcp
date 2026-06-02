import fs from 'node:fs';
import path from 'node:path';
import { generateProjectId } from '../db/index.js';
import { withLock } from '../utils/lock.js';
import { logger } from '../utils/logger.js';
import { initFilter, isFiltered } from './filter.js';
import { scan } from './index.js';

export interface WatcherHandle {
  close(): void;
}

export type WatchCallback = (eventType: string, fileName?: string | null) => void;

export interface WatchCoordinatorOptions {
  debounceMs: number;
  scanFn: () => Promise<void>;
  shouldIgnore: (relativePath: string) => boolean;
  watchFactory?: (
    rootPath: string,
    options: { recursive: boolean },
    callback: WatchCallback,
  ) => WatcherHandle;
}

function defaultWatchFactory(
  rootPath: string,
  options: { recursive: boolean },
  callback: WatchCallback,
): WatcherHandle {
  const watcher = fs.watch(rootPath, options, (eventType, fileName) => {
    callback(eventType, fileName);
  });

  return {
    close(): void {
      watcher.close();
    },
  };
}

function normalizeRelativePath(fileName?: string | null): string | null {
  if (!fileName) return null;
  return fileName.replace(/\\/g, '/');
}

export function createWatchCoordinator(
  rootPath: string,
  options: WatchCoordinatorOptions,
): {
  start: () => Promise<void>;
  close: () => void;
} {
  const { debounceMs, scanFn, shouldIgnore, watchFactory = defaultWatchFactory } = options;

  let timer: NodeJS.Timeout | null = null;
  let watcher: WatcherHandle | null = null;
  let started = false;
  let closed = false;
  let isScanning = false;
  let rerunRequested = false;

  const runScan = async (): Promise<void> => {
    if (closed) return;
    if (isScanning) {
      rerunRequested = true;
      return;
    }

    isScanning = true;
    try {
      await scanFn();
    } finally {
      isScanning = false;
      if (!closed && rerunRequested) {
        rerunRequested = false;
        void runScan();
      }
    }
  };

  const scheduleScan = (): void => {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void runScan();
    }, debounceMs);
  };

  const onWatchEvent: WatchCallback = (_eventType, fileName) => {
    const relativePath = normalizeRelativePath(fileName);
    if (relativePath && shouldIgnore(relativePath)) {
      return;
    }
    scheduleScan();
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      watcher = watchFactory(rootPath, { recursive: true }, onWatchEvent);
      await runScan();
    },
    close(): void {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}

export interface StartWatchModeOptions {
  debounceMs?: number;
}

export async function startWatchMode(
  rootPath: string,
  options: StartWatchModeOptions = {},
): Promise<void> {
  const absoluteRoot = path.resolve(rootPath);
  const projectId = generateProjectId(absoluteRoot);
  const debounceMs = options.debounceMs ?? 500;

  await initFilter(absoluteRoot);

  const runLockedScan = async (): Promise<void> => {
    logger.info({ rootPath: absoluteRoot }, 'watch: 触发增量扫描');
    await withLock(
      projectId,
      'index',
      async () => {
        const stats = await scan(absoluteRoot, { vectorIndex: true });
        logger.info(
          {
            added: stats.added,
            modified: stats.modified,
            deleted: stats.deleted,
            unchanged: stats.unchanged,
            skipped: stats.skipped,
            errors: stats.errors,
          },
          'watch: 扫描完成',
        );
      },
      10 * 60 * 1000,
    );
  };

  const coordinator = createWatchCoordinator(absoluteRoot, {
    debounceMs,
    scanFn: runLockedScan,
    shouldIgnore: (relativePath) => isFiltered(relativePath),
  });

  await coordinator.start();

  logger.info({ rootPath: absoluteRoot, debounceMs }, 'watch: 文件监听已启动，按 Ctrl+C 停止');

  const shutdown = (): void => {
    coordinator.close();
    logger.info('watch: 文件监听已停止');
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await new Promise<void>(() => {
    // 保持进程常驻，直到收到信号
  });
}
