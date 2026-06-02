import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scan: vi.fn().mockResolvedValue({
    totalFiles: 1,
    added: 1,
    modified: 0,
    deleted: 0,
    vectorIndex: undefined,
  }),
  withLock: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => state.existsSync(...args),
    mkdirSync: (...args: unknown[]) => state.mkdirSync(...args),
    writeFileSync: (...args: unknown[]) => state.writeFileSync(...args),
  },
}));

vi.mock('../../src/utils/lock.js', () => ({
  withLock: (...args: unknown[]) => state.withLock(...args),
}));

vi.mock('../../src/scanner/index.js', () => ({
  scan: (...args: unknown[]) => state.scan(...args),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  isDebugEnabled: () => false,
}));

describe('mcp shared helpers', () => {
  beforeEach(() => {
    state.scan.mockClear();
    state.withLock.mockReset();
    state.withLock.mockImplementation(async (_projectId, _name, fn) => await fn());
    state.existsSync.mockReset();
    state.existsSync.mockReturnValue(false);
    state.mkdirSync.mockClear();
    state.writeFileSync.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes vectorIndex=false through ensureIndexed for SQLite-only tools', async () => {
    const { ensureIndexed } = await import('../../src/mcp/tools/shared.js');

    await ensureIndexed('/repo', 'project-test', { vectorIndex: false });

    expect(state.scan).toHaveBeenCalledWith('/repo', {
      onProgress: undefined,
      vectorIndex: false,
    });
  });

  it('creates the default env file and formats a user-facing response', async () => {
    const { checkEnvOrRespond } = await import('../../src/mcp/tools/shared.js');

    const response = await checkEnvOrRespond(['EMBEDDINGS_API_KEY']);

    expect(state.mkdirSync).toHaveBeenCalled();
    expect(state.writeFileSync).toHaveBeenCalled();
    expect(response?.content[0]?.text).toContain('EMBEDDINGS_API_KEY');
  });
});
