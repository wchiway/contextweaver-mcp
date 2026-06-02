import { DEFAULT_CONFIG } from './search/config.js';

export function getDefaultEnvFileContent(): string {
  return `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20

# 搜索参数（可选，覆盖内置默认值）
CW_SEARCH_WVEC=${DEFAULT_CONFIG.wVec}
CW_SEARCH_WLEX=${DEFAULT_CONFIG.wLex}
CW_SEARCH_RERANK_TOP_N=${DEFAULT_CONFIG.rerankTopN}
CW_SEARCH_MAX_TOTAL_CHARS=${DEFAULT_CONFIG.maxTotalChars}
CW_SEARCH_VECTOR_TOP_K=${DEFAULT_CONFIG.vectorTopK}
CW_SEARCH_SMART_MAX_K=${DEFAULT_CONFIG.smartMaxK}
CW_SEARCH_IMPORT_FILES_PER_SEED=${DEFAULT_CONFIG.importFilesPerSeed}

# 索引忽略模式（可选，逗号分隔，默认已包含常见忽略项）
# IGNORE_PATTERNS=.venv,node_modules
`;
}
