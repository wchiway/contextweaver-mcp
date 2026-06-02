import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    // 排除 git worktree：.worktrees/ 下含未完成功能分支的测试，不应纳入主仓库测试集
    exclude: ['**/node_modules/**', '**/dist/**', '.worktrees/**'],
  },
});
