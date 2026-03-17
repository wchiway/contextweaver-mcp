import { describe, it, expect } from 'vitest';
import { scoreChunkTokenOverlap } from '../../src/search/utils.js';

describe('scoreChunkTokenOverlap', () => {
  it('returns 1 per exact word match', () => {
    const chunk = { breadcrumb: 'MyClass', display_code: 'function handleAuth() {}' };
    const score = scoreChunkTokenOverlap(chunk, new Set(['handleauth']));
    expect(score).toBe(1);
  });

  it('returns 0.5 for substring match (not a whole word)', () => {
    // "auth" appears inside "handleAuth" but not as a standalone word
    const chunk = { breadcrumb: '', display_code: 'handleAuth' };
    const score = scoreChunkTokenOverlap(chunk, new Set(['auth']));
    expect(score).toBe(0.5);
  });

  it('returns 0 when no token matches', () => {
    const chunk = { breadcrumb: 'Foo', display_code: 'bar baz' };
    const score = scoreChunkTokenOverlap(chunk, new Set(['xyz']));
    expect(score).toBe(0);
  });

  it('accumulates scores across multiple tokens', () => {
    const chunk = { breadcrumb: 'UserService', display_code: 'function login() { validate(); }' };
    // "login" = exact word match (1), "validate" = exact word match (1)
    const score = scoreChunkTokenOverlap(chunk, new Set(['login', 'validate']));
    expect(score).toBe(2);
  });

  it('is case insensitive', () => {
    const chunk = { breadcrumb: '', display_code: 'HandleAuth' };
    const score = scoreChunkTokenOverlap(chunk, new Set(['handleauth']));
    expect(score).toBe(1);
  });

  it('matches tokens in breadcrumb', () => {
    const chunk = { breadcrumb: 'AuthModule', display_code: '' };
    const score = scoreChunkTokenOverlap(chunk, new Set(['authmodule']));
    expect(score).toBe(1);
  });

  it('handles empty query tokens', () => {
    const chunk = { breadcrumb: 'Foo', display_code: 'bar' };
    const score = scoreChunkTokenOverlap(chunk, new Set());
    expect(score).toBe(0);
  });
});
