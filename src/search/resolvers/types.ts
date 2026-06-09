/**
 * ImportResolver 接口定义
 * 用于解析不同语言的导入语句
 */

import { getNativeChunker } from '../../chunking/nativeChunker.js';

/** 导入解析器接口 */
export interface ImportResolver {
  /** 传给 Rust native extractImports 的语言标识 */
  readonly kind: string;
  /** 检查是否支持该文件 */
  supports(filePath: string): boolean;
  /** 提取导入语句中的路径/模块名 */
  extract(content: string): string[];
  /** 解析为具体文件路径 */
  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null;
}

/**
 * 优先用 Rust native extractImports 提取导入；native 不可用时回退到 TS 正则。
 * Rust 输出与 TS extract() 字节一致，下游 resolve() 不受影响。
 */
export function extractImportsNativeOrFallback(
  kind: string,
  content: string,
  fallback: () => string[],
): string[] {
  const native = getNativeChunker();
  if (native) return native.extractImports(kind, content);
  return fallback();
}

/**
 * 计算两个路径的公共前缀长度（按路径段计算）
 * 用于歧义消解时，优先选择与当前文件路径前缀重叠最多的
 */
export function commonPrefixLength(path1: string, path2: string): number {
  const parts1 = path1.split('/');
  const parts2 = path2.split('/');
  let count = 0;
  for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
    if (parts1[i] === parts2[i]) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
