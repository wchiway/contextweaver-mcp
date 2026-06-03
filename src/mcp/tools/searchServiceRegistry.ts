import crypto from 'node:crypto';
import type { SearchConfig } from '../../search/types.js';

type Initializable = { init: () => Promise<void> };

interface GetReusableSearchServiceInput<T extends Initializable> {
  projectId: string;
  repoPath: string;
  config: Partial<SearchConfig>;
  create: (projectId: string, repoPath: string, config: Partial<SearchConfig>) => T;
}

const services = new Map<string, Promise<Initializable>>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function stableFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function registryKey(projectId: string, config: Partial<SearchConfig>): string {
  return `${projectId}:${stableFingerprint(config)}`;
}

export async function getReusableSearchService<T extends Initializable>(
  input: GetReusableSearchServiceInput<T>,
): Promise<T> {
  const key = registryKey(input.projectId, input.config);
  let existing = services.get(key) as Promise<T> | undefined;
  if (!existing) {
    existing = (async () => {
      const service = input.create(input.projectId, input.repoPath, input.config);
      await service.init();
      return service;
    })();
    services.set(key, existing);
  }
  return existing;
}

export function clearSearchServiceRegistry(): void {
  services.clear();
}
