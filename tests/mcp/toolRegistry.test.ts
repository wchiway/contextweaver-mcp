import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDebugEnabled: () => false,
}));

describe('mcp tool registry', () => {
  it('exports get-symbol-definition from the tool index', async () => {
    const tools = await import('../../src/mcp/tools/index.js');

    expect(tools).toHaveProperty('getSymbolDefinitionSchema');
    expect(tools).toHaveProperty('handleGetSymbolDefinition');
  });

  it('registers get-symbol-definition in the MCP server tool list', async () => {
    const server = await import('../../src/mcp/server.js');

    expect(server).toHaveProperty('TOOLS');
    expect((server as { TOOLS: Array<{ name: string }> }).TOOLS.map((tool) => tool.name)).toContain(
      'get-symbol-definition',
    );
  });
});
