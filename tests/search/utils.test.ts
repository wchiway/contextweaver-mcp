import { describe, expect, it } from 'vitest';
import { scoreChunkTokenOverlap } from '../../src/search/utils.js';

describe('scoreChunkTokenOverlap', () => {
  it('returns 1 per exact word match', () => {
    const score = scoreChunkTokenOverlap(
      { breadcrumb: 'MyClass' },
      'function handleAuth() {}',
      new Set(['handleauth']),
    );
    expect(score).toBe(1);
  });

  it('returns 0.5 for substring match (not a whole word)', () => {
    // "auth" appears inside "handleAuth" but not as a standalone word
    const score = scoreChunkTokenOverlap(
      { breadcrumb: '' },
      'handleAuth',
      new Set(['auth']),
    );
    expect(score).toBe(0.5);
  });

  it('returns 0 when no token matches', () => {
    const score = scoreChunkTokenOverlap(
      { breadcrumb: 'Foo' },
      'bar baz',
      new Set(['xyz']),
    );
    expect(score).toBe(0);
  });

  it('accumulates scores across multiple tokens', () => {
    // "login" = exact word match (1), "validate" = exact word match (1)
    const score = scoreChunkTokenOverlap(
      { breadcrumb: 'UserService' },
      'function login() { validate(); }',
      new Set(['login', 'validate']),
    );
    expect(score).toBe(2);
  });

  it('is case insensitive', () => {
    const score = scoreChunkTokenOverlap(
      { breadcrumb: '' },
      'HandleAuth',
      new Set(['handleauth']),
    );
    expect(score).toBe(1);
  });

  it('matches tokens in breadcrumb', () => {
    const score = scoreChunkTokenOverlap(
      { breadcrumb: 'AuthModule' },
      '',
      new Set(['authmodule']),
    );
    expect(score).toBe(1);
  });

  it('handles empty query tokens', () => {
    const score = scoreChunkTokenOverlap({ breadcrumb: 'Foo' }, 'bar', new Set());
    expect(score).toBe(0);
  });
});
