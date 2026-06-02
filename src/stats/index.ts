/**
 * 统计聚合层
 *
 * 组合三类统计：
 * - 索引过程：最近一次 ScanStats 快照 + 累计运行数
 * - 搜索质量/行为：累计查询数、缓存命中率、各阶段平均耗时、平均召回数
 * - 健康/一致性：库规模、语言占比、跨库对齐诊断
 */

import { getEmbeddingConfig } from '../config.js';
import {
  closeDb,
  collectHealthSnapshot,
  getAllStats,
  getStatJson,
  type HealthSnapshot,
  initDb,
} from '../db/index.js';
import type { ScanStats } from '../scanner/index.js';
import { logger } from '../utils/logger.js';
import { getVectorStore } from '../vectorStore/index.js';

export interface IndexStatsSection {
  totalRuns: number;
  lastRun: ScanStats | null;
  lastRunAt: number | null;
}

export interface SearchStatsSection {
  totalQueries: number;
  cacheHits: number;
  cacheHitRate: number | null;
  computeRuns: number;
  avgRetrieveMs: number | null;
  avgRerankMs: number | null;
  avgExpandMs: number | null;
  avgPackMs: number | null;
  avgSeedCount: number | null;
}

export interface StatsReport {
  projectId: string;
  health: HealthSnapshot;
  lancedbRows: number;
  index: IndexStatsSection;
  search: SearchStatsSection;
  /** 一致性诊断告警（空数组表示健康） */
  diagnostics: string[];
}

function num(stats: Record<string, string>, key: string): number {
  const v = stats[key];
  if (v === undefined) return 0;
  const parsed = Number.parseInt(v, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 计算均值，分母为 0 返回 null */
function avg(sum: number, count: number): number | null {
  if (count <= 0) return null;
  return sum / count;
}

/**
 * 聚合统计报告（实时只读 + 累计计数器）
 */
export async function collectStats(projectId: string): Promise<StatsReport> {
  const db = initDb(projectId);
  try {
    const health = collectHealthSnapshot(db);
    const stats = getAllStats(db);

    // LanceDB 行数（实时）
    let lancedbRows = 0;
    try {
      const store = await getVectorStore(projectId, getEmbeddingConfig().dimensions);
      lancedbRows = await store.count();
    } catch (err) {
      logger.warn({ error: (err as { message?: string }).message }, '读取 LanceDB 行数失败');
    }

    const computeRuns = num(stats, 'stats.search.compute_runs');
    const totalQueries = num(stats, 'stats.search.total_queries');
    const cacheHits = num(stats, 'stats.search.cache_hits');

    const index: IndexStatsSection = {
      totalRuns: num(stats, 'stats.index.total_runs'),
      lastRun: getStatJson<ScanStats>(db, 'stats.index.last_run_json'),
      lastRunAt: getStatJson<number>(db, 'stats.index.last_run_at'),
    };

    const search: SearchStatsSection = {
      totalQueries,
      cacheHits,
      cacheHitRate: totalQueries > 0 ? cacheHits / totalQueries : null,
      computeRuns,
      avgRetrieveMs: avg(num(stats, 'stats.search.sum_retrieve_ms'), computeRuns),
      avgRerankMs: avg(num(stats, 'stats.search.sum_rerank_ms'), computeRuns),
      avgExpandMs: avg(num(stats, 'stats.search.sum_expand_ms'), computeRuns),
      avgPackMs: avg(num(stats, 'stats.search.sum_pack_ms'), computeRuns),
      avgSeedCount: avg(num(stats, 'stats.search.sum_seed_count'), computeRuns),
    };

    const diagnostics = buildDiagnostics(health, lancedbRows);

    return { projectId, health, lancedbRows, index, search, diagnostics };
  } finally {
    closeDb(db);
  }
}

/**
 * 跨库一致性诊断
 */
function buildDiagnostics(health: HealthSnapshot, lancedbRows: number): string[] {
  const out: string[] = [];
  if (health.migrationState === 'aborted') {
    out.push(
      'LanceDB 迁移状态为 aborted，索引写入被拒绝。运行 `contextweaver migrate --reset` 解除。',
    );
  }
  if (health.migrationState === 'pending') {
    out.push('LanceDB 迁移状态为 pending，可能上次迁移未完成。');
  }
  if (health.pendingMarks > 0) {
    out.push(`pending_marks 积压 ${health.pendingMarks} 条，下次启动将重放。若持续不减需排查。`);
  }
  if (health.totalFiles > 0 && lancedbRows === 0) {
    out.push(
      `已索引 ${health.totalFiles} 个文件但 LanceDB 无向量行，向量索引可能未建立。运行 \`contextweaver index\` 重建。`,
    );
  }
  if (health.embeddingDimensions === null && health.totalFiles > 0) {
    out.push('未记录 embedding 维度，索引元数据可能不完整。');
  }
  return out;
}

/**
 * 渲染人类可读的统计文本报告
 */
export function renderStatsText(report: StatsReport): string {
  const fmt = (v: number | null, suffix = ''): string =>
    v === null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`;
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const bytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const lines: string[] = [];
  lines.push(`ContextWeaver 统计  (projectId: ${report.projectId})`);
  lines.push('');

  // 索引过程
  const ix = report.index;
  lines.push('【索引过程】');
  lines.push(`  累计索引运行: ${ix.totalRuns} 次`);
  if (ix.lastRunAt) {
    lines.push(`  上次索引时间: ${new Date(ix.lastRunAt).toLocaleString()}`);
  }
  if (ix.lastRun) {
    const r = ix.lastRun;
    lines.push(
      `  上次结果: 总数=${r.totalFiles} 新增=${r.added} 修改=${r.modified} 未变=${r.unchanged} 删除=${r.deleted} 跳过=${r.skipped} 错误=${r.errors}`,
    );
    if (r.vectorIndex) {
      lines.push(
        `  向量索引: 已索引=${r.vectorIndex.indexed} 删除=${r.vectorIndex.deleted} 错误=${r.vectorIndex.errors}`,
      );
    }
  } else {
    lines.push('  上次结果: 暂无（尚未索引）');
  }
  lines.push('');

  // 搜索质量/行为
  const s = report.search;
  lines.push('【搜索质量/行为】');
  lines.push(
    `  累计查询: ${s.totalQueries} 次  (缓存命中 ${s.cacheHits}，命中率 ${pct(s.cacheHitRate)})`,
  );
  lines.push(`  实际计算: ${s.computeRuns} 次（未命中缓存，作为下列均值分母）`);
  lines.push(
    `  平均耗时: retrieve=${fmt(s.avgRetrieveMs, 'ms')} rerank=${fmt(s.avgRerankMs, 'ms')} expand=${fmt(s.avgExpandMs, 'ms')} pack=${fmt(s.avgPackMs, 'ms')}`,
  );
  lines.push(`  平均召回: ${fmt(s.avgSeedCount)} 个 seed`);
  lines.push('');

  // 健康/一致性
  const h = report.health;
  lines.push('【健康/一致性】');
  lines.push(`  文件: ${h.totalFiles} 个，正文总量 ${bytes(h.totalBytes)}`);
  lines.push(`  LanceDB 向量行: ${report.lancedbRows}`);
  lines.push(
    `  embedding 维度: ${h.embeddingDimensions ?? '—'}  索引版本: ${h.indexVersion}  迁移状态: ${h.migrationState ?? '未设置'}  pending_marks: ${h.pendingMarks}`,
  );
  const langs = Object.entries(h.byLanguage).sort((a, b) => b[1] - a[1]);
  if (langs.length > 0) {
    const langStr = langs.map(([lang, c]) => `${lang}=${c}`).join('  ');
    lines.push(`  语言占比: ${langStr}`);
  }
  lines.push('');

  // 诊断
  if (report.diagnostics.length > 0) {
    lines.push('【诊断告警】');
    for (const d of report.diagnostics) lines.push(`  ⚠ ${d}`);
  } else {
    lines.push('【诊断】无异常');
  }

  return lines.join('\n');
}
