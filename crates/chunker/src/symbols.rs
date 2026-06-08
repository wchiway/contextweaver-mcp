//! Port of `src/semantic/treeSitterTags.ts`.
//!
//! Symbol extraction via each grammar's `tags.scm`, embedded at build time from
//! the npm packages (`queries/<lang>.scm`) so the query source is byte-identical
//! to the TS implementation. TS/JS receive the same `TAGS_PATCHES` appendix.
//!
//! Query execution semantics (match order, capture pairing) differ between the
//! Rust `tree-sitter` crate and the npm binding, so the differential test sorts
//! before comparing rather than assuming identical ordering.

use crate::parser_pool;
use std::collections::HashMap;
use std::sync::OnceLock;
use tree_sitter::{Query, QueryCursor, StreamingIterator};

pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
}

/// Embedded tags.scm per language (copied from npm grammar packages).
fn tags_source(language: &str) -> Option<&'static str> {
    let base = match language {
        "typescript" => include_str!("../queries/typescript.scm"),
        "javascript" => include_str!("../queries/javascript.scm"),
        "python" => include_str!("../queries/python.scm"),
        "go" => include_str!("../queries/go.scm"),
        "rust" => include_str!("../queries/rust.scm"),
        "java" => include_str!("../queries/java.scm"),
        "c" => include_str!("../queries/c.scm"),
        "cpp" => include_str!("../queries/cpp.scm"),
        "c_sharp" => include_str!("../queries/c_sharp.scm"),
        "ruby" => include_str!("../queries/ruby.scm"),
        "php" => include_str!("../queries/php.scm"),
        _ => return None,
    };
    Some(base)
}

/// Patches appended to upstream tags.scm. Must match TS `TAGS_PATCHES` exactly.
fn tags_patch(language: &str) -> Option<&'static str> {
    match language {
        "typescript" => Some(
            "\n; 上游缺少普通 class 定义，补充\n(class_declaration\n  name: (type_identifier) @name) @definition.class\n\n; 补充函数声明\n(function_declaration\n  name: (identifier) @name) @definition.function\n\n; 补充 enum 定义\n(enum_declaration\n  name: (identifier) @name) @definition.class\n\n; 补充变量/常量导出（顶层）\n(lexical_declaration\n  (variable_declarator\n    name: (identifier) @name)) @definition.constant\n",
        ),
        "javascript" => Some(
            "\n; 补充 class 定义\n(class_declaration\n  name: (identifier) @name) @definition.class\n\n; 补充函数声明\n(function_declaration\n  name: (identifier) @name) @definition.function\n",
        ),
        _ => None,
    }
}

fn build_query(language: &str) -> Option<Query> {
    let lang = parser_pool::language_for(language)?;
    let mut src = tags_source(language)?.to_string();
    if let Some(patch) = tags_patch(language) {
        // TS does: tagsSource += `\n${patch}`
        src.push('\n');
        src.push_str(patch);
    }

    // Behaviour parity: the npm binding (@keqingmoe/tree-sitter) rejects the
    // `#strip!` query predicate and throws, so TS `extractTreeSitterSymbols`
    // returns [] for those languages (go/js/ruby) and falls back to ctags. The
    // Rust tree-sitter crate is more lenient and would otherwise extract symbols
    // here, diverging from production behaviour. To stay a faithful drop-in we
    // treat such queries as unbuildable too.
    if src.contains("#strip!") {
        return None;
    }

    Query::new(&lang, &src).ok()
}

fn query_for(language: &str) -> Option<&'static Query> {
    static CACHE: OnceLock<HashMap<String, Option<Query>>> = OnceLock::new();
    // Build lazily per language; cache the Option to avoid rebuilds.
    let cache = CACHE.get_or_init(|| {
        let mut m = HashMap::new();
        for lang in [
            "typescript",
            "javascript",
            "python",
            "go",
            "rust",
            "java",
            "c",
            "cpp",
            "c_sharp",
            "ruby",
            "php",
        ] {
            m.insert(lang.to_string(), build_query(lang));
        }
        m
    });
    cache.get(language).and_then(|o| o.as_ref())
}

fn capture_name_to_kind(capture_name: &str) -> String {
    let parts: Vec<&str> = capture_name.split('.').collect();
    if parts.len() >= 2 {
        parts[1].to_string()
    } else {
        "symbol".to_string()
    }
}

fn is_definition(capture_name: &str) -> bool {
    capture_name.starts_with("definition.")
}

pub fn extract_symbols(root: tree_sitter::Node, code: &str, language: &str) -> Vec<Symbol> {
    let query = match query_for(language) {
        Some(q) => q,
        None => return Vec::new(),
    };
    let bytes = code.as_bytes();
    let capture_names = query.capture_names();

    let mut symbols = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, bytes);

    while let Some(m) = matches.next() {
        let mut def_capture: Option<(&str, tree_sitter::Node)> = None;
        let mut name_capture: Option<tree_sitter::Node> = None;

        for cap in m.captures {
            let cname = capture_names[cap.index as usize];
            if cname.starts_with("definition.") || cname.starts_with("reference.") {
                def_capture = Some((cname, cap.node));
            } else if cname == "name" {
                name_capture = Some(cap.node);
            }
        }

        let (def_name, def_node) = match def_capture {
            Some(d) => d,
            None => continue,
        };
        let name_node = match name_capture {
            Some(n) => n,
            None => continue,
        };

        if !is_definition(def_name) {
            continue;
        }

        let symbol_name =
            String::from_utf8_lossy(&bytes[name_node.start_byte()..name_node.end_byte()])
                .into_owned();
        if symbol_name.is_empty() || symbol_name.len() > 200 {
            continue;
        }

        symbols.push(Symbol {
            name: symbol_name,
            kind: capture_name_to_kind(def_name),
            start_line: def_node.start_position().row as u32 + 1,
            end_line: def_node.end_position().row as u32 + 1,
        });
    }

    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syms(lang: &str, code: &str) -> Vec<Symbol> {
        let tree = parser_pool::parse(lang, code).unwrap();
        extract_symbols(tree.root_node(), code, lang)
    }

    #[test]
    fn extracts_rust_symbols() {
        let code = "fn foo() {}\nstruct Bar {}\n";
        let s = syms("rust", code);
        assert!(!s.is_empty());
        assert!(s.iter().all(|x| !x.name.is_empty()));
    }

    #[test]
    fn extracts_typescript_with_patch() {
        // class_declaration only resolves via the TS patch.
        let code = "class Foo {}\nfunction bar() {}\n";
        let s = syms("typescript", code);
        let names: Vec<&str> = s.iter().map(|x| x.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"bar"));
    }

    #[test]
    fn unsupported_language_empty() {
        let tree = parser_pool::parse("rust", "fn f(){}").unwrap();
        assert!(extract_symbols(tree.root_node(), "fn f(){}", "kotlin").is_empty());
    }
}
