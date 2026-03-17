/**
 * 搜索模块共享工具函数
 *
 * 从 SearchService 和 GraphExpander 中提取的公共逻辑
 */

// ===========================================
// 性能优化：Token 边界 RegExp 缓存
// ===========================================

/** 缓存预编译的 token 边界正则表达式 */
const tokenBoundaryRegexCache = new Map<string, RegExp>();

/**
 * 获取或创建 token 边界正则表达式（带缓存）
 *
 * 避免每次 scoreChunkTokenOverlap 调用都创建 N 个 RegExp 对象
 */
function getTokenBoundaryRegex(token: string): RegExp {
  let regex = tokenBoundaryRegexCache.get(token);
  if (!regex) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`);
    tokenBoundaryRegexCache.set(token, regex);
  }
  return regex;
}

/**
 * 计算 chunk 与查询的 token overlap 得分
 *
 * 匹配策略：
 * - breadcrumb 和 display_code 都参与匹配
 * - 精确匹配得 1 分，子串匹配得 0.5 分
 */
export function scoreChunkTokenOverlap(
  chunk: { breadcrumb: string; display_code: string },
  queryTokens: Set<string>,
): number {
  const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    // 性能优化：先用 includes 快速判断，再用预编译的 RegExp 判断边界
    if (text.includes(token)) {
      // 精确匹配（作为完整单词）得更高分
      const regex = getTokenBoundaryRegex(token);
      if (regex.test(text)) {
        score += 1;
      } else {
        score += 0.5; // 子串匹配
      }
    }
  }

  return score;
}
