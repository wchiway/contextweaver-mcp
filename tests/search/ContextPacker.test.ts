import { describe, it, expect } from 'vitest';
import { ContextPacker } from '../../src/search/ContextPacker.js';
import type { ScoredChunk, SearchConfig } from '../../src/search/types.js';
import { DEFAULT_CONFIG } from '../../src/search/config.js';

/**
 * ContextPacker.mergeAndSlice is private, so we test interval merging
 * indirectly by calling pack() with a minimal mock DB.
 */

/** Build a minimal ScoredChunk for testing */
function makeChunk(
  filePath: string,
  rawStart: number,
  rawEnd: number,
  score: number,
  chunkIndex = 0,
): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source: 'vector',
    record: {
      id: `${filePath}:${chunkIndex}`,
      file_path: filePath,
      chunk_index: chunkIndex,
      breadcrumb: 'test',
      display_code: 'test code',
      raw_start: rawStart,
      raw_end: rawEnd,
      _distance: 0,
    },
  } as ScoredChunk;
}

/** Create a minimal mock DB that returns file content */
function mockDb(files: Record<string, string>) {
  return {
    prepare: () => ({
      all: (...paths: string[]) => {
        return paths
          .filter((p) => files[p] !== undefined)
          .map((p) => ({ path: p, content: files[p] }));
      },
    }),
  } as any;
}

describe('ContextPacker', () => {
  const config: SearchConfig = { ...DEFAULT_CONFIG, maxSegmentsPerFile: 10, maxTotalChars: 100000 };

  describe('interval merging via pack()', () => {
    it('merges overlapping intervals', async () => {
      const content = 'a'.repeat(100);
      const packer = new ContextPacker('proj', config);
      const chunks = [
        makeChunk('file.ts', 0, 50, 0.9, 0),
        makeChunk('file.ts', 30, 80, 0.8, 1),
      ];
      const db = mockDb({ 'file.ts': content });

      const result = await packer.pack(chunks, db);

      expect(result).toHaveLength(1);
      expect(result[0].segments).toHaveLength(1);
      // Merged interval: [0, 80)
      expect(result[0].segments[0].rawStart).toBe(0);
      expect(result[0].segments[0].rawEnd).toBe(80);
    });

    it('merges adjacent intervals (touching boundary)', async () => {
      const content = 'b'.repeat(100);
      const packer = new ContextPacker('proj', config);
      const chunks = [
        makeChunk('file.ts', 0, 50, 0.9, 0),
        makeChunk('file.ts', 50, 100, 0.8, 1),
      ];
      const db = mockDb({ 'file.ts': content });

      const result = await packer.pack(chunks, db);

      expect(result).toHaveLength(1);
      // start <= last.end (50 <= 50) triggers merge
      expect(result[0].segments).toHaveLength(1);
      expect(result[0].segments[0].rawStart).toBe(0);
      expect(result[0].segments[0].rawEnd).toBe(100);
    });

    it('keeps non-overlapping intervals separate', async () => {
      const content = 'c'.repeat(200);
      const packer = new ContextPacker('proj', config);
      const chunks = [
        makeChunk('file.ts', 0, 40, 0.9, 0),
        makeChunk('file.ts', 100, 150, 0.8, 1),
      ];
      const db = mockDb({ 'file.ts': content });

      const result = await packer.pack(chunks, db);

      expect(result).toHaveLength(1);
      expect(result[0].segments).toHaveLength(2);
      expect(result[0].segments[0].rawStart).toBe(0);
      expect(result[0].segments[0].rawEnd).toBe(40);
      expect(result[0].segments[1].rawStart).toBe(100);
      expect(result[0].segments[1].rawEnd).toBe(150);
    });

    it('returns empty for empty input', async () => {
      const packer = new ContextPacker('proj', config);
      const db = mockDb({});

      const result = await packer.pack([], db);

      expect(result).toEqual([]);
    });
  });

  describe('budget enforcement', () => {
    it('truncates when total chars exceed maxTotalChars', async () => {
      const smallBudgetConfig = { ...config, maxTotalChars: 30 };
      const content = 'x'.repeat(200);
      const packer = new ContextPacker('proj', smallBudgetConfig);
      const chunks = [
        makeChunk('file.ts', 0, 20, 0.9, 0),   // 20 chars
        makeChunk('file.ts', 100, 130, 0.8, 1),  // 30 chars — would exceed budget
      ];
      const db = mockDb({ 'file.ts': content });

      const result = await packer.pack(chunks, db);

      expect(result).toHaveLength(1);
      // Only first segment fits in the 30-char budget
      expect(result[0].segments).toHaveLength(1);
      expect(result[0].segments[0].rawStart).toBe(0);
    });
  });

  describe('multi-file grouping', () => {
    it('groups chunks by file and sorts by max score', async () => {
      const packer = new ContextPacker('proj', config);
      const chunks = [
        makeChunk('low.ts', 0, 10, 0.3, 0),
        makeChunk('high.ts', 0, 10, 0.9, 0),
      ];
      const db = mockDb({ 'low.ts': 'a'.repeat(20), 'high.ts': 'b'.repeat(20) });

      const result = await packer.pack(chunks, db);

      expect(result).toHaveLength(2);
      // Higher-scored file first
      expect(result[0].filePath).toBe('high.ts');
      expect(result[1].filePath).toBe('low.ts');
    });
  });
});
