import { describe, expect, it } from 'vitest';
import { buildQueryVariants } from '../../src/search/QueryPlanner.js';

describe('buildQueryVariants', () => {
  it('returns one query when rewrite is disabled', () => {
    expect(
      buildQueryVariants({
        semanticQuery: 'trace token refresh and retry behavior',
        technicalTerms: ['AuthService'],
        enabled: false,
      }),
    ).toEqual(['trace token refresh and retry behavior']);
  });

  it('creates bounded deterministic variants when rewrite is enabled', () => {
    const variants = buildQueryVariants({
      semanticQuery: 'trace token refresh and retry behavior',
      technicalTerms: ['AuthService', 'refreshToken'],
      enabled: true,
    });

    expect(variants[0]).toBe('trace token refresh and retry behavior');
    expect(variants.length).toBeLessThanOrEqual(4);
    expect(variants).toContain('AuthService refreshToken trace token refresh and retry behavior');
  });
});
