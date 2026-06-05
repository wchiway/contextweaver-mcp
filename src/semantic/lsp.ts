import type Database from 'better-sqlite3';
import { replaceSemanticEdges } from '../db/index.js';
import { logger } from '../utils/logger.js';
import type { SemanticEdge } from './types.js';

export interface LspEnrichmentOptions {
  rootPath: string;
  db: Database.Database;
  files: Array<{ path: string; hash: string; language: string }>;
}

export function isLspEnrichmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXTWEAVER_LSP_ENRICHMENT === '1';
}

export async function runOptionalLspEnrichment(options: LspEnrichmentOptions): Promise<void> {
  if (!isLspEnrichmentEnabled()) return;

  try {
    const edges = await collectLspEdges(options);
    replaceSemanticEdges(
      options.db,
      options.files.map((file) => file.path),
      edges,
    );
  } catch (err) {
    logger.warn({ error: (err as { message?: string }).message }, 'LSP enrichment skipped');
  }
}

async function collectLspEdges(_options: LspEnrichmentOptions): Promise<SemanticEdge[]> {
  return [];
}
