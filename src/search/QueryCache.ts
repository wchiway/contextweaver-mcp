import crypto from 'node:crypto';
import type { ContextPack } from './types.js';

const MAX_CACHE_ENTRIES = 50;

class LruCache<K, V> {
  private entries = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, value);

    if (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }
}

const projectCaches = new Map<string, LruCache<string, ContextPack>>();

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getProjectCache(projectId: string): LruCache<string, ContextPack> {
  let cache = projectCaches.get(projectId);
  if (!cache) {
    cache = new LruCache<string, ContextPack>(MAX_CACHE_ENTRIES);
    projectCaches.set(projectId, cache);
  }
  return cache;
}

export function buildQueryCacheKey(input: {
  query: string;
  projectId: string;
  indexVersion: number;
  configFingerprint: string;
}): string {
  const normalizedQuery = normalizeQuery(input.query);
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        query: normalizedQuery,
        projectId: input.projectId,
        indexVersion: input.indexVersion,
        configFingerprint: input.configFingerprint,
      }),
    )
    .digest('hex');
}

export function getCachedContextPack(
  projectId: string,
  key: string,
): ContextPack | undefined {
  return getProjectCache(projectId).get(key);
}

export function setCachedContextPack(
  projectId: string,
  key: string,
  pack: ContextPack,
): void {
  getProjectCache(projectId).set(key, pack);
}

