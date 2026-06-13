#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

mod calls;
mod encoding;
mod imports;
mod language_spec;
mod parser_pool;
mod source_adapter;
mod splitter;
mod symbols;

use source_adapter::SourceAdapter;

/// napi wrapper over [`SourceAdapter`]. Exposed so the TS test suite can run a
/// byte-for-byte differential against `src/chunking/SourceAdapter.ts`.
#[napi(js_name = "SourceAdapter")]
pub struct JsSourceAdapter {
    inner: SourceAdapter,
}

#[napi]
impl JsSourceAdapter {
    #[napi(constructor)]
    pub fn new(code: String, end_index: u32) -> Self {
        Self {
            inner: SourceAdapter::new(&code, end_index as usize),
        }
    }

    #[napi(js_name = "getDomain")]
    pub fn get_domain(&self) -> String {
        self.inner.domain().as_str().to_string()
    }

    #[napi]
    pub fn nws(&self, start: u32, end: u32) -> u32 {
        self.inner.nws(start as usize, end as usize)
    }

    #[napi(js_name = "getTotalNws")]
    pub fn get_total_nws(&self) -> u32 {
        self.inner.total_nws()
    }

    #[napi]
    pub fn slice(&self, start: u32, end: u32) -> String {
        self.inner.slice(start as usize, end as usize)
    }

    #[napi(js_name = "toCharOffset")]
    pub fn to_char_offset(&self, offset: u32) -> u32 {
        self.inner.to_char_offset(offset as usize) as u32
    }
}

// ── process_file: AST parse + semantic split, returned to JS ──────────────────

#[napi(object)]
pub struct JsSpan {
    pub start: u32,
    pub end: u32,
}

#[napi(object)]
pub struct JsChunkMetadata {
    pub start_index: u32,
    pub end_index: u32,
    pub raw_span: JsSpan,
    pub vector_span: JsSpan,
    pub file_path: String,
    pub language: String,
    pub context_path: Vec<String>,
}

#[napi(object)]
pub struct JsProcessedChunk {
    pub display_code: String,
    pub vector_text: String,
    pub nws_size: u32,
    pub metadata: JsChunkMetadata,
}

#[napi(object)]
pub struct JsSplitterConfig {
    pub max_chunk_size: Option<u32>,
    pub min_chunk_size: Option<u32>,
    pub chunk_overlap: Option<u32>,
    pub max_raw_chars: Option<u32>,
}

fn to_js_chunk(c: splitter::ProcessedChunk) -> JsProcessedChunk {
    JsProcessedChunk {
        display_code: c.display_code,
        vector_text: c.vector_text,
        nws_size: c.nws_size,
        metadata: JsChunkMetadata {
            start_index: c.metadata.start_index,
            end_index: c.metadata.end_index,
            raw_span: JsSpan {
                start: c.metadata.raw_span.start,
                end: c.metadata.raw_span.end,
            },
            vector_span: JsSpan {
                start: c.metadata.vector_span.start,
                end: c.metadata.vector_span.end,
            },
            file_path: c.metadata.file_path,
            language: c.metadata.language,
            context_path: c.metadata.context_path,
        },
    }
}

fn resolve_config(config: Option<JsSplitterConfig>) -> splitter::SplitterConfig {
    let c = config.unwrap_or(JsSplitterConfig {
        max_chunk_size: None,
        min_chunk_size: None,
        chunk_overlap: None,
        max_raw_chars: None,
    });
    splitter::SplitterConfig::resolve(
        c.max_chunk_size,
        c.min_chunk_size,
        c.chunk_overlap,
        c.max_raw_chars,
    )
}

/// AST-based semantic split. Parses `code` for `language` and returns chunks.
/// Falls back to plain-text line splitting if the grammar is unknown or parsing
/// fails (mirrors processor.ts behaviour).
#[napi]
pub fn split_file(
    code: String,
    file_path: String,
    language: String,
    config: Option<JsSplitterConfig>,
) -> Vec<JsProcessedChunk> {
    let splitter = splitter::SemanticSplitter::new(resolve_config(config));

    let chunks = match parser_pool::parse(&language, &code) {
        Some(tree) => splitter.split(tree.root_node(), &code, &file_path, &language),
        None => splitter.fallback_split(&code, &file_path, &language),
    };

    chunks.into_iter().map(to_js_chunk).collect()
}

/// Plain-text line split (no AST). Mirrors TS `splitter.splitPlainText`.
#[napi]
pub fn split_plain_text(
    code: String,
    file_path: String,
    language: String,
    config: Option<JsSplitterConfig>,
) -> Vec<JsProcessedChunk> {
    let splitter = splitter::SemanticSplitter::new(resolve_config(config));
    splitter
        .fallback_split(&code, &file_path, &language)
        .into_iter()
        .map(to_js_chunk)
        .collect()
}

// ── extractCallSites: call graph edges, returned to JS ────────────────────────

#[napi(object)]
pub struct JsCallSite {
    pub callee_name: String,
    pub line: u32,
    pub qualifier: Option<String>,
}

/// Extract call sites by AST traversal. Returns empty for unsupported languages
/// (mirrors TS `extractCallSites`).
#[napi]
pub fn extract_call_sites(code: String, language: String) -> Vec<JsCallSite> {
    match parser_pool::parse(&language, &code) {
        Some(tree) => calls::extract_call_sites(tree.root_node(), &code, &language)
            .into_iter()
            .map(|c| JsCallSite {
                callee_name: c.callee_name,
                line: c.line,
                qualifier: c.qualifier,
            })
            .collect(),
        None => Vec::new(),
    }
}

// ── extractSymbols: tags.scm definitions, returned to JS ──────────────────────

#[napi(object)]
pub struct JsCodeSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
}

/// Extract symbol definitions via embedded tags.scm. Returns empty for
/// languages without an embedded query (mirrors TS `extractTreeSitterSymbols`).
#[napi]
pub fn extract_symbols(code: String, language: String) -> Vec<JsCodeSymbol> {
    match parser_pool::parse(&language, &code) {
        Some(tree) => symbols::extract_symbols(tree.root_node(), &code, &language)
            .into_iter()
            .map(|s| JsCodeSymbol {
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                end_line: s.end_line,
            })
            .collect(),
        None => Vec::new(),
    }
}

// ── extractImports: import strings per resolver kind, returned to JS ──────────

/// Regex port of `src/search/resolvers/*.ts` `extract()`. `kind` ∈
/// {jsts, python, go, java, rust, cpp, csharp}; output is byte-identical to the
/// TS resolver of the same language so the TS `resolve()` keeps working.
/// Unknown kind returns empty (mirrors GraphExpander skipping unmatched files).
#[napi(js_name = "extractImports")]
pub fn extract_imports(kind: String, content: String) -> Vec<String> {
    imports::extract_imports(&kind, &content)
}

// ── decodeBytes: detect encoding + decode raw file bytes to UTF-8 ─────────────

#[napi(object)]
pub struct JsDecodedFile {
    /// Always UTF-8.
    pub content: String,
    /// Detected source encoding label (informational; matches the
    /// `originalEncoding` field TS reports).
    pub original_encoding: String,
}

/// Port of the decode step in `src/utils/encoding.ts` `readFileWithEncoding`.
/// Takes raw file bytes (TS keeps `fs.readFile`), detects the encoding via BOM
/// then chardetng, and returns UTF-8 content. Caller falls back to the TS
/// chardet/iconv path when this native module is unavailable.
#[napi(js_name = "decodeBytes")]
pub fn decode_bytes(buffer: napi::bindgen_prelude::Buffer) -> JsDecodedFile {
    let decoded = encoding::decode_bytes(&buffer);
    JsDecodedFile {
        content: decoded.content,
        original_encoding: decoded.original_encoding,
    }
}

// ── processFile: single parse → chunks + symbols + callSites ──────────────────

#[napi(object)]
pub struct JsFileResult {
    pub chunks: Vec<JsProcessedChunk>,
    pub symbols: Vec<JsCodeSymbol>,
    pub call_sites: Vec<JsCallSite>,
    /// True when AST parsing succeeded (caller uses this to gate ctags fallback,
    /// mirroring processor.ts which only runs tree-sitter symbols when AST works).
    pub ast_ok: bool,
}

/// Parse `code` once and derive chunks, symbols, and call sites from the same
/// tree. Mirrors processor.ts: on AST success, chunks come from the semantic
/// splitter and symbols/callSites are extracted; on failure or unsupported
/// language, chunks fall back to plain-text line splitting and symbols/callSites
/// are empty (caller should run ctags).
#[napi]
pub fn process_file(
    code: String,
    file_path: String,
    language: String,
    config: Option<JsSplitterConfig>,
) -> JsFileResult {
    let splitter = splitter::SemanticSplitter::new(resolve_config(config));

    match parser_pool::parse(&language, &code) {
        Some(tree) => {
            let root = tree.root_node();
            let chunks = splitter.split(root, &code, &file_path, &language);

            // processor.ts gates tree-sitter symbol/call extraction on chunks
            // being produced (grammar is only retained when chunks.length > 0).
            if chunks.is_empty() {
                return JsFileResult {
                    chunks: Vec::new(),
                    symbols: Vec::new(),
                    call_sites: Vec::new(),
                    ast_ok: false,
                };
            }

            let symbols = symbols::extract_symbols(root, &code, &language)
                .into_iter()
                .map(|s| JsCodeSymbol {
                    name: s.name,
                    kind: s.kind,
                    start_line: s.start_line,
                    end_line: s.end_line,
                })
                .collect();
            let call_sites = calls::extract_call_sites(root, &code, &language)
                .into_iter()
                .map(|c| JsCallSite {
                    callee_name: c.callee_name,
                    line: c.line,
                    qualifier: c.qualifier,
                })
                .collect();

            JsFileResult {
                chunks: chunks.into_iter().map(to_js_chunk).collect(),
                symbols,
                call_sites,
                ast_ok: true,
            }
        }
        None => JsFileResult {
            chunks: splitter
                .fallback_split(&code, &file_path, &language)
                .into_iter()
                .map(to_js_chunk)
                .collect(),
            symbols: Vec::new(),
            call_sites: Vec::new(),
            ast_ok: false,
        },
    }
}
