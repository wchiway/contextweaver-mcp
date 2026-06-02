import crypto from 'node:crypto';
import { DEFAULT_CONFIG, SEARCH_CONFIG_BOUNDS } from './config.js';
import type { SearchConfig } from './types.js';

const SEARCH_ENV_MAP = {
  CW_SEARCH_WVEC: 'wVec',
  CW_SEARCH_WLEX: 'wLex',
  CW_SEARCH_RERANK_TOP_N: 'rerankTopN',
  CW_SEARCH_MAX_TOTAL_CHARS: 'maxTotalChars',
  CW_SEARCH_VECTOR_TOP_K: 'vectorTopK',
  CW_SEARCH_SMART_MAX_K: 'smartMaxK',
  CW_SEARCH_IMPORT_FILES_PER_SEED: 'importFilesPerSeed',
} as const satisfies Record<string, keyof SearchConfig>;

const SEARCH_FINGERPRINT_FIELDS = Object.keys(DEFAULT_CONFIG) as Array<keyof SearchConfig>;

function normalizeWeight(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clampValue(key: keyof SearchConfig, rawValue: string): number | undefined {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  const bounds = SEARCH_CONFIG_BOUNDS[key as keyof typeof SEARCH_CONFIG_BOUNDS];
  if (!bounds) {
    return parsed;
  }

  const clamped = Math.min(bounds.max, Math.max(bounds.min, parsed));
  return bounds.integer ? Math.round(clamped) : clamped;
}

export function getSearchConfigOverrides(): Partial<SearchConfig> {
  const overrides: Partial<SearchConfig> = {};
  const explicitWeights: Partial<Pick<SearchConfig, 'wVec' | 'wLex'>> = {};

  for (const [envKey, configKey] of Object.entries(SEARCH_ENV_MAP)) {
    const rawValue = process.env[envKey];
    if (rawValue === undefined || rawValue.trim() === '') {
      continue;
    }

    const parsed = clampValue(configKey, rawValue);
    if (parsed === undefined) {
      continue;
    }

    if (configKey === 'wVec' || configKey === 'wLex') {
      explicitWeights[configKey] = parsed;
      continue;
    }

    overrides[configKey] = parsed as never;
  }

  if (explicitWeights.wVec !== undefined && explicitWeights.wLex === undefined) {
    overrides.wVec = explicitWeights.wVec;
    overrides.wLex = normalizeWeight(1 - explicitWeights.wVec);
  } else if (explicitWeights.wLex !== undefined && explicitWeights.wVec === undefined) {
    overrides.wLex = explicitWeights.wLex;
    overrides.wVec = normalizeWeight(1 - explicitWeights.wLex);
  } else {
    if (explicitWeights.wVec !== undefined) {
      overrides.wVec = explicitWeights.wVec;
    }
    if (explicitWeights.wLex !== undefined) {
      overrides.wLex = explicitWeights.wLex;
    }
  }

  return overrides;
}

export function createSearchConfigFingerprint(config: SearchConfig): string {
  const payload = Object.fromEntries(
    SEARCH_FINGERPRINT_FIELDS.map((field) => [field, config[field]]),
  );
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
