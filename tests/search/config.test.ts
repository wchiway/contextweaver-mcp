import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/search/config.js';

describe('DEFAULT_CONFIG', () => {
  it('has positive vector recall settings', () => {
    expect(DEFAULT_CONFIG.vectorTopK).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.vectorTopM).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.vectorTopM).toBeLessThanOrEqual(DEFAULT_CONFIG.vectorTopK);
  });

  it('has RRF weights that sum to 1', () => {
    expect(DEFAULT_CONFIG.wVec + DEFAULT_CONFIG.wLex).toBeCloseTo(1.0);
  });

  it('has wVec >= wLex (vector search is primary)', () => {
    expect(DEFAULT_CONFIG.wVec).toBeGreaterThanOrEqual(DEFAULT_CONFIG.wLex);
  });

  it('has valid rerank settings', () => {
    expect(DEFAULT_CONFIG.rerankTopN).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.rerankTopN).toBeLessThanOrEqual(DEFAULT_CONFIG.fusedTopM);
    expect(DEFAULT_CONFIG.headRatio).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.headRatio).toBeLessThan(1);
  });

  it('has decay factors in (0, 1] range', () => {
    for (const key of ['decayNeighbor', 'decayBreadcrumb', 'decayImport', 'decayDepth'] as const) {
      expect(DEFAULT_CONFIG[key]).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG[key]).toBeLessThanOrEqual(1);
    }
  });

  it('has positive ContextPacker limits', () => {
    expect(DEFAULT_CONFIG.maxSegmentsPerFile).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.maxTotalChars).toBeGreaterThan(0);
  });

  it('has valid smart topK settings', () => {
    expect(DEFAULT_CONFIG.smartMinK).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.smartMaxK).toBeGreaterThan(DEFAULT_CONFIG.smartMinK);
    expect(DEFAULT_CONFIG.smartTopScoreRatio).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.smartTopScoreRatio).toBeLessThanOrEqual(1);
    expect(DEFAULT_CONFIG.smartMinScore).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.smartMinScore).toBeLessThanOrEqual(1);
  });
});
