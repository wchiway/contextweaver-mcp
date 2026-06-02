import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWatchCoordinator,
  type WatchCallback,
  type WatcherHandle,
} from '../../src/scanner/watcher.js';

describe('watch coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs an initial scan immediately on start', async () => {
    const scanFn = vi.fn().mockResolvedValue(undefined);
    const watcher = createWatchCoordinator('/repo', {
      debounceMs: 500,
      scanFn,
      shouldIgnore: () => false,
      watchFactory: () => ({ close: vi.fn() }),
    });

    await watcher.start();

    expect(scanFn).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid file events into a single extra scan', async () => {
    const scanFn = vi.fn().mockResolvedValue(undefined);
    let callback: WatchCallback | null = null;

    const watcher = createWatchCoordinator('/repo', {
      debounceMs: 500,
      scanFn,
      shouldIgnore: () => false,
      watchFactory: (_root, _options, cb) => {
        callback = cb;
        return { close: vi.fn() };
      },
    });

    await watcher.start();
    expect(scanFn).toHaveBeenCalledTimes(1);

    callback?.('change', 'src/a.ts');
    callback?.('change', 'src/b.ts');
    callback?.('rename', 'src/c.ts');

    await vi.advanceTimersByTimeAsync(499);
    expect(scanFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(scanFn).toHaveBeenCalledTimes(2);
  });

  it('ignores filtered paths', async () => {
    const scanFn = vi.fn().mockResolvedValue(undefined);
    let callback: WatchCallback | null = null;

    const watcher = createWatchCoordinator('/repo', {
      debounceMs: 100,
      scanFn,
      shouldIgnore: (relativePath) => relativePath.startsWith('node_modules/'),
      watchFactory: (_root, _options, cb) => {
        callback = cb;
        return { close: vi.fn() };
      },
    });

    await watcher.start();
    callback?.('change', 'node_modules/pkg/index.js');
    await vi.advanceTimersByTimeAsync(100);

    expect(scanFn).toHaveBeenCalledTimes(1);
  });

  it('queues one follow-up scan when changes arrive during an active scan', async () => {
    let releaseScan: (() => void) | null = null;
    const scanFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseScan = resolve;
        }),
    );
    let callback: WatchCallback | null = null;

    const watcher = createWatchCoordinator('/repo', {
      debounceMs: 50,
      scanFn,
      shouldIgnore: () => false,
      watchFactory: (_root, _options, cb) => {
        callback = cb;
        return { close: vi.fn() };
      },
    });

    const startPromise = watcher.start();
    expect(scanFn).toHaveBeenCalledTimes(1);

    callback?.('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(50);
    expect(scanFn).toHaveBeenCalledTimes(1);

    releaseScan?.();
    await startPromise;
    await vi.runAllTimersAsync();

    expect(scanFn).toHaveBeenCalledTimes(2);
  });

  it('closes the underlying watcher and cancels pending debounce work', async () => {
    const scanFn = vi.fn().mockResolvedValue(undefined);
    let callback: WatchCallback | null = null;
    const close = vi.fn();

    const watcher = createWatchCoordinator('/repo', {
      debounceMs: 100,
      scanFn,
      shouldIgnore: () => false,
      watchFactory: (_root, _options, cb): WatcherHandle => {
        callback = cb;
        return { close };
      },
    });

    await watcher.start();
    callback?.('change', 'src/a.ts');
    watcher.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(close).toHaveBeenCalledTimes(1);
    expect(scanFn).toHaveBeenCalledTimes(1);
  });
});
