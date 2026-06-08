//! Port of `src/chunking/SemanticSplitter.ts` (AST path + plain-text fallback).
//!
//! Domain rules (must match TS byte-for-byte):
//! - tree-sitter reports byte offsets; all internal arithmetic stays in the
//!   tree-sitter domain and is normalized to UTF-16 via [`SourceAdapter`] only
//!   when emitting [`ChunkMetadata`].
//! - `extract_node_name` length check uses UTF-16 length (JS `String.length`).

use crate::language_spec::get_language_spec;
use crate::source_adapter::{IndexDomain, SourceAdapter};
use tree_sitter::Node;

#[derive(Clone)]
pub struct SplitterConfig {
    pub max_chunk_size: u32,
    pub min_chunk_size: u32,
    pub chunk_overlap: u32,
    pub max_raw_chars: u32,
}

impl SplitterConfig {
    pub fn resolve(
        max_chunk_size: Option<u32>,
        min_chunk_size: Option<u32>,
        chunk_overlap: Option<u32>,
        max_raw_chars: Option<u32>,
    ) -> Self {
        let max = max_chunk_size.unwrap_or(2500);
        Self {
            max_chunk_size: max,
            min_chunk_size: min_chunk_size.unwrap_or(100),
            chunk_overlap: chunk_overlap.unwrap_or(200),
            max_raw_chars: max_raw_chars.unwrap_or(max * 4),
        }
    }
}

#[derive(Clone)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone)]
pub struct ChunkMetadata {
    pub start_index: u32,
    pub end_index: u32,
    pub raw_span: Span,
    pub vector_span: Span,
    pub file_path: String,
    pub language: String,
    pub context_path: Vec<String>,
}

#[derive(Clone)]
pub struct ProcessedChunk {
    pub display_code: String,
    pub vector_text: String,
    pub nws_size: u32,
    pub metadata: ChunkMetadata,
}

/// Lightweight node record: tree-sitter domain offsets + kind. Decouples the
/// window algorithm from tree lifetimes.
#[derive(Clone)]
struct NodeRef {
    start: usize,
    end: usize,
    kind: &'static str,
}

struct Window {
    nodes: Vec<NodeRef>,
    size: u32,
    context_path: Vec<String>,
}

pub struct SemanticSplitter {
    config: SplitterConfig,
}

impl SemanticSplitter {
    pub fn new(config: SplitterConfig) -> Self {
        Self { config }
    }

    /// AST-based split. `tree` must come from parsing `code` for `language`.
    pub fn split(
        &self,
        root: Node,
        code: &str,
        file_path: &str,
        language: &str,
    ) -> Vec<ProcessedChunk> {
        let adapter = SourceAdapter::new(code, root.end_byte());

        if adapter.domain() == IndexDomain::Unknown {
            return self.fallback_split(code, file_path, language);
        }

        let initial_context = vec![file_path.to_string()];
        let windows = self.visit_node(&root, code, language, &adapter, initial_context);
        self.windows_to_chunks(windows, code, file_path, language, &adapter)
    }

    /// Plain-text line split (fallback for unknown domain / non-AST languages).
    /// UTF-16 domain, no overlap. Mirrors TS `fallbackSplit`.
    pub fn fallback_split(
        &self,
        code: &str,
        file_path: &str,
        language: &str,
    ) -> Vec<ProcessedChunk> {
        let units: Vec<u16> = code.encode_utf16().collect();
        let adapter = SourceAdapter::new(code, units.len());
        let total_size = adapter.total_nws();

        if total_size <= self.config.max_chunk_size {
            let display = code.to_string();
            return vec![ProcessedChunk {
                display_code: display.clone(),
                vector_text: format!("// Context: {file_path}\n{display}"),
                nws_size: total_size,
                metadata: ChunkMetadata {
                    start_index: 0,
                    end_index: units.len() as u32,
                    raw_span: Span { start: 0, end: units.len() as u32 },
                    vector_span: Span { start: 0, end: units.len() as u32 },
                    file_path: file_path.to_string(),
                    language: language.to_string(),
                    context_path: vec![file_path.to_string()],
                },
            }];
        }

        // Split by lines, in UTF-16 code-unit offsets.
        let mut chunks = Vec::new();
        let lines = split_lines_utf16(&units);

        let mut current_lines: Vec<&[u16]> = Vec::new();
        let mut current_size: u32 = 0;
        let mut line_start_index: usize = 0;
        let mut chunk_start_index: usize = 0;
        let mut chunk_raw_start: usize = 0;

        for line in &lines {
            let line_end_index = line_start_index + line.len();
            let line_nws = adapter.nws(line_start_index, line_end_index);

            if current_size + line_nws > self.config.max_chunk_size && !current_lines.is_empty() {
                let display_units = join_lines_utf16(&current_lines);
                let display = String::from_utf16_lossy(&display_units);
                let chunk_end_index = chunk_start_index + display_units.len();

                chunks.push(ProcessedChunk {
                    display_code: display.clone(),
                    vector_text: format!("// Context: {file_path}\n{display}"),
                    nws_size: current_size,
                    metadata: ChunkMetadata {
                        start_index: chunk_start_index as u32,
                        end_index: chunk_end_index as u32,
                        raw_span: Span {
                            start: chunk_raw_start as u32,
                            end: (chunk_end_index + 1) as u32,
                        },
                        vector_span: Span {
                            start: chunk_start_index as u32,
                            end: chunk_end_index as u32,
                        },
                        file_path: file_path.to_string(),
                        language: language.to_string(),
                        context_path: vec![file_path.to_string()],
                    },
                });

                chunk_raw_start = chunk_end_index + 1;
                chunk_start_index += display_units.len() + 1;
                current_lines = vec![line.as_slice()];
                current_size = line_nws;
            } else {
                current_lines.push(line.as_slice());
                current_size += line_nws;
            }

            line_start_index = line_end_index + 1;
        }

        if !current_lines.is_empty() {
            let display_units = join_lines_utf16(&current_lines);
            let display = String::from_utf16_lossy(&display_units);
            let chunk_end_index = chunk_start_index + display_units.len();
            chunks.push(ProcessedChunk {
                display_code: display.clone(),
                vector_text: format!("// Context: {file_path}\n{display}"),
                nws_size: current_size,
                metadata: ChunkMetadata {
                    start_index: chunk_start_index as u32,
                    end_index: chunk_end_index as u32,
                    raw_span: Span {
                        start: chunk_raw_start as u32,
                        end: units.len() as u32,
                    },
                    vector_span: Span {
                        start: chunk_start_index as u32,
                        end: chunk_end_index as u32,
                    },
                    file_path: file_path.to_string(),
                    language: language.to_string(),
                    context_path: vec![file_path.to_string()],
                },
            });
        }

        chunks
    }

    fn visit_node(
        &self,
        node: &Node,
        code: &str,
        language: &str,
        adapter: &SourceAdapter,
        context: Vec<String>,
    ) -> Vec<Window> {
        let start = node.start_byte();
        let end = node.end_byte();
        let node_size = adapter.nws(start, end);

        let mut next_context = context.clone();
        if let Some(spec) = get_language_spec(language) {
            if spec.hierarchy.contains(node.kind()) {
                if let Some(name) = extract_node_name(node, code, spec) {
                    let prefix = spec.prefix_map.get(node.kind()).copied().unwrap_or("");
                    next_context.push(format!("{prefix}{name}"));
                }
            }
        }

        let kind: &'static str = node.kind();

        if node_size <= self.config.max_chunk_size {
            return vec![Window {
                nodes: vec![NodeRef { start, end, kind }],
                size: node_size,
                context_path: next_context,
            }];
        }

        let child_count = node.child_count();
        if child_count == 0 {
            return vec![Window {
                nodes: vec![NodeRef { start, end, kind }],
                size: node_size,
                context_path: next_context,
            }];
        }

        let mut child_windows = Vec::new();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            child_windows.extend(self.visit_node(
                &child,
                code,
                language,
                adapter,
                next_context.clone(),
            ));
        }

        self.merge_adjacent_windows(child_windows, language, adapter)
    }

    fn merge_adjacent_windows(
        &self,
        windows: Vec<Window>,
        language: &str,
        adapter: &SourceAdapter,
    ) -> Vec<Window> {
        if windows.is_empty() {
            return Vec::new();
        }

        let comment_types = comment_types_for(language);
        let mut merged: Vec<Window> = Vec::new();
        let mut iter = windows.into_iter();
        let mut current = iter.next().unwrap();

        for mut next in iter {
            self.forward_absorb_comments(&mut current, &mut next, &comment_types, adapter);

            if current.nodes.is_empty() {
                current = next;
                continue;
            }

            let current_start = current.nodes[0].start;
            let current_end = current.nodes[current.nodes.len() - 1].end;
            let next_start = next.nodes[0].start;
            let next_end = next.nodes[next.nodes.len() - 1].end;

            let gap_nws = adapter.nws(current_end, next_start);
            let combined_nws = current.size + gap_nws + next.size;
            let combined_raw_len = (next_end - current_start) as u32;

            let same_context = is_same_context(&current.context_path, &next.context_path);
            let boundary_penalty = if same_context { 1.0_f64 } else { 0.7_f64 };

            let is_tiny = current.size < self.config.min_chunk_size;
            let effective_budget = self.config.max_chunk_size as f64 * boundary_penalty;

            let fits_nws_budget = (combined_nws as f64) <= effective_budget
                || (is_tiny && (combined_nws as f64) < effective_budget * 1.5);
            let fits_raw_budget =
                (combined_raw_len as f64) <= self.config.max_raw_chars as f64 * boundary_penalty;

            if fits_nws_budget && fits_raw_budget {
                let next_nodes = next.nodes;
                let next_ctx = next.context_path;
                current.nodes.extend(next_nodes);
                current.size = combined_nws;
                if next_ctx.len() > current.context_path.len() {
                    current.context_path = next_ctx;
                }
            } else {
                merged.push(current);
                current = next;
            }
        }

        merged.push(current);
        merged
    }

    fn forward_absorb_comments(
        &self,
        current: &mut Window,
        next: &mut Window,
        comment_types: &[&'static str],
        adapter: &SourceAdapter,
    ) {
        let is_comment = |k: &str| comment_types.iter().any(|c| *c == k);

        let mut absorbed: Vec<NodeRef> = Vec::new();
        let mut absorbed_nws: u32 = 0;

        while let Some(last) = current.nodes.last() {
            if is_comment(last.kind) {
                let node = current.nodes.pop().unwrap();
                let node_nws = adapter.nws(node.start, node.end);
                absorbed.insert(0, node);
                absorbed_nws += node_nws;
                current.size -= node_nws;
            } else {
                break;
            }
        }

        if !absorbed.is_empty() {
            let gap_nws = if !next.nodes.is_empty() {
                adapter.nws(absorbed[absorbed.len() - 1].end, next.nodes[0].start)
            } else {
                0
            };
            // prepend absorbed to next
            let mut new_nodes = absorbed;
            new_nodes.extend(std::mem::take(&mut next.nodes));
            next.nodes = new_nodes;
            next.size += absorbed_nws + gap_nws;
        }
    }

    fn windows_to_chunks(
        &self,
        windows: Vec<Window>,
        code: &str,
        file_path: &str,
        language: &str,
        adapter: &SourceAdapter,
    ) -> Vec<ProcessedChunk> {
        if windows.is_empty() {
            return Vec::new();
        }

        let mut chunks = Vec::new();
        let mut prev_end: usize = 0;
        let overlap = self.config.chunk_overlap;
        let last_idx = windows.len() - 1;

        let code_end_index = if adapter.domain() == IndexDomain::Utf8 {
            code.len()
        } else {
            code.encode_utf16().count()
        };

        for (i, w) in windows.iter().enumerate() {
            let start = w.nodes[0].start;
            let end = w.nodes[w.nodes.len() - 1].end;

            let is_last = i == last_idx;
            let raw_span_end = if is_last { code_end_index } else { end };

            let mut vector_start = start;
            if i > 0 && overlap > 0 {
                let candidate_start = self.find_overlap_start(start, overlap, adapter);
                let overlap_raw_len = (start - candidate_start) as f64;
                if overlap_raw_len <= self.config.max_raw_chars as f64 * 0.25 {
                    vector_start = candidate_start;
                }
            }
            let vector_end = end;

            let display_code = adapter.slice(start, end);
            let vector_code = adapter.slice(vector_start, vector_end);

            let to_char = |n: usize| adapter.to_char_offset(n) as u32;

            let metadata = ChunkMetadata {
                start_index: to_char(start),
                end_index: to_char(end),
                raw_span: Span {
                    start: to_char(prev_end),
                    end: to_char(raw_span_end),
                },
                vector_span: Span {
                    start: to_char(vector_start),
                    end: to_char(vector_end),
                },
                file_path: file_path.to_string(),
                language: language.to_string(),
                context_path: w.context_path.clone(),
            };

            chunks.push(ProcessedChunk {
                display_code,
                vector_text: generate_vector_text(&vector_code, &w.context_path),
                nws_size: w.size,
                metadata,
            });

            prev_end = end;
        }

        chunks
    }

    fn find_overlap_start(&self, start: usize, target_nws: u32, adapter: &SourceAdapter) -> usize {
        if start == 0 || target_nws == 0 {
            return start;
        }
        let mut low: i64 = 0;
        let mut high: i64 = start as i64;
        let mut result = start;

        while low <= high {
            let mid = ((low + high) / 2) as usize;
            let nws_in_range = adapter.nws(mid, start);
            if nws_in_range >= target_nws {
                result = mid;
                low = mid as i64 + 1;
            } else {
                high = mid as i64 - 1;
            }
        }

        result.min(start)
    }
}

fn comment_types_for(language: &str) -> Vec<&'static str> {
    match get_language_spec(language) {
        Some(spec) => spec.comment_types.iter().copied().collect(),
        None => vec!["comment"],
    }
}

/// Mirrors TS `extractNodeName`. The length check uses UTF-16 length.
fn extract_node_name(
    node: &Node,
    code: &str,
    spec: &crate::language_spec::LanguageSpec,
) -> Option<String> {
    let bytes = code.as_bytes();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if spec.name_node_types.contains(child.kind()) {
            return Some(slice_bytes(bytes, child.start_byte(), child.end_byte()));
        }
    }

    if let Some(first) = node.named_child(0) {
        let text = slice_bytes(bytes, first.start_byte(), first.end_byte());
        let utf16_len = text.encode_utf16().count();
        if utf16_len <= 100 && !text.contains('\n') {
            return Some(text);
        }
    }

    None
}

fn slice_bytes(bytes: &[u8], start: usize, end: usize) -> String {
    String::from_utf8_lossy(&bytes[start..end]).into_owned()
}

fn is_same_context(a: &[String], b: &[String]) -> bool {
    let min_len = a.len().min(b.len());
    let mut common_len = 0;
    for i in 0..min_len {
        if a[i] == b[i] {
            common_len += 1;
        } else {
            break;
        }
    }
    common_len >= min_len
}

fn generate_vector_text(code: &str, context_path: &[String]) -> String {
    let breadcrumb = context_path.join(" > ");
    format!("// Context: {breadcrumb}\n{code}")
}

/// Split UTF-16 units by '\n' (0x0a), excluding the newline (matches JS `split('\n')`).
fn split_lines_utf16(units: &[u16]) -> Vec<Vec<u16>> {
    let mut lines = Vec::new();
    let mut cur = Vec::new();
    for &u in units {
        if u == 0x0a {
            lines.push(std::mem::take(&mut cur));
        } else {
            cur.push(u);
        }
    }
    lines.push(cur);
    lines
}

/// Join line slices with '\n' (matches JS `Array.join('\n')`).
fn join_lines_utf16(lines: &[&[u16]]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(0x0a);
        }
        out.extend_from_slice(line);
    }
    out
}
