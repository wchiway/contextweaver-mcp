/**
 * 搜索模块默认配置
 */

import type { SearchConfig } from './types.js';

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
  decayNeighbor: 0.8, // Score decay per E1 hop. Range: 0.5–0.9. Higher = neighbors stay relevant longer.
  decayBreadcrumb: 0.7, // Score decay per E2 level. Range: 0.4–0.8.
  decayImport: 0.6, // Score decay for E3 import chunks. Range: 0.3–0.7. Lower than E1/E2 since cross-file is less certain.
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
