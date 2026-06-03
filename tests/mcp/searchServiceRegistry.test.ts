import { describe, expect, it } from 'vitest';
import {
  clearSearchServiceRegistry,
  getReusableSearchService,
} from '../../src/mcp/tools/searchServiceRegistry.js';

class FakeService {
  static initCalls = 0;

  constructor(
    public projectId: string,
    public repoPath: string,
    public config: unknown,
  ) {}

  async init() {
    FakeService.initCalls += 1;
  }
}

describe('searchServiceRegistry', () => {
  it('reuses service for same project and config fingerprint', async () => {
    clearSearchServiceRegistry();
    FakeService.initCalls = 0;

    const first = await getReusableSearchService({
      projectId: 'project-a',
      repoPath: '/repo',
      config: { rerankTopN: 10 },
      create: (projectId, repoPath, config) => new FakeService(projectId, repoPath, config),
    });
    const second = await getReusableSearchService({
      projectId: 'project-a',
      repoPath: '/repo',
      config: { rerankTopN: 10 },
      create: (projectId, repoPath, config) => new FakeService(projectId, repoPath, config),
    });

    expect(first).toBe(second);
    expect(FakeService.initCalls).toBe(1);
  });

  it('creates a new service when config changes', async () => {
    clearSearchServiceRegistry();

    const first = await getReusableSearchService({
      projectId: 'project-a',
      repoPath: '/repo',
      config: { rerankTopN: 10 },
      create: (projectId, repoPath, config) => new FakeService(projectId, repoPath, config),
    });
    const second = await getReusableSearchService({
      projectId: 'project-a',
      repoPath: '/repo',
      config: { rerankTopN: 11 },
      create: (projectId, repoPath, config) => new FakeService(projectId, repoPath, config),
    });

    expect(first).not.toBe(second);
  });
});
