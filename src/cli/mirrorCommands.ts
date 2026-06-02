import path from 'node:path';

interface CommandBuilder {
  option(optionText: string, description: string): CommandBuilder;
  action<TArgs extends unknown[]>(handler: (...args: TArgs) => unknown): CommandBuilder;
}

interface CliLike {
  command(name: string, description: string): CommandBuilder;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function writeResponse(response: {
  content: Array<{ type: 'text'; text: string }>;
}): Promise<void> {
  const text = response.content.map((item) => item.text).join('\n');
  process.stdout.write(`${text}\n`);
}

export function registerMirrorCommands(cli: CliLike): void {
  cli
    .command('list-files [path]', '列出已索引文件结构（镜像 MCP list-files）')
    .option('--glob <pattern>', '路径 glob 过滤')
    .option('--language <language>', '语言过滤')
    .option('--max-results <n>', '最多返回数量')
    .action(
      async (
        targetPath: string | undefined,
        options: {
          glob?: string;
          language?: string;
          maxResults?: string;
        },
      ) => {
        const repoPath = targetPath ? path.resolve(targetPath) : process.cwd();
        const { handleListFiles } = await import('../mcp/tools/listFiles.js');
        const response = await handleListFiles({
          repo_path: repoPath,
          glob: options.glob,
          language: options.language,
          max_results: parseOptionalPositiveInt(options.maxResults),
        });

        await writeResponse(response);
      },
    );

  cli
    .command('definition <symbol>', '查看符号定义（镜像 MCP get-symbol-definition）')
    .option('-p, --path <path>', '项目路径（默认当前目录）')
    .option('--hint-path <path>', '用于同名定义消歧的偏好路径')
    .option('--max-results <n>', '最多返回数量')
    .action(
      async (
        symbol: string,
        options: {
          path?: string;
          hintPath?: string;
          maxResults?: string;
        },
      ) => {
        const repoPath = options.path ? path.resolve(options.path) : process.cwd();
        const { handleGetSymbolDefinition } = await import('../mcp/tools/getSymbolDefinition.js');
        const response = await handleGetSymbolDefinition({
          repo_path: repoPath,
          symbol,
          hint_path: options.hintPath,
          max_results: parseOptionalPositiveInt(options.maxResults),
        });

        await writeResponse(response);
      },
    );

  cli
    .command('references <symbol>', '查看符号引用（镜像 MCP find-references）')
    .option('-p, --path <path>', '项目路径（默认当前目录）')
    .option('--exclude-definition', '排除定义本身')
    .option('--max-results <n>', '最多返回数量')
    .action(
      async (
        symbol: string,
        options: {
          path?: string;
          excludeDefinition?: boolean;
          maxResults?: string;
        },
      ) => {
        const repoPath = options.path ? path.resolve(options.path) : process.cwd();
        const { handleFindReferences } = await import('../mcp/tools/findReferences.js');
        const response = await handleFindReferences({
          repo_path: repoPath,
          symbol,
          exclude_definition: options.excludeDefinition,
          max_results: parseOptionalPositiveInt(options.maxResults),
        });

        await writeResponse(response);
      },
    );
}
