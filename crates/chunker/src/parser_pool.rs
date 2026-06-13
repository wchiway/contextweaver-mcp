//! Port of `src/chunking/ParserPool.ts`.
//!
//! Maps a language id to its tree-sitter grammar and parses source. tree-sitter
//! reports byte offsets, so downstream `SourceAdapter` resolves the utf8 domain.
//!
//! Supported: typescript / javascript / python / rust / go / java / c / cpp /
//! c_sharp / ruby / php / shell(bash). The TS `GRAMMAR_MODULES` also lists
//! kotlin / swift / lua; their Rust grammar crates have non-standard versions
//! and are deferred (fall through to plain-text split).

use tree_sitter::{Language, Parser, Tree};

fn language_for_impl(language: &str) -> Option<Language> {
    match language {
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "javascript" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "c_sharp" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        "shell" => Some(tree_sitter_bash::LANGUAGE.into()),
        _ => None,
    }
}

/// Exposed to the symbols module for building tags.scm queries.
pub(crate) fn language_for(language: &str) -> Option<Language> {
    language_for_impl(language)
}

// Used at P3 integration (processor.ts decides AST vs fallback path).
#[allow(dead_code)]
pub fn is_language_supported(language: &str) -> bool {
    language_for(language).is_some()
}

/// Parse `code` for `language`. Returns None if the grammar is unknown or
/// parsing fails (caller falls back to plain-text splitting).
pub fn parse(language: &str, code: &str) -> Option<Tree> {
    let lang = language_for(language)?;
    let mut parser = Parser::new();
    parser.set_language(&lang).ok()?;
    parser.parse(code, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rust() {
        let tree = parse("rust", "fn add(a: i32, b: i32) -> i32 { a + b }").unwrap();
        assert_eq!(tree.root_node().kind(), "source_file");
    }

    #[test]
    fn parses_python() {
        let tree = parse("python", "def f(x):\n    return x\n").unwrap();
        assert_eq!(tree.root_node().kind(), "module");
    }

    #[test]
    fn parses_typescript() {
        let tree = parse("typescript", "function add(a: number) { return a; }").unwrap();
        assert_eq!(tree.root_node().kind(), "program");
    }

    #[test]
    fn unknown_language_returns_none() {
        assert!(parse("brainfuck", "+++").is_none());
        assert!(!is_language_supported("brainfuck"));
    }

    #[test]
    fn parses_newly_added_grammars() {
        let cases: &[(&str, &str, &str)] = &[
            ("javascript", "function f(){return 1;}", "program"),
            ("go", "package main\nfunc main() {}\n", "source_file"),
            ("java", "class A { void m() {} }", "program"),
            ("c", "int main() { return 0; }", "translation_unit"),
            ("cpp", "int main() { return 0; }", "translation_unit"),
            ("c_sharp", "class A { void M() {} }", "compilation_unit"),
            ("ruby", "def f\n  1\nend\n", "program"),
            ("php", "<?php function f() { return 1; }", "program"),
            ("shell", "f() { echo hi; }\n", "program"),
        ];
        for (lang, code, root_kind) in cases {
            let tree = parse(lang, code).unwrap_or_else(|| panic!("parse failed for {lang}"));
            assert_eq!(
                tree.root_node().kind(),
                *root_kind,
                "root kind mismatch for {lang}"
            );
            assert!(is_language_supported(lang));
        }
    }
}
