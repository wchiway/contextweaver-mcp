import fs from 'node:fs/promises';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import { getNativeChunker } from '../chunking/nativeChunker.js';

/**
 * 支持的编码列表（按优先级排序）
 */
const _SUPPORTED_ENCODINGS = [
  'UTF-8',
  'UTF-16 LE',
  'UTF-16 BE',
  'UTF-32 LE',
  'UTF-32 BE',
  'GB18030', // 兼容 GBK 和 GB2312
  'Big5',
  'Shift_JIS',
  'EUC-JP',
  'EUC-KR',
  'ISO-8859-1',
  'windows-1252',
];

/**
 * 规范化编码名称，使其与 iconv-lite 兼容
 */
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
    ASCII: 'utf8', // ASCII 是 UTF-8 的子集
  };
  return map[encoding] || encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 检测 BOM（Byte Order Mark）
 */
function detectBOM(buffer: Buffer): string | null {
  if (buffer.length >= 3) {
    // UTF-8 BOM
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return 'UTF-8';
    }
  }
  if (buffer.length >= 4) {
    // UTF-32 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
      return 'UTF-32 LE';
    }
    // UTF-32 BE
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
      return 'UTF-32 BE';
    }
  }
  if (buffer.length >= 2) {
    // UTF-16 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return 'UTF-16 LE';
    }
    // UTF-16 BE
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'UTF-16 BE';
    }
  }
  return null;
}

/**
 * 读取文件并自动转换编码为 UTF-8
 * @param filePath 文件路径
 * @returns 解码后的文件内容和检测到的编码
 */
export async function readFileWithEncoding(filePath: string): Promise<{
  content: string;
  encoding: string;
  originalEncoding: string;
}> {
  const buffer = await fs.readFile(filePath);

  // 优先用 Rust native 检测+解码（chardetng + encoding_rs）；不可用或抛错时回退 TS。
  const native = getNativeChunker();
  if (native) {
    try {
      const { content, originalEncoding } = native.decodeBytes(buffer);
      return { content, encoding: 'utf-8', originalEncoding };
    } catch {
      // 回退到 TS chardet/iconv 路径
    }
  }

  return decodeBytesTs(buffer);
}

/**
 * TS 解码路径（chardet 检测 + iconv-lite 转码），native 不可用时的 fallback。
 */
function decodeBytesTs(buffer: Buffer): {
  content: string;
  encoding: string;
  originalEncoding: string;
} {
  // 检测编码
  const bom = detectBOM(buffer);
  let encoding = bom;

  if (!encoding) {
    const detected = chardet.detect(buffer);
    encoding = detected || 'UTF-8';
  }

  const normalizedEncoding = normalizeEncoding(encoding);

  // 尝试使用检测到的编码解码
  let content: string;
  try {
    if (iconv.encodingExists(normalizedEncoding)) {
      content = iconv.decode(buffer, normalizedEncoding);
    } else {
      // 回退到 UTF-8
      content = buffer.toString('utf-8');
    }
  } catch {
    // 解码失败，回退到 UTF-8
    content = buffer.toString('utf-8');
  }

  return {
    content,
    encoding: 'utf-8', // 输出始终是 UTF-8
    originalEncoding: encoding,
  };
}
