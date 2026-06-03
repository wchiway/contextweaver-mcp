import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpdateCommand,
  detectPackageManager,
  registerUpdateCommand,
  runPackageManagerUpdate,
  type ExecFileSyncFn,
  type SpawnFn,
} from '../../src/cli/updateCommand.js';

interface RegisteredCommand {
  name: string;
  description: string;
  action?: (...args: unknown[]) => unknown;
}

function createFakeCli() {
  const commands = new Map<string, RegisteredCommand>();

  return {
    commands,
    command(name: string, description: string) {
      const registered: RegisteredCommand = { name, description };
      commands.set(name, registered);

      return {
        action(handler: (...args: unknown[]) => unknown) {
          registered.action = handler;
          return this;
        },
      };
    },
  };
}

function childThatCloses(code: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => child.emit('close', code));
  return child;
}

function childThatErrors(error: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => child.emit('error', error));
  return child;
}

function fakeGlobalRoots(roots: Partial<Record<'npm' | 'pnpm' | 'yarn', string>>): ExecFileSyncFn {
  return ((command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'npm root -g' && roots.npm) return roots.npm;
    if (key === 'pnpm root -g' && roots.pnpm) return roots.pnpm;
    if (key === 'yarn global dir' && roots.yarn) return roots.yarn;
    throw new Error(`unexpected command: ${key}`);
  }) as ExecFileSyncFn;
}

describe('detectPackageManager', () => {
  it('detects npm from the global root', () => {
    const detected = detectPackageManager({
      packageRoot: '/usr/local/lib/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({ npm: '/usr/local/lib/node_modules' }),
      env: {},
    });

    expect(detected?.manager).toBe('npm');
  });

  it('detects pnpm from pnpm global root or resolved .pnpm path', () => {
    expect(
      detectPackageManager({
        packageRoot: '/home/me/.local/share/pnpm/global/5/node_modules/@chiway/contextweaver',
        execFileSyncImpl: fakeGlobalRoots({
          pnpm: '/home/me/.local/share/pnpm/global/5/node_modules',
        }),
        env: {},
      })?.manager,
    ).toBe('pnpm');

    expect(
      detectPackageManager({
        packageRoot:
          '/home/me/.local/share/pnpm/global/5/.pnpm/@chiway+contextweaver@1.5.2/node_modules/@chiway/contextweaver',
        execFileSyncImpl: fakeGlobalRoots({}),
        env: {},
      })?.manager,
    ).toBe('pnpm');
  });

  it('detects yarn from yarn global directory', () => {
    const detected = detectPackageManager({
      packageRoot: '/home/me/.config/yarn/global/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({ yarn: '/home/me/.config/yarn/global' }),
      env: {},
    });

    expect(detected?.manager).toBe('yarn');
  });

  it('detects bun from BUN_INSTALL global directory', () => {
    const detected = detectPackageManager({
      packageRoot: '/home/me/.bun/install/global/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({}),
      env: { BUN_INSTALL: '/home/me/.bun' },
    });

    expect(detected?.manager).toBe('bun');
  });

  it('falls back to npm_config_user_agent when path detection is inconclusive', () => {
    const detected = detectPackageManager({
      packageRoot: '/opt/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({}),
      env: { npm_config_user_agent: 'pnpm/11.2.2 npm/? node/v22 linux x64' },
    });

    expect(detected?.manager).toBe('pnpm');
  });
});

describe('buildUpdateCommand', () => {
  it('builds package-manager-specific update commands', () => {
    expect(buildUpdateCommand('npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@chiway/contextweaver@latest'],
    });
    expect(buildUpdateCommand('pnpm')).toEqual({
      command: 'pnpm',
      args: ['add', '-g', '@chiway/contextweaver@latest'],
    });
    expect(buildUpdateCommand('yarn')).toEqual({
      command: 'yarn',
      args: ['global', 'add', '@chiway/contextweaver@latest'],
    });
    expect(buildUpdateCommand('bun')).toEqual({
      command: 'bun',
      args: ['add', '-g', '@chiway/contextweaver@latest'],
    });
  });
});

describe('runPackageManagerUpdate', () => {
  it('runs the detected package manager update command', async () => {
    const spawnImpl = vi.fn(() => childThatCloses(0)) as unknown as SpawnFn;

    const code = await runPackageManagerUpdate('pnpm', { spawnImpl });

    expect(code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', '@chiway/contextweaver@latest'],
      {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
  });

  it('returns package manager exit code when install fails', async () => {
    const spawnImpl = vi.fn(() => childThatCloses(7)) as unknown as SpawnFn;

    await expect(runPackageManagerUpdate('npm', { spawnImpl })).resolves.toBe(7);
  });
});

describe('registerUpdateCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers update command, detects install source, and reports success', async () => {
    const cli = createFakeCli();
    const spawnImpl = vi.fn(() => childThatCloses(0)) as unknown as SpawnFn;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    registerUpdateCommand(cli, {
      currentVersion: '1.5.2',
      packageRoot: '/home/me/.local/share/pnpm/global/5/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({
        pnpm: '/home/me/.local/share/pnpm/global/5/node_modules',
      }),
      env: {},
      spawnImpl,
    });

    expect(cli.commands.has('update')).toBe(true);
    const action = cli.commands.get('update')?.action;
    expect(action).toBeTypeOf('function');

    await action?.();

    expect(stdoutSpy).toHaveBeenCalledWith('当前版本: 1.5.2\n');
    expect(stdoutSpy).toHaveBeenCalledWith('检测到安装来源: pnpm\n');
    expect(stdoutSpy).toHaveBeenCalledWith(
      '正在通过 pnpm 升级 @chiway/contextweaver@latest...\n',
    );
    expect(stdoutSpy).toHaveBeenCalledWith('升级完成。\n');
    expect(spawnImpl).toHaveBeenCalledWith(
      'pnpm',
      ['add', '-g', '@chiway/contextweaver@latest'],
      expect.any(Object),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode when install source cannot be detected', async () => {
    const cli = createFakeCli();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    registerUpdateCommand(cli, {
      currentVersion: '1.5.2',
      packageRoot: '/opt/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({}),
      env: {},
    });

    await cli.commands.get('update')?.action?.();

    expect(stderrSpy).toHaveBeenCalledWith(
      '无法识别 ContextWeaver 的安装来源: /opt/contextweaver\n支持自动升级的包管理器: npm, pnpm, yarn, bun\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode when package manager exits with non-zero code', async () => {
    const cli = createFakeCli();
    const spawnImpl = vi.fn(() => childThatCloses(13)) as unknown as SpawnFn;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    registerUpdateCommand(cli, {
      currentVersion: '1.5.2',
      packageRoot: '/usr/local/lib/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({ npm: '/usr/local/lib/node_modules' }),
      env: {},
      spawnImpl,
    });

    await cli.commands.get('update')?.action?.();

    expect(stderrSpy).toHaveBeenCalledWith('升级失败，npm 退出码: 13\n');
    expect(process.exitCode).toBe(13);
  });

  it('sets exitCode when package manager cannot be started', async () => {
    const cli = createFakeCli();
    const spawnImpl = vi.fn(() => childThatErrors(new Error('spawn failed'))) as unknown as SpawnFn;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    registerUpdateCommand(cli, {
      currentVersion: '1.5.2',
      packageRoot: '/usr/local/lib/node_modules/@chiway/contextweaver',
      execFileSyncImpl: fakeGlobalRoots({ npm: '/usr/local/lib/node_modules' }),
      env: {},
      spawnImpl,
    });

    await cli.commands.get('update')?.action?.();

    expect(stderrSpy).toHaveBeenCalledWith('升级失败: spawn failed\n');
    expect(process.exitCode).toBe(1);
  });
});
