//! Port of `src/utils/encoding.ts` `readFileWithEncoding()` decode step.
//!
//! Takes raw file bytes and returns UTF-8 text plus the detected source
//! encoding label. Mirrors the TS pipeline: BOM sniff → chardet detection →
//! decode. The TS side keeps the `fs.readFile` (I/O stays in Node); only the
//! CPU-bound detect+decode is moved here.
//!
//! Detector: `chardetng` (Firefox's encoding detector) replaces the JS
//! `chardet` crate; decoder: `encoding_rs` (Gecko engine) replaces `iconv-lite`.
//! Output is always valid UTF-8 (lossy replacement on malformed input, matching
//! iconv-lite's default tolerant behavior).

use encoding_rs::Encoding;

/// Detect a BOM at the start of `buffer`, returning the matching encoding plus
/// the BOM length to strip. Order mirrors `detectBOM` in encoding.ts: UTF-8,
/// then UTF-32 (must precede UTF-16 since UTF-32 LE begins with the UTF-16 LE
/// BOM bytes), then UTF-16.
fn detect_bom(buffer: &[u8]) -> Option<(&'static Encoding, usize)> {
    if buffer.len() >= 3 && buffer[0] == 0xef && buffer[1] == 0xbb && buffer[2] == 0xbf {
        return Some((encoding_rs::UTF_8, 3));
    }
    if buffer.len() >= 4 {
        if buffer[0] == 0xff && buffer[1] == 0xfe && buffer[2] == 0x00 && buffer[3] == 0x00 {
            // UTF-32 LE — encoding_rs has no UTF-32; handled specially by caller.
            return Some((encoding_rs::UTF_16LE, 4)); // sentinel; see decode()
        }
        if buffer[0] == 0x00 && buffer[1] == 0x00 && buffer[2] == 0xfe && buffer[3] == 0xff {
            return Some((encoding_rs::UTF_16BE, 4)); // sentinel; see decode()
        }
    }
    if buffer.len() >= 2 {
        if buffer[0] == 0xff && buffer[1] == 0xfe {
            return Some((encoding_rs::UTF_16LE, 2));
        }
        if buffer[0] == 0xfe && buffer[1] == 0xff {
            return Some((encoding_rs::UTF_16BE, 2));
        }
    }
    None
}

/// Decode UTF-32 (LE/BE) by hand — `encoding_rs` does not support it but
/// iconv-lite does, so the TS path can produce UTF-32 content we must match.
/// `le` selects byte order; the 4-byte BOM is assumed already stripped.
fn decode_utf32(bytes: &[u8], le: bool) -> String {
    let mut out = String::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let cp = if le {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
    }
    out
}

/// Result of decoding raw bytes to UTF-8.
pub struct Decoded {
    pub content: String,
    pub original_encoding: String,
}

/// Detect encoding and decode `buffer` to UTF-8.
///
/// 1. BOM sniff (authoritative when present).
/// 2. Otherwise run chardetng across the whole buffer.
/// 3. Decode with the resolved encoding; UTF-32 handled manually.
pub fn decode_bytes(buffer: &[u8]) -> Decoded {
    // 1. BOM
    if let Some((enc, bom_len)) = detect_bom(buffer) {
        let body = &buffer[bom_len..];
        // UTF-32 sentinels: 4-byte BOM with the LE/BE markers handled here.
        if bom_len == 4 {
            let le = buffer[0] == 0xff;
            return Decoded {
                content: decode_utf32(body, le),
                original_encoding: if le { "UTF-32 LE".into() } else { "UTF-32 BE".into() },
            };
        }
        let (cow, _, _) = enc.decode(body);
        return Decoded {
            content: cow.into_owned(),
            original_encoding: bom_label(enc),
        };
    }

    // 2. chardetng detection over the full buffer.
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(buffer, true);
    let enc = detector.guess(None, true);

    // 3. decode
    let (cow, _, _) = enc.decode(buffer);
    Decoded {
        content: cow.into_owned(),
        original_encoding: enc.name().to_string(),
    }
}

/// Map BOM-resolved encoding to the label TS reports in `originalEncoding`.
fn bom_label(enc: &'static Encoding) -> String {
    if enc == encoding_rs::UTF_8 {
        "UTF-8".into()
    } else if enc == encoding_rs::UTF_16LE {
        "UTF-16 LE".into()
    } else if enc == encoding_rs::UTF_16BE {
        "UTF-16 BE".into()
    } else {
        enc.name().to_string()
    }
}
