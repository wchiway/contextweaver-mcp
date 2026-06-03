import { describe, expect, it } from 'vitest';
import { codebaseRetrievalSchema } from '../../src/mcp/tools/codebaseRetrieval.js';

describe('codebaseRetrievalSchema', () => {
  it('accepts legacy input', () => {
    const parsed = codebaseRetrievalSchema.parse({
      repo_path: '/repo',
      information_request: 'trace auth flow',
      technical_terms: ['AuthService'],
    });

    expect(parsed.mode).toBeUndefined();
    expect(parsed.output_format).toBeUndefined();
  });

  it('accepts search controls', () => {
    const parsed = codebaseRetrievalSchema.parse({
      repo_path: '/repo',
      information_request: 'trace auth flow',
      mode: 'deep',
      include_globs: ['src/**/*.ts'],
      exclude_globs: ['**/*.test.ts'],
      language: ['typescript'],
      max_total_chars: 24000,
      max_files: 8,
      max_segments_per_file: 2,
      return_debug: true,
    });

    expect(parsed.mode).toBe('deep');
    expect(parsed.include_globs).toEqual(['src/**/*.ts']);
    expect(parsed.max_total_chars).toBe(24000);
  });

  it('rejects invalid mode and unsafe budget values', () => {
    expect(() =>
      codebaseRetrievalSchema.parse({
        repo_path: '/repo',
        information_request: 'trace auth flow',
        mode: 'expensive',
      }),
    ).toThrow();

    expect(() =>
      codebaseRetrievalSchema.parse({
        repo_path: '/repo',
        information_request: 'trace auth flow',
        max_total_chars: 999999,
      }),
    ).toThrow();
  });
});
