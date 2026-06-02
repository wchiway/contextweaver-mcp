import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handleListFiles: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'list output' }] }),
  handleGetSymbolDefinition: vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: 'definition output' }] }),
  handleFindReferences: vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: 'references output' }] }),
}));

vi.mock('../../src/mcp/tools/listFiles.js', () => ({
  handleListFiles: (...args: unknown[]) => state.handleListFiles(...args),
}));

vi.mock('../../src/mcp/tools/getSymbolDefinition.js', () => ({
  handleGetSymbolDefinition: (...args: unknown[]) => state.handleGetSymbolDefinition(...args),
}));

vi.mock('../../src/mcp/tools/findReferences.js', () => ({
  handleFindReferences: (...args: unknown[]) => state.handleFindReferences(...args),
}));

interface RegisteredCommand {
  name: string;
  description: string;
  options: string[];
  action?: (...args: unknown[]) => unknown;
}

function createFakeCli() {
  const commands = new Map<string, RegisteredCommand>();

  return {
    commands,
    command(name: string, description: string) {
      const registered: RegisteredCommand = {
        name,
        description,
        options: [],
      };
      commands.set(name, registered);

      return {
        option(optionText: string) {
          registered.options.push(optionText);
          return this;
        },
        action(handler: (...args: unknown[]) => unknown) {
          registered.action = handler;
          return this;
        },
      };
    },
  };
}

describe('registerMirrorCommands', () => {
  beforeEach(() => {
    state.handleListFiles.mockClear();
    state.handleGetSymbolDefinition.mockClear();
    state.handleFindReferences.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers list-files, definition, and references commands', async () => {
    const { registerMirrorCommands } = await import('../../src/cli/mirrorCommands.js');
    const cli = createFakeCli();

    registerMirrorCommands(cli);

    expect(cli.commands.has('list-files [path]')).toBe(true);
    expect(cli.commands.has('definition <symbol>')).toBe(true);
    expect(cli.commands.has('references <symbol>')).toBe(true);
  });

  it('forwards list-files options to the MCP handler and prints the response', async () => {
    const { registerMirrorCommands } = await import('../../src/cli/mirrorCommands.js');
    const cli = createFakeCli();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    registerMirrorCommands(cli);

    const action = cli.commands.get('list-files [path]')?.action;
    expect(action).toBeTypeOf('function');

    await action?.('/repo', {
      glob: 'src/**/*.ts',
      language: 'typescript',
      maxResults: '5',
    });

    expect(state.handleListFiles).toHaveBeenCalledWith({
      repo_path: '/repo',
      glob: 'src/**/*.ts',
      language: 'typescript',
      max_results: 5,
    });
    expect(writeSpy).toHaveBeenCalledWith('list output\n');
  });

  it('forwards definition options including hint_path and default cwd', async () => {
    const { registerMirrorCommands } = await import('../../src/cli/mirrorCommands.js');
    const cli = createFakeCli();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'cwd').mockReturnValue('/cwd');

    registerMirrorCommands(cli);

    const action = cli.commands.get('definition <symbol>')?.action;
    expect(action).toBeTypeOf('function');

    await action?.('createClient', {
      hintPath: 'src/features/auth/login.ts',
      maxResults: '2',
    });

    expect(state.handleGetSymbolDefinition).toHaveBeenCalledWith({
      repo_path: '/cwd',
      symbol: 'createClient',
      hint_path: 'src/features/auth/login.ts',
      max_results: 2,
    });
  });

  it('forwards references options including exclude_definition', async () => {
    const { registerMirrorCommands } = await import('../../src/cli/mirrorCommands.js');
    const cli = createFakeCli();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    registerMirrorCommands(cli);

    const action = cli.commands.get('references <symbol>')?.action;
    expect(action).toBeTypeOf('function');

    await action?.('login', {
      path: '/repo',
      excludeDefinition: true,
      maxResults: '8',
    });

    expect(state.handleFindReferences).toHaveBeenCalledWith({
      repo_path: '/repo',
      symbol: 'login',
      exclude_definition: true,
      max_results: 8,
    });
  });
});
