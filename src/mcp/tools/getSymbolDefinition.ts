import { z } from 'zod';
import { generateProjectId, initDb } from '../../db/index.js';
import { ChunkContentLoader } from '../../search/ChunkContentLoader.js';
import { searchChunksFts } from '../../search/fts.js';
import { commonPrefixLength } from '../../search/resolvers/types.js';
import { logger } from '../../utils/logger.js';
import type { ChunkRecord } from '../../vectorStore/index.js';
import { getVectorStore } from '../../vectorStore/index.js';
import { ensureIndexed, formatTextResponse, type ProgressCallback } from './shared.js';

export const getSymbolDefinitionSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  symbol: z.string().min(1).describe('The exact symbol name to resolve.'),
  hint_path: z
    .string()
    .optional()
    .describe('Optional preferred path used to disambiguate same-name definitions.'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Maximum number of definitions to return. Defaults to 3.'),
});

export type GetSymbolDefinitionInput = z.infer<typeof getSymbolDefinitionSchema>;

interface FileContentRow {
  content: string | null;
}

interface DefinitionCandidate {
  chunk: ChunkRecord;
  code: string;
  score: number;
  breadcrumbExact: boolean;
  prefixScore: number;
  startLine: number;
  endLine: number;
}

const LANGUAGE_DEFINITION_PATTERNS: Record<string, string[]> = {
  typescript: [
    'function\\s+{symbol}\\b',
    'class\\s+{symbol}\\b',
    '(?:const|let|var)\\s+{symbol}\\b',
    'interface\\s+{symbol}\\b',
    'type\\s+{symbol}\\b',
    'enum\\s+{symbol}\\b',
  ],
  javascript: [
    'function\\s+{symbol}\\b',
    'class\\s+{symbol}\\b',
    '(?:const|let|var)\\s+{symbol}\\b',
  ],
  python: ['def\\s+{symbol}\\b', 'class\\s+{symbol}\\b'],
  go: ['func\\s+{symbol}\\b', 'type\\s+{symbol}\\b', 'const\\s+{symbol}\\b', 'var\\s+{symbol}\\b'],
  rust: [
    'fn\\s+{symbol}\\b',
    'struct\\s+{symbol}\\b',
    'enum\\s+{symbol}\\b',
    'const\\s+{symbol}\\b',
  ],
  java: [
    'class\\s+{symbol}\\b',
    'interface\\s+{symbol}\\b',
    'enum\\s+{symbol}\\b',
    '\\b{symbol}\\s*\\(',
  ],
  csharp: [
    'class\\s+{symbol}\\b',
    'interface\\s+{symbol}\\b',
    'enum\\s+{symbol}\\b',
    '\\b{symbol}\\s*\\(',
  ],
  cpp: ['class\\s+{symbol}\\b', 'struct\\s+{symbol}\\b', '\\b{symbol}\\s*\\('],
  c: ['\\b{symbol}\\s*\\('],
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function breadcrumbTail(breadcrumb: string): string {
  return breadcrumb.split('>').pop()?.trim() ?? '';
}

function countLinesBefore(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

function computeEndLine(startLine: number, code: string): number {
  const normalized = code.replace(/\n+$/u, '');
  if (!normalized) {
    return startLine;
  }
  return startLine + normalized.split('\n').length - 1;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    md: 'markdown',
    json: 'json',
  };
  return langMap[ext] || ext || 'plaintext';
}

function formatDefinition(candidate: DefinitionCandidate): string {
  const header = `## ${candidate.chunk.file_path} (L${candidate.startLine}-L${candidate.endLine})`;
  const breadcrumb = candidate.chunk.breadcrumb ? `> ${candidate.chunk.breadcrumb}` : '';
  const code = `\`\`\`${detectLanguage(candidate.chunk.file_path)}\n${candidate.code}\n\`\`\``;
  return [header, breadcrumb, code].filter(Boolean).join('\n');
}

function hasDefinitionPattern(language: string, code: string, symbol: string): boolean {
  const patterns =
    LANGUAGE_DEFINITION_PATTERNS[language] ?? LANGUAGE_DEFINITION_PATTERNS.typescript;
  return patterns.some((pattern) => {
    const source = pattern.replaceAll('{symbol}', escapeRegex(symbol));
    return new RegExp(source, 'u').test(code);
  });
}

function rankCandidates(a: DefinitionCandidate, b: DefinitionCandidate): number {
  if (a.breadcrumbExact !== b.breadcrumbExact) {
    return a.breadcrumbExact ? -1 : 1;
  }
  if (a.prefixScore !== b.prefixScore) {
    return b.prefixScore - a.prefixScore;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.chunk.file_path.localeCompare(b.chunk.file_path);
}

export async function handleGetSymbolDefinition(
  args: GetSymbolDefinitionInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, symbol, hint_path, max_results = 3 } = args;
  const projectId = generateProjectId(repo_path);

  logger.info({ repo_path, symbol, hint_path, max_results }, 'MCP get-symbol-definition 调用开始');

  await ensureIndexed(repo_path, projectId, { onProgress });

  const db = initDb(projectId);
  try {
    const hits = searchChunksFts(db, symbol, Math.max(max_results * 5, 20));
    const uniquePaths = Array.from(new Set(hits.map((hit) => hit.filePath)));
    const vectorStore = await getVectorStore(projectId);
    const chunkMap = await vectorStore.getFilesChunks(uniquePaths);
    const chunkByKey = new Map<string, ChunkRecord>();

    for (const [filePath, chunks] of chunkMap) {
      for (const chunk of chunks) {
        chunkByKey.set(`${filePath}#${chunk.chunk_index}`, chunk);
      }
    }

    const slices = Array.from(chunkByKey.values()).map((chunk) => ({
      filePath: chunk.file_path,
      start_index: chunk.start_index,
      end_index: chunk.end_index,
    }));
    const loader = new ChunkContentLoader(db);
    const codeMap = loader.loadMany(slices);
    const fileContentStmt = db.prepare('SELECT content FROM files WHERE path = ?');
    const fullFileCache = new Map<string, string>();
    const candidates = new Map<string, DefinitionCandidate>();

    for (const hit of hits) {
      const chunk = chunkByKey.get(`${hit.filePath}#${hit.chunkIndex}`);
      if (!chunk) {
        continue;
      }

      const codeKey = ChunkContentLoader.key({
        filePath: chunk.file_path,
        start_index: chunk.start_index,
        end_index: chunk.end_index,
      });
      const code = codeMap.get(codeKey) ?? '';
      if (!code) {
        continue;
      }

      const breadcrumbExact = breadcrumbTail(chunk.breadcrumb) === symbol;
      const definitionPattern = hasDefinitionPattern(chunk.language, code, symbol);
      if (!breadcrumbExact && !definitionPattern) {
        continue;
      }

      let fullContent = fullFileCache.get(chunk.file_path);
      if (fullContent === undefined) {
        const row = fileContentStmt.get(chunk.file_path) as FileContentRow | undefined;
        fullContent = row?.content ?? '';
        fullFileCache.set(chunk.file_path, fullContent);
      }

      const startLine = countLinesBefore(fullContent, chunk.start_index);
      const candidate: DefinitionCandidate = {
        chunk,
        code,
        score: hit.score,
        breadcrumbExact,
        prefixScore: hint_path ? commonPrefixLength(hint_path, chunk.file_path) : 0,
        startLine,
        endLine: computeEndLine(startLine, code),
      };

      const key = `${chunk.file_path}#${chunk.chunk_index}`;
      const existing = candidates.get(key);
      if (!existing || rankCandidates(candidate, existing) < 0) {
        candidates.set(key, candidate);
      }
    }

    const ranked = Array.from(candidates.values()).sort(rankCandidates).slice(0, max_results);
    const body =
      ranked.length > 0
        ? ranked.map((candidate) => formatDefinition(candidate)).join('\n\n---\n\n')
        : 'No likely symbol definitions found.';

    return formatTextResponse(
      `Found ${ranked.length} symbol definitions for "${symbol}"\n\n${body}`,
    );
  } finally {
    db.close();
  }
}
