import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_NAME = '@chiway/contextweaver';
const SUPPORTED_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

type PackageManager = (typeof SUPPORTED_MANAGERS)[number];

interface CommandBuilder {
  action<TArgs extends unknown[]>(handler: (...args: TArgs) => unknown): CommandBuilder;
}

interface CliLike {
  command(name: string, description: string): CommandBuilder;
}

interface SpawnOptions {
  stdio: 'inherit';
  shell: boolean;
}

interface ExecOptions {
  encoding: 'utf8';
  stdio: ['ignore', 'pipe', 'ignore'];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type ExecFileSyncFn = (command: string, args: string[], options: ExecOptions) => string;

export interface DetectPackageManagerOptions {
  packageRoot: string;
  execFileSyncImpl?: ExecFileSyncFn;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface DetectedPackageManager {
  manager: PackageManager;
  reason: string;
}

export interface RunUpdateOptions {
  spawnImpl?: SpawnFn;
  packageName?: string;
  tag?: string;
}

export interface RegisterUpdateCommandOptions
  extends RunUpdateOptions,
    DetectPackageManagerOptions {
  currentVersion: string;
}

interface GlobalRootCandidate {
  manager: PackageManager;
  root: string;
}

function defaultExecFileSync(command: string, args: string[], options: ExecOptions): string {
  return execFileSync(command, args, options).toString();
}

function commandOutput(
  execImpl: ExecFileSyncFn,
  command: string,
  args: string[],
): string | undefined {
  try {
    const output = execImpl(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(packageRoot: string, root: string): boolean {
  const normalizedPackageRoot = normalizePath(packageRoot);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedPackageRoot === normalizedRoot ||
    normalizedPackageRoot.startsWith(`${normalizedRoot}/`)
  );
}

function globalRootCandidates(options: DetectPackageManagerOptions): GlobalRootCandidate[] {
  const execImpl = options.execFileSyncImpl ?? defaultExecFileSync;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: GlobalRootCandidate[] = [];

  const npmRoot = commandOutput(execImpl, 'npm', ['root', '-g']);
  if (npmRoot) candidates.push({ manager: 'npm', root: npmRoot });

  const pnpmRoot = commandOutput(execImpl, 'pnpm', ['root', '-g']);
  if (pnpmRoot) candidates.push({ manager: 'pnpm', root: pnpmRoot });

  const yarnGlobalDir = commandOutput(execImpl, 'yarn', ['global', 'dir']);
  if (yarnGlobalDir)
    candidates.push({ manager: 'yarn', root: path.join(yarnGlobalDir, 'node_modules') });

  const bunInstall = options.env?.BUN_INSTALL ?? path.join(homeDir, '.bun');
  candidates.push({
    manager: 'bun',
    root: path.join(bunInstall, 'install', 'global', 'node_modules'),
  });

  return candidates;
}

function detectFromPath(packageRoot: string): DetectedPackageManager | undefined {
  const normalized = normalizePath(packageRoot);

  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/global/')) {
    return { manager: 'pnpm', reason: 'matched pnpm global install path' };
  }
  if (normalized.includes('/.bun/install/global/')) {
    return { manager: 'bun', reason: 'matched bun global install path' };
  }
  if (normalized.includes('/.config/yarn/global/') || normalized.includes('/yarn/global/')) {
    return { manager: 'yarn', reason: 'matched yarn global install path' };
  }

  return undefined;
}

function detectFromUserAgent(userAgent: string | undefined): DetectedPackageManager | undefined {
  const normalized = userAgent?.toLowerCase() ?? '';
  const manager = SUPPORTED_MANAGERS.find((name) => normalized.startsWith(`${name}/`));
  return manager ? { manager, reason: 'matched npm_config_user_agent' } : undefined;
}

export function detectPackageManager(
  options: DetectPackageManagerOptions,
): DetectedPackageManager | undefined {
  const rootMatch = globalRootCandidates(options).find((candidate) =>
    isWithinRoot(options.packageRoot, candidate.root),
  );
  if (rootMatch) {
    return {
      manager: rootMatch.manager,
      reason: `matched ${rootMatch.manager} global root: ${rootMatch.root}`,
    };
  }

  return (
    detectFromPath(options.packageRoot) ?? detectFromUserAgent(options.env?.npm_config_user_agent)
  );
}

export function buildUpdateCommand(
  manager: PackageManager,
  packageName = PACKAGE_NAME,
  tag = 'latest',
): { command: string; args: string[] } {
  const packageRef = `${packageName}@${tag}`;

  switch (manager) {
    case 'npm':
      return { command: 'npm', args: ['install', '-g', packageRef] };
    case 'pnpm':
      return { command: 'pnpm', args: ['add', '-g', packageRef] };
    case 'yarn':
      return { command: 'yarn', args: ['global', 'add', packageRef] };
    case 'bun':
      return { command: 'bun', args: ['add', '-g', packageRef] };
  }
}

export function runPackageManagerUpdate(
  manager: PackageManager,
  options: RunUpdateOptions = {},
): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const updateCommand = buildUpdateCommand(manager, options.packageName, options.tag);

  return new Promise((resolve, reject) => {
    const child = spawnImpl(updateCommand.command, updateCommand.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

export function registerUpdateCommand(cli: CliLike, options: RegisterUpdateCommandOptions): void {
  cli.command('update', '自动检测安装来源并升级 ContextWeaver').action(async () => {
    const packageName = options.packageName ?? PACKAGE_NAME;
    const detected = detectPackageManager(options);

    process.stdout.write(`当前版本: ${options.currentVersion}\n`);

    if (!detected) {
      process.stderr.write(
        `无法识别 ContextWeaver 的安装来源: ${options.packageRoot}\n支持自动升级的包管理器: ${SUPPORTED_MANAGERS.join(', ')}\n`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`检测到安装来源: ${detected.manager}\n`);
    process.stdout.write(`正在通过 ${detected.manager} 升级 ${packageName}@latest...\n`);

    let exitCode: number;
    try {
      exitCode = await runPackageManagerUpdate(detected.manager, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`升级失败: ${message}\n`);
      process.exitCode = 1;
      return;
    }

    if (exitCode !== 0) {
      process.stderr.write(`升级失败，${detected.manager} 退出码: ${exitCode}\n`);
      process.exitCode = exitCode;
      return;
    }

    process.stdout.write('升级完成。\n');
  });
}
