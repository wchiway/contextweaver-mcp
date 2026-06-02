/**
 * stats MCP Tool
 *
 * 输出索引/搜索/健康三类统计，与 `contextweaver stats` CLI 同源。
 */

import path from 'node:path';
import { z } from 'zod';
import { generateProjectId } from '../../db/index.js';
import { collectStats, renderStatsText } from '../../stats/index.js';

export const statsToolSchema = z.object({
  repo_path: z
    .string()
    .describe(
      "The absolute file system path to the repository root. (e.g., '/Users/dev/my-project')",
    ),
});

export type StatsToolInput = z.infer<typeof statsToolSchema>;

export async function handleStats(
  args: StatsToolInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const rootPath = path.resolve(args.repo_path);
  const projectId = generateProjectId(rootPath);
  const report = await collectStats(projectId);
  return {
    content: [{ type: 'text', text: renderStatsText(report) }],
  };
}
