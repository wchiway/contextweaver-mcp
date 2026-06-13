//! Port of `src/chunking/SourceAdapter.ts`.
//!
//! Critical domain rules (must match the TS implementation byte-for-byte):
//! - The JS `code` string is UTF-16. All NWS prefix sums and emitted offsets
//!   live in the **UTF-16 code-unit domain**, NOT Rust `char` (scalar) domain.
//!   A non-BMP char (e.g. emoji) is 2 UTF-16 code units / 1 Rust char.
//! - tree-sitter may report offsets in the UTF-16 domain (utf16) or UTF-8 byte
//!   domain (utf8). `endIndex` probing decides which.
//! - `byteToCharMap` maps a UTF-8 byte offset to a UTF-16 code-unit offset;
//!   a 4-byte UTF-8 sequence advances the UTF-16 counter by 2 (surrogate pair).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IndexDomain {
    Utf16,
    Utf8,
    Unknown,
}

impl IndexDomain {
    pub fn as_str(&self) -> &'static str {
        match self {
            IndexDomain::Utf16 => "utf16",
            IndexDomain::Utf8 => "utf8",
            IndexDomain::Unknown => "unknown",
        }
    }
}

pub struct SourceAdapter {
    /// Source as UTF-16 code units (matches JS string indexing).
    units: Vec<u16>,
    domain: IndexDomain,
    /// byte offset -> UTF-16 code-unit offset. Only built for utf8 domain.
    byte_to_char: Option<Vec<u32>>,
    /// Prefix sum of non-whitespace UTF-16 code units. Length = units.len() + 1.
    nws_prefix_sum: Vec<u32>,
    /// Cached UTF-8 byte length of the source.
    utf8_len: usize,
}

impl SourceAdapter {
    /// `code` is the source text; `end_index` is tree-sitter's `root.endIndex`.
    pub fn new(code: &str, end_index: usize) -> Self {
        let units: Vec<u16> = code.encode_utf16().collect();
        let len_utf16 = units.len();
        let utf8_len = code.len();

        let (domain, byte_to_char) = if end_index == len_utf16 {
            (IndexDomain::Utf16, None)
        } else if end_index == utf8_len {
            (IndexDomain::Utf8, Some(build_byte_to_char_map(code, utf8_len)))
        } else {
            (IndexDomain::Unknown, None)
        };

        let nws_prefix_sum = build_nws_prefix_sum(&units);

        Self {
            units,
            domain,
            byte_to_char,
            nws_prefix_sum,
            utf8_len,
        }
    }

    pub fn domain(&self) -> IndexDomain {
        self.domain
    }

    // Needed by P1 windowsToChunks (utf8-domain rawSpanEnd uses byte length).
    #[allow(dead_code)]
    pub fn utf8_len(&self) -> usize {
        self.utf8_len
    }

    #[allow(dead_code)]
    pub fn utf16_len(&self) -> usize {
        self.units.len()
    }

    /// Non-whitespace code-unit count in [start, end). Inputs are in the
    /// detected domain (byte offsets for utf8, code-unit offsets otherwise).
    pub fn nws(&self, start: usize, end: usize) -> u32 {
        let (cs, ce) = if self.domain == IndexDomain::Utf8 {
            (self.byte_to_char(start), self.byte_to_char(end))
        } else {
            (start, end)
        };
        let max_index = self.nws_prefix_sum.len() - 1;
        let s = cs.min(max_index);
        let e = ce.min(max_index);
        self.nws_prefix_sum[e] - self.nws_prefix_sum[s]
    }

    pub fn total_nws(&self) -> u32 {
        *self.nws_prefix_sum.last().unwrap()
    }

    /// Safe slice. Inputs are in the detected domain; output is the substring.
    pub fn slice(&self, start: usize, end: usize) -> String {
        let (cs, ce) = match self.domain {
            IndexDomain::Utf16 | IndexDomain::Unknown => (start, end),
            IndexDomain::Utf8 => (self.byte_to_char(start), self.byte_to_char(end)),
        };
        self.slice_units(cs, ce)
    }

    /// Normalize a domain offset to the UTF-16 code-unit domain (for metadata).
    pub fn to_char_offset(&self, offset: usize) -> usize {
        match self.domain {
            IndexDomain::Utf16 | IndexDomain::Unknown => offset,
            IndexDomain::Utf8 => self.byte_to_char(offset),
        }
    }

    fn byte_to_char(&self, byte_offset: usize) -> usize {
        match &self.byte_to_char {
            None => byte_offset,
            Some(map) => {
                let idx = byte_offset.min(map.len() - 1);
                map[idx] as usize
            }
        }
    }

    /// Slice on the UTF-16 code-unit domain, clamped, decoding to a String.
    fn slice_units(&self, start: usize, end: usize) -> String {
        let len = self.units.len();
        let s = start.min(len);
        let e = end.min(len).max(s);
        decode_utf16_lenient(&self.units[s..e])
    }
}

/// Decode UTF-16 units to a String, mapping any unpaired surrogate to U+FFFD.
/// Boundaries from tree-sitter never split a code point, so unpaired surrogates
/// only arise from invalid arbitrary offsets (handled out of contract).
fn decode_utf16_lenient(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .collect()
}

/// UTF-16-domain NWS prefix sum. Matches TS `charCodeAt` iteration: each UTF-16
/// code unit is one step; whitespace = space/tab/LF/CR.
fn build_nws_prefix_sum(units: &[u16]) -> Vec<u32> {
    let mut prefix = vec![0u32; units.len() + 1];
    let mut count = 0u32;
    for (i, &cc) in units.iter().enumerate() {
        if !(cc == 0x20 || cc == 0x09 || cc == 0x0a || cc == 0x0d) {
            count += 1;
        }
        prefix[i + 1] = count;
    }
    prefix
}

/// byte offset -> UTF-16 code-unit offset. Mirrors the TS lead-byte scan:
/// fills intermediate bytes of a multi-byte char with the same code-unit index,
/// and advances by 2 code units for 4-byte UTF-8 (surrogate pair).
fn build_byte_to_char_map(code: &str, byte_len: usize) -> Vec<u32> {
    let bytes = code.as_bytes();
    let mut map = vec![0u32; byte_len + 1];

    let mut char_index: u32 = 0;
    let mut byte_index: usize = 0;

    while byte_index < byte_len {
        map[byte_index] = char_index;

        let b = bytes[byte_index];
        let char_bytes = if b & 0x80 == 0 {
            1
        } else if b & 0xe0 == 0xc0 {
            2
        } else if b & 0xf0 == 0xe0 {
            3
        } else if b & 0xf8 == 0xf0 {
            4
        } else {
            1
        };

        let mut i = 1;
        while i < char_bytes && byte_index + i < byte_len {
            map[byte_index + i] = char_index;
            i += 1;
        }

        byte_index += char_bytes;
        char_index += if char_bytes == 4 { 2 } else { 1 };
    }

    map[byte_len] = char_index;
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_domain_ascii() {
        let code = "fn  main() {}";
        let a = SourceAdapter::new(code, code.encode_utf16().count());
        assert_eq!(a.domain(), IndexDomain::Utf16);
        // 3 whitespace chars (two spaces + one space before brace) -> 13 - 3 = 10
        assert_eq!(a.total_nws(), 10);
        assert_eq!(a.slice(0, 2), "fn");
        assert_eq!(a.to_char_offset(5), 5);
    }

    #[test]
    fn utf16_domain_with_cjk_and_emoji() {
        // 你好 = 2 BMP chars (2 UTF-16 units), 🚀 = 1 non-BMP char (2 UTF-16 units)
        let code = "let s = \"你好🚀\";";
        let utf16_len = code.encode_utf16().count();
        let a = SourceAdapter::new(code, utf16_len);
        assert_eq!(a.domain(), IndexDomain::Utf16);
        // round-trip slice of the whole string
        assert_eq!(a.slice(0, utf16_len), code);
    }

    #[test]
    fn utf8_domain_byte_offsets_map_to_utf16() {
        let code = "a你b🚀c";
        let byte_len = code.len();
        let a = SourceAdapter::new(code, byte_len);
        assert_eq!(a.domain(), IndexDomain::Utf8);
        // byte 0 = 'a' -> utf16 0
        assert_eq!(a.to_char_offset(0), 0);
        // 'a'(1B) '你'(3B) -> 'b' starts at byte 4, utf16 index 2
        assert_eq!(a.to_char_offset(4), 2);
        // after 'b'(byte5) '🚀'(4B, 2 utf16 units) -> 'c' at byte 9, utf16 index 5
        assert_eq!(a.to_char_offset(9), 5);
        // slicing on byte offsets returns correct substrings
        assert_eq!(a.slice(0, 1), "a");
        assert_eq!(a.slice(1, 4), "你");
        assert_eq!(a.slice(5, 9), "🚀");
    }

    #[test]
    fn unknown_domain_falls_back_to_raw_offsets() {
        let code = "hello";
        let a = SourceAdapter::new(code, 999);
        assert_eq!(a.domain(), IndexDomain::Unknown);
        assert_eq!(a.to_char_offset(3), 3);
        assert_eq!(a.slice(0, 5), "hello");
    }
}
