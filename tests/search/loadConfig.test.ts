import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import {
  createSearchConfigFingerprint,
  getSearchConfigOverrides,
} from '../../src/search/loadConfig.js';
import { getDefaultEnvFileContent } from '../../src/defaultEnv.js';

describe('getSearchConfigOverrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty overrides when no CW_SEARCH variables are set', () => {
    expect(getSearchConfigOverrides()).toEqual({});
  });

  it('parses supported numeric overrides', () => {
    vi.stubEnv('CW_SEARCH_VECTOR_TOP_K', '120');
    vi.stubEnv('CW_SEARCH_RERANK_TOP_N', '12');
    vi.stubEnv('CW_SEARCH_MAX_TOTAL_CHARS', '60000');

    expect(getSearchConfigOverrides()).toEqual({
      vectorTopK: 120,
      rerankTopN: 12,
      maxTotalChars: 60000,
    });
  });

  it('clamps out-of-range values to supported bounds', () => {
    vi.stubEnv('CW_SEARCH_VECTOR_TOP_K', '999');
    vi.stubEnv('CW_SEARCH_IMPORT_FILES_PER_SEED', '-10');
    vi.stubEnv('CW_SEARCH_SMART_MAX_K', '99');

    expect(getSearchConfigOverrides()).toEqual({
      vectorTopK: 200,
      importFilesPerSeed: 0,
      smartMaxK: 15,
    });
  });

  it('falls back to defaults for invalid numeric values', () => {
    vi.stubEnv('CW_SEARCH_VECTOR_TOP_K', 'not-a-number');
    vi.stubEnv('CW_SEARCH_RERANK_TOP_N', '');

    expect(getSearchConfigOverrides()).toEqual({});
  });

  it('derives wLex when only wVec is configured', () => {
    vi.stubEnv('CW_SEARCH_WVEC', '0.7');

    expect(getSearchConfigOverrides()).toEqual({
      wVec: 0.7,
      wLex: 0.3,
    });
  });

  it('derives wVec when only wLex is configured', () => {
    vi.stubEnv('CW_SEARCH_WLEX', '0.35');

    expect(getSearchConfigOverrides()).toEqual({
      wVec: 0.65,
      wLex: 0.35,
    });
  });

  it('keeps both weights when both are explicitly configured', () => {
    vi.stubEnv('CW_SEARCH_WVEC', '0.55');
    vi.stubEnv('CW_SEARCH_WLEX', '0.45');

    expect(getSearchConfigOverrides()).toEqual({
      wVec: 0.55,
      wLex: 0.45,
    });
  });
});

describe('createSearchConfigFingerprint', () => {
  it('changes when supported search settings change', () => {
    const base = createSearchConfigFingerprint(DEFAULT_CONFIG);
    const changed = createSearchConfigFingerprint({
      ...DEFAULT_CONFIG,
      rerankTopN: DEFAULT_CONFIG.rerankTopN + 1,
    });

    expect(changed).not.toBe(base);
  });

  it('ignores unrelated keys outside the search config surface', () => {
    const base = createSearchConfigFingerprint(DEFAULT_CONFIG);
    const changed = createSearchConfigFingerprint({
      ...DEFAULT_CONFIG,
      extra: 'ignored',
    } as typeof DEFAULT_CONFIG & { extra: string });

    expect(changed).toBe(base);
  });
});

describe('getDefaultEnvFileContent', () => {
  it('documents configurable search variables with defaults', () => {
    const content = getDefaultEnvFileContent();

    expect(content).toContain('CW_SEARCH_WVEC=' + DEFAULT_CONFIG.wVec);
    expect(content).toContain('CW_SEARCH_WLEX=' + DEFAULT_CONFIG.wLex);
    expect(content).toContain('CW_SEARCH_RERANK_TOP_N=' + DEFAULT_CONFIG.rerankTopN);
    expect(content).toContain('CW_SEARCH_MAX_TOTAL_CHARS=' + DEFAULT_CONFIG.maxTotalChars);
    expect(content).toContain('CW_SEARCH_VECTOR_TOP_K=' + DEFAULT_CONFIG.vectorTopK);
    expect(content).toContain('CW_SEARCH_SMART_MAX_K=' + DEFAULT_CONFIG.smartMaxK);
    expect(content).toContain(
      'CW_SEARCH_IMPORT_FILES_PER_SEED=' + DEFAULT_CONFIG.importFilesPerSeed,
    );
  });
});
