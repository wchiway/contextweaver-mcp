import { z } from 'zod';
import { generateProjectId, initDb } from '../../db/index.js';
import { logger } from '../../utils/logger.js';
import { ensureIndexed, formatTextResponse, type ProgressCallback } from './shared.js';

export const listFilesSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
  glob: z.string().optional().describe('Optional glob pattern to filter returned file paths.'),
  language: z
    .string()
    .optional()
    .describe('Optional language filter matched against files.language.'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe('Maximum number of files to return. Defaults to 200.'),
});

export type ListFilesInput = z.infer<typeof listFilesSchema>;

interface FileRow {
  path: string;
  language: string;
  size: number;
}

function escapeRegexCharacter(char: string): string {
  return char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '^';

  for (let i = 0; i < normalized.length; ) {
    if (normalized.slice(i, i + 3) === '**/') {
      pattern += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (normalized.slice(i, i + 2) === '**') {
      pattern += '.*';
      i += 2;
      continue;
    }

    const char = normalized[i];
    if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegexCharacter(char);
    }
    i += 1;
  }

  return new RegExp(`${pattern}$`);
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size}B`;
  }

  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)}KB`;
  }

  return `${(kb / 1024).toFixed(1)}MB`;
}

export async function handleListFiles(
  args: ListFilesInput,
  onProgress?: ProgressCallback,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { repo_path, glob, language, max_results = 200 } = args;
  const projectId = generateProjectId(repo_path);

  logger.info({ repo_path, glob, language, max_results }, 'MCP list-files 调用开始');

  await ensureIndexed(repo_path, projectId, { onProgress, vectorIndex: false });

  const db = initDb(projectId);
  try {
    const rows = (
      language
        ? db
            .prepare('SELECT path, language, size FROM files WHERE language = ? ORDER BY path')
            .all(language)
        : db.prepare('SELECT path, language, size FROM files ORDER BY path').all()
    ) as FileRow[];

    const matcher = glob ? globToRegExp(glob) : null;
    const filtered = matcher ? rows.filter((row) => matcher.test(row.path)) : rows;
    const limited = filtered.slice(0, max_results);

    const body =
      limited.length > 0
        ? limited
            .map((row) => `- ${row.path} (${row.language}, ${formatSize(row.size)})`)
            .join('\n')
        : 'No files matched the requested filters.';

    return formatTextResponse(`Found ${limited.length} files\n\n${body}`);
  } finally {
    db.close();
  }
}
