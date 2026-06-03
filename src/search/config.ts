/**
 * 搜索模块默认配置
 */

import type { SearchConfig } from './types.js';

export const SEARCH_CONFIG_BOUNDS = {
  vectorTopK: { min: 40, max: 200, integer: true },
  vectorTopM: { min: 30, max: 100, integer: true },
  ftsTopKFiles: { min: 10, max: 50, integer: true },
  lexChunksPerFile: { min: 1, max: 5, integer: true },
  lexTotalChunks: { min: 20, max: 80, integer: true },
  rrfK0: { min: 10, max: 60, integer: true },
  wVec: { min: 0, max: 1, integer: false },
  wLex: { min: 0, max: 1, integer: false },
  fusedTopM: { min: 30, max: 100, integer: true },
  rerankTopN: { min: 5, max: 20, integer: true },
  maxRerankChars: { min: 500, max: 2000, integer: true },
  maxBreadcrumbChars: { min: 100, max: 500, integer: true },
  headRatio: { min: 0.5, max: 0.8, integer: false },
  neighborHops: { min: 1, max: 3, integer: true },
  breadcrumbExpandLimit: { min: 1, max: 5, integer: true },
  importFilesPerSeed: { min: 0, max: 5, integer: true },
  chunksPerImportFile: { min: 1, max: 5, integer: true },
  reverseImportFilesPerSeed: { min: 0, max: 5, integer: true },
  callsiteChunksPerSeed: { min: 0, max: 5, integer: true },
  decayNeighbor: { min: 0.5, max: 0.9, integer: false },
  decayBreadcrumb: { min: 0.4, max: 0.8, integer: false },
  decayImport: { min: 0.3, max: 0.7, integer: false },
  decayReverseImport: { min: 0.3, max: 0.7, integer: false },
  decayCallsite: { min: 0.3, max: 0.7, integer: false },
  decayDepth: { min: 0.5, max: 0.9, integer: false },
  maxSegmentsPerFile: { min: 1, max: 5, integer: true },
  maxTotalChars: { min: 20000, max: 80000, integer: true },
  smartTopScoreRatio: { min: 0.3, max: 0.7, integer: false },
  smartTopScoreDeltaAbs: { min: 0.1, max: 0.4, integer: false },
  smartMinScore: { min: 0.1, max: 0.4, integer: false },
  smartMinK: { min: 1, max: 3, integer: true },
  smartMaxK: { min: 5, max: 15, integer: true },
} satisfies Partial<Record<keyof SearchConfig, { min: number; max: number; integer: boolean }>>;

export const DEFAULT_CONFIG: SearchConfig = {
  // ── Recall (向量 + 词法召回) ──
  vectorTopK: 80, // Vector ANN candidates before dedup. Range: 40–200. Higher = better recall, more compute.
  vectorTopM: 60, // Vectors kept after dedup. Range: 30–100.
  ftsTopKFiles: 20, // Max files returned by FTS5 full-text search. Range: 10–50.
  lexChunksPerFile: 2, // Chunks to pull per FTS-matched file. Range: 1–5. Low keeps diversity across files.
  lexTotalChunks: 40, // Hard cap on total lexical chunks. Range: 20–80.

  // ── RRF Fusion (向量 + 词法分数融合) ──
  rrfK0: 20, // RRF smoothing constant. Range: 10–60. Lower amplifies top ranks.
  wVec: 0.6, // Vector weight in fused score. Range: 0.3–0.8. Semantic relevance emphasis.
  wLex: 0.4, // Lexical weight in fused score. wVec + wLex should equal 1.0.
  fusedTopM: 60, // Candidates after fusion, fed into reranker. Range: 30–100.

  // ── Rerank (精排) ──
  rerankTopN: 10, // Final top-N results after reranking. Range: 5–20.
  maxRerankChars: 1000, // Max chars per chunk sent to reranker. Truncated beyond this. Range: 500–2000.
  maxBreadcrumbChars: 250, // Max chars for breadcrumb context in rerank input. Range: 100–500.
  headRatio: 0.67, // Ratio of head vs tail when truncating chunks. Range: 0.5–0.8.

  // ── Expansion (上下文扩展: E1 邻居 / E2 面包屑 / E3 跨文件导入) ──
  neighborHops: 2, // E1: How many sibling chunks to expand in each direction. Range: 1–3.
  breadcrumbExpandLimit: 3, // E2: Max ancestor breadcrumbs (class/function scope). Range: 1–5.
  importFilesPerSeed: 3, // E3: Cross-file import files to resolve per seed chunk. Range: 0–5. Set to 3 to enable import-graph expansion for better cross-file context.
  chunksPerImportFile: 3, // E3: Chunks to pull from each resolved import file. Range: 1–5. Set to 3 for balanced coverage of imported symbols.
  reverseImportFilesPerSeed: 2, // E4: Files importing a seed file. Range: 0–5. Bounded reverse dependency context.
  callsiteChunksPerSeed: 2, // E5: Chunks matching likely call-sites for seed symbols. Range: 0–5.
  decayNeighbor: 0.8, // Score decay per E1 hop. Range: 0.5–0.9. Higher = neighbors stay relevant longer.
  decayBreadcrumb: 0.7, // Score decay per E2 level. Range: 0.4–0.8.
  decayImport: 0.6, // Score decay for E3 import chunks. Range: 0.3–0.7. Lower than E1/E2 since cross-file is less certain.
  decayReverseImport: 0.5, // Score decay for reverse-import chunks. Range: 0.3–0.7.
  decayCallsite: 0.5, // Score decay for call-site chunks. Range: 0.3–0.7.
  decayDepth: 0.7, // General depth decay multiplier. Range: 0.5–0.9.

  // ── ContextPacker (上下文打包) ──
  maxSegmentsPerFile: 3, // Max non-contiguous segments per file in output. Range: 1–5. Prevents excessive fragmentation.
  maxTotalChars: 48000, // Token budget expressed as chars (~12k tokens). Range: 20000–80000.

  // ── Smart TopK (动态结果数量) ──
  enableSmartTopK: true, // Dynamically adjust result count based on score distribution.
  smartTopScoreRatio: 0.5, // Min score as ratio of top-1 score to remain included. Range: 0.3–0.7.
  smartTopScoreDeltaAbs: 0.25, // Max absolute score drop from top-1 before cutting off. Range: 0.1–0.4.
  smartMinScore: 0.25, // Hard floor: chunks below this score are always excluded. Range: 0.1–0.4.
  smartMinK: 2, // Minimum results to return regardless of scores. Range: 1–3.
  smartMaxK: 8, // Maximum results when smart topK is active. Range: 5–15.
};
