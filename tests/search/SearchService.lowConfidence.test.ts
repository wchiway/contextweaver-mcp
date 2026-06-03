import { describe, expect, it } from 'vitest';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';

function chunk(score: number, index: number): ScoredChunk {
  return {
    filePath: 'src/a.ts',
    chunkIndex: index,
    score,
    source: 'vector',
    record: {
      chunk_id: `src/a.ts#h#${index}`,
      file_path: 'src/a.ts',
      file_hash: 'h',
      chunk_index: index,
      vector: [],
      language: 'typescript',
      breadcrumb: 'src/a.ts',
      start_index: 0,
      end_index: 1,
      raw_start: 0,
      raw_end: 1,
      vec_start: 0,
      vec_end: 1,
      _distance: 0,
    },
  };
}

describe('SearchService low confidence handling', () => {
  it('returns empty when configured', () => {
    const service = new SearchService('project-low', '/repo', {
      smartMinScore: 0.4,
      lowConfidenceBehavior: 'return_empty',
    } as any);

    const result = (service as any).applySmartCutoffForTest([chunk(0.2, 0)]);
    expect(result.seeds).toEqual([]);
    expect(result.lowConfidence).toBe(true);
  });

  it('returns top1 with warning when configured', () => {
    const service = new SearchService('project-low', '/repo', {
      smartMinScore: 0.4,
      lowConfidenceBehavior: 'return_with_warning',
    } as any);

    const result = (service as any).applySmartCutoffForTest([chunk(0.2, 0)]);
    expect(result.seeds).toHaveLength(1);
    expect(result.warnings[0]).toContain('Low confidence');
  });
});
