/**
 * Rust 原生分片器加载器
 *
 * 尝试加载 @chiway/contextweaver-chunker（napi 原生模块）。加载成功则索引流水线
 * 使用 Rust 单次解析路径（processFile）；失败（冷门平台无预构建二进制、或开发环境
 * 未构建）则返回 null，processor.ts 整体回退到现有 TS 实现。
 *
 * 加载顺序：
 * 1. 已发布的包名 @chiway/contextweaver-chunker（生产，optionalDependencies）
 * 2. 仓库内开发产物 crates/chunker/index.js（本地未发布时）
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export interface NativeSpan {
  start: number;
  end: number;
}

export interface NativeChunkMetadata {
  startIndex: number;
  endIndex: number;
  rawSpan: NativeSpan;
  vectorSpan: NativeSpan;
  filePath: string;
  language: string;
  contextPath: string[];
}

export interface NativeChunk {
  displayCode: string;
  vectorText: string;
  nwsSize: number;
  metadata: NativeChunkMetadata;
}

export interface NativeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface NativeCallSite {
  calleeName: string;
  line: number;
  qualifier?: string | null;
}

export interface NativeSplitterConfig {
  maxChunkSize?: number;
  minChunkSize?: number;
  chunkOverlap?: number;
  maxRawChars?: number;
}

export interface NativeFileResult {
  chunks: NativeChunk[];
  symbols: NativeSymbol[];
  callSites: NativeCallSite[];
  astOk: boolean;
}

export interface NativeChunker {
  processFile(
    code: string,
    filePath: string,
    language: string,
    config?: NativeSplitterConfig,
  ): NativeFileResult;
  splitPlainText(
    code: string,
    filePath: string,
    language: string,
    config?: NativeSplitterConfig,
  ): NativeChunk[];
  extractImports(kind: string, content: string): string[];
  decodeBytes(buffer: Buffer): { content: string; originalEncoding: string };
}

function tryLoad(): NativeChunker | null {
  // 1. 已发布包名
  try {
    return require('@chiway/contextweaver-chunker') as NativeChunker;
  } catch {
    // ignore, try dev path
  }

  // 2. 仓库内开发产物（src/ 或 dist/ 相对到 crates/chunker）
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../../crates/chunker/index.js'), // from src/scanner or dist/
      resolve(here, '../crates/chunker/index.js'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return require(candidate) as NativeChunker;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

let cached: NativeChunker | null | undefined;

/**
 * 返回已加载的 Rust 分片器；不可用时返回 null（调用方回退 TS）。
 */
export function getNativeChunker(): NativeChunker | null {
  if (cached === undefined) {
    cached = tryLoad();
    if (cached) {
      console.info('[NativeChunker] Rust chunker loaded — using native indexing path');
    } else {
      console.info('[NativeChunker] Rust chunker unavailable — using TypeScript fallback');
    }
  }
  return cached;
}
