//! Port of `src/semantic/treeSitterCalls.ts`.
//!
//! Extracts call sites via node-type pattern matching (no tags.scm). Mirrors
//! the TS traversal exactly: child iteration uses *all* children (not just
//! named), line numbers are `start_position.row + 1`, and callee text comes
//! from byte slicing the source.

use std::collections::HashMap;
use std::sync::OnceLock;
use tree_sitter::Node;

pub struct CallSite {
    pub callee_name: String,
    pub line: u32,
    pub qualifier: Option<String>,
}

struct CallNodeConfig {
    call_types: &'static [&'static str],
    callee_field: Option<&'static str>,
    identifier_types: &'static [&'static str],
}

fn call_configs() -> &'static HashMap<&'static str, CallNodeConfig> {
    static CONFIGS: OnceLock<HashMap<&'static str, CallNodeConfig>> = OnceLock::new();
    CONFIGS.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(
            "typescript",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "property_identifier"],
            },
        );
        m.insert(
            "javascript",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "property_identifier"],
            },
        );
        m.insert(
            "python",
            CallNodeConfig {
                call_types: &["call"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "attribute"],
            },
        );
        m.insert(
            "go",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "selector_expression", "field_identifier"],
            },
        );
        m.insert(
            "rust",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "field_expression"],
            },
        );
        m.insert(
            "java",
            CallNodeConfig {
                call_types: &["method_invocation"],
                callee_field: None,
                identifier_types: &["identifier"],
            },
        );
        m.insert(
            "c",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "field_expression"],
            },
        );
        m.insert(
            "cpp",
            CallNodeConfig {
                call_types: &["call_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "field_expression", "qualified_identifier"],
            },
        );
        m.insert(
            "c_sharp",
            CallNodeConfig {
                call_types: &["invocation_expression"],
                callee_field: Some("function"),
                identifier_types: &["identifier", "member_access_expression"],
            },
        );
        m.insert(
            "ruby",
            CallNodeConfig {
                call_types: &["call"],
                callee_field: Some("method"),
                identifier_types: &["identifier", "constant"],
            },
        );
        m.insert(
            "php",
            CallNodeConfig {
                call_types: &["function_call_expression", "member_call_expression"],
                callee_field: None,
                identifier_types: &["name", "member_access_expression"],
            },
        );
        m
    })
}

struct Callee {
    name: String,
    qualifier: Option<String>,
}

fn node_text(node: &Node, bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[node.start_byte()..node.end_byte()]).into_owned()
}

fn extract_callee_name(node: &Node, config: &CallNodeConfig, bytes: &[u8]) -> Option<Callee> {
    // Java has no `function` field; use `name`.
    let callee_node = match config.callee_field {
        Some(field) => node.child_by_field_name(field),
        None => node.child_by_field_name("name"),
    }?;

    let callee_kind = callee_node.kind();

    // Simple identifier (e.g. foo()).
    if config.identifier_types.contains(&callee_kind) {
        return Some(Callee {
            name: node_text(&callee_node, bytes),
            qualifier: None,
        });
    }

    // Member access (e.g. obj.method()).
    if matches!(
        callee_kind,
        "member_access_expression" | "field_expression" | "selector_expression" | "attribute"
    ) {
        let mut cursor = callee_node.walk();
        let children: Vec<Node> = callee_node.children(&mut cursor).collect();
        // Rightmost identifier-type child is the method name.
        for child in children.iter().rev() {
            if config.identifier_types.contains(&child.kind()) {
                let qualifier = children
                    .first()
                    .filter(|c| c.kind() == "identifier")
                    .map(|c| node_text(c, bytes));
                return Some(Callee {
                    name: node_text(child, bytes),
                    qualifier,
                });
            }
        }
    }

    // qualified_identifier (C++: ns::func).
    if callee_kind == "qualified_identifier" {
        let text = node_text(&callee_node, bytes);
        let parts: Vec<&str> = text.split("::").collect();
        return Some(Callee {
            name: parts[parts.len() - 1].to_string(),
            qualifier: Some(parts[0].to_string()),
        });
    }

    // Fallback: trimmed node text if reasonably short.
    let text = node_text(&callee_node, bytes);
    let trimmed = text.trim();
    if !trimmed.is_empty() && trimmed.len() < 100 {
        return Some(Callee {
            name: trimmed.to_string(),
            qualifier: None,
        });
    }

    None
}

pub fn extract_call_sites(root: Node, code: &str, language: &str) -> Vec<CallSite> {
    let config = match call_configs().get(language) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let bytes = code.as_bytes();
    let mut calls = Vec::new();
    traverse(&root, config, bytes, &mut calls);
    calls
}

fn traverse(node: &Node, config: &CallNodeConfig, bytes: &[u8], calls: &mut Vec<CallSite>) {
    if config.call_types.contains(&node.kind()) {
        if let Some(callee) = extract_callee_name(node, config, bytes) {
            if !callee.name.is_empty() {
                calls.push(CallSite {
                    callee_name: callee.name,
                    line: node.start_position().row as u32 + 1,
                    qualifier: callee.qualifier,
                });
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        traverse(&child, config, bytes, calls);
    }
}

#[allow(dead_code)]
pub fn supports_call_extraction(language: &str) -> bool {
    call_configs().contains_key(language)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_pool;

    fn sites(lang: &str, code: &str) -> Vec<CallSite> {
        let tree = parser_pool::parse(lang, code).unwrap();
        extract_call_sites(tree.root_node(), code, lang)
    }

    #[test]
    fn extracts_calls_rust() {
        // Exact callee semantics are validated against TS in the differential
        // test (tests/semantic/CallSites.diff.test.ts); here we only confirm
        // traversal finds call expressions.
        let code = "fn main() {\n    foo();\n    obj.bar();\n}\n";
        let s = sites("rust", code);
        assert!(!s.is_empty());
        assert!(s.iter().all(|c| !c.callee_name.is_empty()));
    }

    #[test]
    fn extracts_calls_python() {
        let code = "obj.method()\nfunc()\n";
        let s = sites("python", code);
        assert!(!s.is_empty());
    }

    #[test]
    fn unsupported_language_empty() {
        // kotlin not in CALL_CONFIGS
        assert!(!supports_call_extraction("kotlin"));
    }
}
