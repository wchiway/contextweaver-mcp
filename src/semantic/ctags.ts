import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SemanticSymbol } from './types.js';

const execFileAsync = promisify(execFile);

interface CtagsJsonLine {
  _type?: string;
  name?: string;
  path?: string;
  line?: number;
  end?: number;
  kind?: string;
  kindName?: string;
  scope?: string;
}

export async function extractCtagsSymbols(options: {
  absPath: string;
  relPath: string;
  hash: string;
  language: string;
}): Promise<SemanticSymbol[]> {
  const { absPath, relPath, hash, language } = options;

  try {
    const { stdout } = await execFileAsync(
      'ctags',
      ['--output-format=json', '--fields=+neK', '-f', '-', absPath],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
    );

    return stdout
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        let tag: CtagsJsonLine;
        try {
          tag = JSON.parse(line) as CtagsJsonLine;
        } catch {
          return [];
        }

        if (tag._type !== 'tag' || !tag.name || !tag.line) return [];

        return [
          {
            path: relPath,
            hash,
            language,
            name: tag.name,
            kind: tag.kindName ?? tag.kind ?? 'symbol',
            source: 'ctags' as const,
            startLine: tag.line,
            endLine: tag.end ?? null,
            containerName: tag.scope ?? null,
          },
        ];
      });
  } catch {
    return [];
  }
}
