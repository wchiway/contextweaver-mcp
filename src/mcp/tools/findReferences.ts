import { z } from 'zod';
import { generateProjectId, initDb } from '../../db/index.js';
import { ChunkContentLoader } from '../../search/ChunkContentLoader.js';
import { searchChunksFts } from '../../search/fts.js';
import { logger } from '../../utils/logger.js';
import type { ChunkRecord } from '../../vectorStore/index.js';
import { getVectorStore } from '../../vectorStore/index.js';
import { ensureIndexed, formatTextResponse, type ProgressCallback } from './shared.js';

export const findReferencesSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  symbol: z.string().min(1).describe('The exact symbol name to search for.'),
  exclude_definition: z
    .boolean()
    .optional()
    .describe('Exclude chunks whose breadcrumb tail matches the symbol name.'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Maximum number of references to return. Defaults to 50.'),
});

export type FindReferencesInput = z.infer<typeof findReferencesSchema>;

interface FileContentRow {
  content: string | null;
}

interface ReferenceMatch {
  filePath: string;
  line: number;
  breadcrumb: string;
  snippet: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSymbolPattern(symbol: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegex(symbol)}(?![\\w$])`, 'u');
}

function breadcrumbTail(breadcrumb: string): string {
  const tail = breadcrumb.split('>').pop();
  return tail?.trim() ?? '';
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

function locateMatches(
  code: string,
  pattern: RegExp,
  baseLine: number,
): Array<{ line: number; snippet: string }> {
  return code.split('\n').flatMap((text, offset) =>
    pattern.test(text)
      ? [
          {
            line: baseLine + offset,
            snippet: text.trim(),
          },
        ]
      : [],
  );
}

export async function handleFindReferences(
  args: FindReferencesInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, symbol, exclude_definition = false, max_results = 50 } = args;
  const projectId = generateProjectId(repo_path);

  logger.info(
    { repo_path, symbol, exclude_definition, max_results },
    'MCP find-references 调用开始',
  );

  await ensureIndexed(repo_path, projectId, { onProgress });

  const db = initDb(projectId);
  try {
    const hits = searchChunksFts(db, symbol, Math.max(max_results * 2, 20));
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
    const pattern = buildSymbolPattern(symbol);
    const matches: ReferenceMatch[] = [];

    for (const hit of hits) {
      if (matches.length >= max_results) {
        break;
      }

      const chunk = chunkByKey.get(`${hit.filePath}#${hit.chunkIndex}`);
      if (!chunk) {
        continue;
      }
      if (exclude_definition && breadcrumbTail(chunk.breadcrumb) === symbol) {
        continue;
      }

      const sliceKey = ChunkContentLoader.key({
        filePath: chunk.file_path,
        start_index: chunk.start_index,
        end_index: chunk.end_index,
      });
      const code = codeMap.get(sliceKey) ?? '';
      if (!code) {
        continue;
      }

      let fullContent = fullFileCache.get(chunk.file_path);
      if (fullContent === undefined) {
        const row = fileContentStmt.get(chunk.file_path) as FileContentRow | undefined;
        fullContent = row?.content ?? '';
        fullFileCache.set(chunk.file_path, fullContent);
      }

      const baseLine = countLinesBefore(fullContent, chunk.start_index);
      for (const match of locateMatches(code, pattern, baseLine)) {
        matches.push({
          filePath: chunk.file_path,
          line: match.line,
          breadcrumb: chunk.breadcrumb,
          snippet: match.snippet,
        });
        if (matches.length >= max_results) {
          break;
        }
      }
    }

    const body =
      matches.length > 0
        ? matches
            .map(
              (match) =>
                `- ${match.filePath}:${match.line} | ${match.breadcrumb || '-'} | ${match.snippet}`,
            )
            .join('\n')
        : 'No exact text references found.';

    return formatTextResponse(`Found ${matches.length} text references for "${symbol}"\n\n${body}`);
  } finally {
    db.close();
  }
}
