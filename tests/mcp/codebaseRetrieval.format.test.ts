import { describe, expect, it } from 'vitest';
import { formatCodebaseRetrievalResponse } from '../../src/mcp/tools/codebaseRetrieval.js';
import type { ContextPack } from '../../src/search/types.js';

function pack(): ContextPack {
  return {
    query: 'trace search',
    seeds: [],
    expanded: [],
    files: [
      {
        filePath: 'src/search/SearchService.ts',
        segments: [
          {
            filePath: 'src/search/SearchService.ts',
            rawStart: 0,
            rawEnd: 20,
            startLine: 1,
            endLine: 3,
            score: 0.92,
            breadcrumb: 'src/search/SearchService.ts > class SearchService',
            text: 'export class SearchService {}',
          },
        ],
      },
    ],
    debug: {
      wVec: 0.6,
      wLex: 0.4,
      timingMs: { retrieve: 10, rerank: 20, expand: 5, pack: 2 },
    },
  };
}

describe('formatCodebaseRetrievalResponse', () => {
  it('returns markdown by default', () => {
    const response = formatCodebaseRetrievalResponse(pack(), {});
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.text).toContain('Found 0 relevant code blocks');
    expect(response.content[0]?.text).toContain('```typescript');
  });

  it('returns json metadata when requested', () => {
    const response = formatCodebaseRetrievalResponse(pack(), {
      outputFormat: 'json',
      returnDebug: true,
    });

    const parsed = JSON.parse(response.content[0]?.text ?? '');
    expect(parsed.files[0]?.path).toBe('src/search/SearchService.ts');
    expect(parsed.files[0]?.segments[0]?.score).toBe(0.92);
    expect(parsed.debug.timingMs.retrieve).toBe(10);
  });

  it('returns markdown and json when requested', () => {
    const response = formatCodebaseRetrievalResponse(pack(), {
      outputFormat: 'both',
      returnDebug: true,
    });

    expect(response.content).toHaveLength(2);
    expect(response.content[0]?.text).toContain('Found 0 relevant code blocks');
    expect(JSON.parse(response.content[1]?.text ?? '').files).toHaveLength(1);
  });
});
