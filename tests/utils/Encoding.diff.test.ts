/**
 * TS ↔ Rust 编码解码差分对拍（P2 decodeBytes 一致性锁）
 *
 * 对多编码 fixtures 构造原始字节 buffer，断言 Rust native decodeBytes 的
 * content 与 TS chardet/iconv 解码路径输出一致。
 *
 * 选样原则（见 docs/plans/rust-migration-plan.md §3.3/§6）：
 * - BOM 前缀样本：检测是权威的，两侧必然一致。
 * - 无 BOM 的 CJK 多字节样本：取足够长的文本，使 chardet 与 chardetng 检测稳定收敛。
 * - 不测短/歧义的单字节样本：单字节编码（latin1/win1252 等）在短 buffer 上检测器
 *   可能分歧，方案明确允许 originalEncoding 差异；此处只锁 content 一致的稳定样本。
 *
 * 前置：需先构建 napi 模块。.node 缺失则整个 describe 跳过。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nativeEntry = path.resolve(here, '../../crates/chunker/index.js');
const hasNative = existsSync(nativeEntry);

type DecodeBytes = (buffer: Buffer) => { content: string; originalEncoding: string };
const rustDecode: DecodeBytes | null = hasNative
  ? (require(nativeEntry).decodeBytes as DecodeBytes)
  : null;

// ── TS 基线：与 src/utils/encoding.ts decodeBytesTs 源码逐字一致 ──

function detectBOM(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'UTF-8';
  }
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
      return 'UTF-32 LE';
    }
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
      return 'UTF-32 BE';
    }
  }
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'UTF-16 LE';
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'UTF-16 BE';
  }
  return null;
}

function normalizeEncoding(encoding: string): string {
  const map: Record<string, string> = {
    'UTF-8': 'utf8',
    'UTF-16 LE': 'utf16le',
    'UTF-16 BE': 'utf16be',
    'UTF-32 LE': 'utf32le',
    'UTF-32 BE': 'utf32be',
    GB18030: 'gb18030',
    GBK: 'gbk',
    GB2312: 'gb2312',
    Big5: 'big5',
    Shift_JIS: 'shiftjis',
    'EUC-JP': 'eucjp',
    'EUC-KR': 'euckr',
    'ISO-8859-1': 'iso88591',
    'windows-1252': 'win1252',
    ASCII: 'utf8',
  };
  return map[encoding] || encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tsDecode(buffer: Buffer): string {
  const bom = detectBOM(buffer);
  let encoding = bom;
  if (!encoding) {
    const detected = chardet.detect(buffer);
    encoding = detected || 'UTF-8';
  }
  const normalized = normalizeEncoding(encoding);
  try {
    if (iconv.encodingExists(normalized)) return iconv.decode(buffer, normalized);
    return buffer.toString('utf-8');
  } catch {
    return buffer.toString('utf-8');
  }
}

// ── fixtures ──

const utf8Bom = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('const x = "héllo 世界";\n', 'utf-8'),
]);
const utf16le = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('héllo 世界 — utf16le', 'utf16le'),
]);
// UTF-16 BE: 手动构造（Node 无 utf16be 编码器，逐字符高位在前）
function encodeUtf16be(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}
const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), encodeUtf16be('héllo 世界 BE')]);

const cjkText = (s: string) => s.repeat(6);
const gb18030 = iconv.encode(cjkText('你好世界，这是一段用于编码检测的中文文本。'), 'gb18030');
const big5 = iconv.encode(cjkText('這是一段繁體中文測試文字用於偵測編碼。'), 'big5');
const shiftjis = iconv.encode(cjkText('これはエンコーディング検出のための日本語テキストです。'), 'shiftjis');

const SAMPLES: { name: string; buf: Buffer }[] = [
  { name: 'utf-8 plain', buf: Buffer.from('plain ascii + 中文 + café\n', 'utf-8') },
  { name: 'utf-8 + BOM', buf: utf8Bom },
  { name: 'utf-16 LE + BOM', buf: utf16le },
  { name: 'utf-16 BE + BOM', buf: utf16be },
  { name: 'gb18030 (long, no BOM)', buf: gb18030 },
  { name: 'big5 (long, no BOM)', buf: big5 },
  { name: 'shift_jis (long, no BOM)', buf: shiftjis },
];

describe.skipIf(!hasNative)('encoding decode TS↔Rust 差分对拍', () => {
  for (const s of SAMPLES) {
    it(`[content 一致] ${s.name}`, () => {
      const ts = tsDecode(s.buf);
      const rs = (rustDecode as DecodeBytes)(s.buf).content;
      expect(rs).toEqual(ts);
    });
  }

  it('空 buffer 返回空串', () => {
    expect((rustDecode as DecodeBytes)(Buffer.alloc(0)).content).toBe('');
  });
});
