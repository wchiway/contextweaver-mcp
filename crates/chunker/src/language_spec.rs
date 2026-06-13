//! Port of `src/chunking/LanguageSpec.ts`.
//!
//! Only the fields consumed by the splitter are ported: `hierarchy`,
//! `name_node_types`, `prefix_map`, `comment_types`. The TS `nameFields` field
//! is defined but never read by SemanticSplitter, so it is intentionally omitted.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

pub struct LanguageSpec {
    pub hierarchy: HashSet<&'static str>,
    pub name_node_types: HashSet<&'static str>,
    pub prefix_map: HashMap<&'static str, &'static str>,
    pub comment_types: HashSet<&'static str>,
}

fn set(items: &[&'static str]) -> HashSet<&'static str> {
    items.iter().copied().collect()
}

fn map(items: &[(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
    items.iter().copied().collect()
}

fn build_specs() -> HashMap<&'static str, LanguageSpec> {
    let mut m = HashMap::new();

    m.insert(
        "typescript",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "abstract_class_declaration",
                "interface_declaration",
                "function_declaration",
                "generator_function_declaration",
                "method_definition",
                "arrow_function",
                "export_statement",
                "import_statement",
            ]),
            name_node_types: set(&["identifier", "type_identifier", "property_identifier"]),
            prefix_map: map(&[
                ("class_declaration", "class "),
                ("abstract_class_declaration", "abstract class "),
                ("interface_declaration", "interface "),
                ("function_declaration", "fn "),
                ("generator_function_declaration", "fn* "),
                ("method_definition", ""),
                ("arrow_function", ""),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "javascript",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "function_declaration",
                "generator_function_declaration",
                "method_definition",
                "arrow_function",
            ]),
            name_node_types: set(&["identifier", "property_identifier"]),
            prefix_map: map(&[
                ("class_declaration", "class "),
                ("function_declaration", "fn "),
                ("generator_function_declaration", "fn* "),
                ("method_definition", ""),
                ("arrow_function", ""),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "python",
        LanguageSpec {
            hierarchy: set(&[
                "class_definition",
                "function_definition",
                "decorated_definition",
            ]),
            name_node_types: set(&["identifier"]),
            prefix_map: map(&[
                ("class_definition", "class "),
                ("function_definition", "def "),
                ("decorated_definition", ""),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "go",
        LanguageSpec {
            hierarchy: set(&[
                "function_declaration",
                "method_declaration",
                "type_spec",
                "type_declaration",
                "struct_type",
                "interface_type",
            ]),
            name_node_types: set(&["identifier", "type_identifier", "field_identifier"]),
            prefix_map: map(&[
                ("function_declaration", "func "),
                ("method_declaration", "func "),
                ("type_spec", "type "),
                ("type_declaration", "type "),
                ("struct_type", "struct "),
                ("interface_type", "interface "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "rust",
        LanguageSpec {
            hierarchy: set(&[
                "function_item",
                "struct_item",
                "enum_item",
                "trait_item",
                "impl_item",
                "mod_item",
                "type_item",
            ]),
            name_node_types: set(&["identifier", "type_identifier"]),
            prefix_map: map(&[
                ("function_item", "fn "),
                ("struct_item", "struct "),
                ("enum_item", "enum "),
                ("trait_item", "trait "),
                ("impl_item", "impl "),
                ("mod_item", "mod "),
                ("type_item", "type "),
            ]),
            comment_types: set(&["line_comment", "block_comment"]),
        },
    );

    m.insert(
        "java",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "interface_declaration",
                "enum_declaration",
                "annotation_type_declaration",
                "method_declaration",
                "constructor_declaration",
                "record_declaration",
            ]),
            name_node_types: set(&["identifier"]),
            prefix_map: map(&[
                ("class_declaration", "class "),
                ("interface_declaration", "interface "),
                ("enum_declaration", "enum "),
                ("annotation_type_declaration", "@interface "),
                ("method_declaration", ""),
                ("constructor_declaration", ""),
                ("record_declaration", "record "),
            ]),
            comment_types: set(&["line_comment", "block_comment"]),
        },
    );

    m.insert(
        "c",
        LanguageSpec {
            hierarchy: set(&[
                "function_definition",
                "struct_specifier",
                "union_specifier",
                "enum_specifier",
                "type_definition",
            ]),
            name_node_types: set(&["identifier", "type_identifier", "field_identifier"]),
            prefix_map: map(&[
                ("function_definition", ""),
                ("struct_specifier", "struct "),
                ("union_specifier", "union "),
                ("enum_specifier", "enum "),
                ("type_definition", "typedef "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "cpp",
        LanguageSpec {
            hierarchy: set(&[
                "function_definition",
                "class_specifier",
                "struct_specifier",
                "union_specifier",
                "enum_specifier",
                "namespace_definition",
                "template_declaration",
                "type_definition",
            ]),
            name_node_types: set(&[
                "identifier",
                "type_identifier",
                "field_identifier",
                "namespace_identifier",
            ]),
            prefix_map: map(&[
                ("function_definition", ""),
                ("class_specifier", "class "),
                ("struct_specifier", "struct "),
                ("union_specifier", "union "),
                ("enum_specifier", "enum "),
                ("namespace_definition", "namespace "),
                ("template_declaration", "template "),
                ("type_definition", "typedef "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "c_sharp",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "interface_declaration",
                "struct_declaration",
                "enum_declaration",
                "record_declaration",
                "method_declaration",
                "constructor_declaration",
                "property_declaration",
                "namespace_declaration",
            ]),
            name_node_types: set(&["identifier"]),
            prefix_map: map(&[
                ("class_declaration", "class "),
                ("interface_declaration", "interface "),
                ("struct_declaration", "struct "),
                ("enum_declaration", "enum "),
                ("record_declaration", "record "),
                ("method_declaration", ""),
                ("constructor_declaration", ""),
                ("property_declaration", ""),
                ("namespace_declaration", "namespace "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "ruby",
        LanguageSpec {
            hierarchy: set(&[
                "module",
                "class",
                "singleton_class",
                "method",
                "singleton_method",
            ]),
            name_node_types: set(&["constant", "identifier"]),
            prefix_map: map(&[
                ("module", "module "),
                ("class", "class "),
                ("singleton_class", "class "),
                ("method", "def "),
                ("singleton_method", "def "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "php",
        LanguageSpec {
            hierarchy: set(&[
                "namespace_definition",
                "class_declaration",
                "interface_declaration",
                "trait_declaration",
                "enum_declaration",
                "method_declaration",
                "function_definition",
            ]),
            name_node_types: set(&["name"]),
            prefix_map: map(&[
                ("namespace_definition", "namespace "),
                ("class_declaration", "class "),
                ("interface_declaration", "interface "),
                ("trait_declaration", "trait "),
                ("enum_declaration", "enum "),
                ("method_declaration", ""),
                ("function_definition", "function "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "kotlin",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "object_declaration",
                "function_declaration",
            ]),
            name_node_types: set(&["type_identifier", "simple_identifier"]),
            prefix_map: map(&[
                ("class_declaration", "class "),
                ("object_declaration", "object "),
                ("function_declaration", "fun "),
            ]),
            comment_types: set(&["line_comment", "multiline_comment"]),
        },
    );

    m.insert(
        "swift",
        LanguageSpec {
            hierarchy: set(&[
                "class_declaration",
                "protocol_declaration",
                "function_declaration",
                "init_declaration",
            ]),
            name_node_types: set(&["type_identifier", "simple_identifier"]),
            prefix_map: map(&[
                ("class_declaration", "type "),
                ("protocol_declaration", "protocol "),
                ("function_declaration", "func "),
                ("init_declaration", "init "),
            ]),
            comment_types: set(&["comment", "multiline_comment"]),
        },
    );

    m.insert(
        "lua",
        LanguageSpec {
            hierarchy: set(&["function_declaration", "function_definition"]),
            name_node_types: set(&[
                "identifier",
                "dot_index_expression",
                "method_index_expression",
            ]),
            prefix_map: map(&[
                ("function_declaration", "function "),
                ("function_definition", "function "),
            ]),
            comment_types: set(&["comment"]),
        },
    );

    m.insert(
        "shell",
        LanguageSpec {
            hierarchy: set(&["function_definition"]),
            name_node_types: set(&["word"]),
            prefix_map: map(&[("function_definition", "function ")]),
            comment_types: set(&["comment"]),
        },
    );

    m
}

pub fn get_language_spec(language: &str) -> Option<&'static LanguageSpec> {
    static SPECS: OnceLock<HashMap<&'static str, LanguageSpec>> = OnceLock::new();
    SPECS.get_or_init(build_specs).get(language)
}
