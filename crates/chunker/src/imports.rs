//! Port of `src/search/resolvers/*.ts` `extract()` methods.
//!
//! Byte-for-byte regex port of the 7 import resolvers. Output strings must match
//! the TS `extract()` exactly because the TS `resolve()` (kept in TS) depends on
//! the literal format (e.g. Rust `mod:`/`use:` prefixes, Python relative dots).
//!
//! `kind` ∈ {jsts, python, go, java, rust, cpp, csharp}; unknown → empty Vec
//! (mirrors GraphExpander skipping files with no matching resolver).
//!
//! JS↔Rust regex differences handled here:
//! - JS `\w` is ASCII `[A-Za-z0-9_]`; Rust `regex` `\w` is Unicode. We use ASCII
//!   classes / `(?-u:\w)` to preserve TS semantics.
//! - Rust `regex` has no lookahead; csharp's `(?!static)(?!global)` is emulated
//!   in code by skipping matches whose namespace head is `static`/`global`.

use regex::Regex;
use std::sync::OnceLock;

struct JsTsRes {
    import_from: Regex,
    dynamic: Regex,
}

struct PyRes {
    pattern: Regex,
}

struct GoRes {
    single: Regex,
    block: Regex,
    block_line: Regex,
}

struct JavaRes {
    pattern: Regex,
}

struct RustRes {
    mod_pat: Regex,
    use_pat: Regex,
}

struct CppRes {
    include: Regex,
}

struct CSharpRes {
    pattern: Regex,
}

fn jsts() -> &'static JsTsRes {
    static R: OnceLock<JsTsRes> = OnceLock::new();
    R.get_or_init(|| JsTsRes {
        // /(?:import|export)\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g
        import_from: Regex::new(
            r#"(?:import|export)\s+(?:[A-Za-z0-9_\s{},*]+\s+from\s+)?['"]([^'"]+)['"]"#,
        )
        .unwrap(),
        // /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
        dynamic: Regex::new(r#"(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap(),
    })
}

fn python() -> &'static PyRes {
    static R: OnceLock<PyRes> = OnceLock::new();
    R.get_or_init(|| PyRes {
        // /^\s*(?:from\s+(\.{0,3}[\w.]*)\s+import|import\s+([\w.]+))/gm
        pattern: Regex::new(r"(?m)^\s*(?:from\s+(\.{0,3}[A-Za-z0-9_.]*)\s+import|import\s+([A-Za-z0-9_.]+))").unwrap(),
    })
}

fn go() -> &'static GoRes {
    static R: OnceLock<GoRes> = OnceLock::new();
    R.get_or_init(|| GoRes {
        // /^\s*import\s+"([^"]+)"/gm
        single: Regex::new(r#"(?m)^\s*import\s+"([^"]+)""#).unwrap(),
        // /import\s*\(\s*([\s\S]*?)\s*\)/g  ([\s\S] → (?s). )
        block: Regex::new(r"(?s)import\s*\(\s*(.*?)\s*\)").unwrap(),
        // /"([^"]+)"/g
        block_line: Regex::new(r#""([^"]+)""#).unwrap(),
    })
}

fn java() -> &'static JavaRes {
    static R: OnceLock<JavaRes> = OnceLock::new();
    R.get_or_init(|| JavaRes {
        // /^\s*import\s+(?:static\s+)?([\w.]+);/gm
        pattern: Regex::new(r"(?m)^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+);").unwrap(),
    })
}

fn rust() -> &'static RustRes {
    static R: OnceLock<RustRes> = OnceLock::new();
    R.get_or_init(|| RustRes {
        // /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm
        mod_pat: Regex::new(r"(?m)^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;").unwrap(),
        // /^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm
        use_pat: Regex::new(
            r"(?m)^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::[A-Za-z0-9_]+)+)",
        )
        .unwrap(),
    })
}

fn cpp() -> &'static CppRes {
    static R: OnceLock<CppRes> = OnceLock::new();
    R.get_or_init(|| CppRes {
        // /^\s*#\s*include\s+"([^"]+)"/gm
        include: Regex::new(r#"(?m)^\s*#\s*include\s+"([^"]+)""#).unwrap(),
    })
}

fn csharp() -> &'static CSharpRes {
    static R: OnceLock<CSharpRes> = OnceLock::new();
    R.get_or_init(|| CSharpRes {
        // /^\s*using\s+(?!static\s)(?!global\s)(?:\w+\s*=\s*)?([\w.]+);/gm
        // Lookahead removed; static/global filtered in code below.
        pattern: Regex::new(
            r"(?m)^\s*using\s+(?:[A-Za-z0-9_]+\s*=\s*)?([A-Za-z0-9_.]+);",
        )
        .unwrap(),
    })
}

fn extract_jsts(content: &str) -> Vec<String> {
    let r = jsts();
    let mut out = Vec::new();
    for c in r.import_from.captures_iter(content) {
        out.push(c[1].to_string());
    }
    for c in r.dynamic.captures_iter(content) {
        out.push(c[1].to_string());
    }
    out
}

fn extract_python(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in python().pattern.captures_iter(content) {
        // match[1] || match[2]
        let s = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str());
        if let Some(s) = s {
            if !s.is_empty() {
                out.push(s.to_string());
            }
        }
    }
    out
}

fn extract_go(content: &str) -> Vec<String> {
    let r = go();
    let mut out = Vec::new();
    for c in r.single.captures_iter(content) {
        out.push(c[1].to_string());
    }
    for block in r.block.captures_iter(content) {
        let inner = &block[1];
        for line in r.block_line.captures_iter(inner) {
            out.push(line[1].to_string());
        }
    }
    out
}

fn extract_java(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in java().pattern.captures_iter(content) {
        out.push(c[1].to_string());
    }
    out
}

fn extract_rust(content: &str) -> Vec<String> {
    let r = rust();
    let mut out = Vec::new();
    for c in r.mod_pat.captures_iter(content) {
        out.push(format!("mod:{}", &c[1]));
    }
    for c in r.use_pat.captures_iter(content) {
        out.push(format!("use:{}", &c[1]));
    }
    out
}

fn extract_cpp(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in cpp().include.captures_iter(content) {
        out.push(c[1].to_string());
    }
    out
}

fn extract_csharp(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in csharp().pattern.captures_iter(content) {
        // Emulate the TS negative lookahead `(?!static\s)(?!global\s)`: skip
        // `using static X;` (and `using global X;`). The lookahead requires the
        // keyword be followed by whitespace, so `using staticFoo;` (a real
        // namespace) must NOT be skipped. `global using X;` starts with
        // `global`, not `using`, so it never matches `^\s*using` at all.
        let full = c.get(0).unwrap().as_str().trim_start();
        let after_using = full
            .strip_prefix("using")
            .map(str::trim_start)
            .unwrap_or(full);
        let is_kw = |kw: &str| {
            after_using
                .strip_prefix(kw)
                .is_some_and(|r| r.starts_with(char::is_whitespace))
        };
        if is_kw("static") || is_kw("global") {
            continue;
        }
        out.push(c[1].to_string());
    }
    out
}

/// Extract import strings for `kind`. Output is byte-identical to the TS
/// resolver `extract()` of the same language. Unknown kind → empty.
pub fn extract_imports(kind: &str, content: &str) -> Vec<String> {
    match kind {
        "jsts" => extract_jsts(content),
        "python" => extract_python(content),
        "go" => extract_go(content),
        "java" => extract_java(content),
        "rust" => extract_rust(content),
        "cpp" => extract_cpp(content),
        "csharp" => extract_csharp(content),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsts_basic() {
        let code = "import { a } from './foo';\nexport * from \"./bar\";\nconst x = require('./baz');\nawait import('./qux');\n";
        assert_eq!(
            extract_imports("jsts", code),
            vec!["./foo", "./bar", "./baz", "./qux"]
        );
    }

    #[test]
    fn python_basic() {
        let code = "from ..utils import x\nimport os\nfrom . import y\n";
        assert_eq!(
            extract_imports("python", code),
            vec!["..utils", "os", "."]
        );
    }

    #[test]
    fn go_single_and_block() {
        let code = "import \"fmt\"\nimport (\n\t\"os\"\n\t\"github.com/a/b\"\n)\n";
        assert_eq!(
            extract_imports("go", code),
            vec!["fmt", "os", "github.com/a/b"]
        );
    }

    #[test]
    fn java_static_and_plain() {
        let code = "import com.example.Foo;\nimport static com.example.Bar.baz;\n";
        assert_eq!(
            extract_imports("java", code),
            vec!["com.example.Foo", "com.example.Bar.baz"]
        );
    }

    #[test]
    fn rust_mod_then_use() {
        let code = "pub mod foo;\nmod bar;\nuse crate::a::b;\nuse super::c;\n";
        assert_eq!(
            extract_imports("rust", code),
            vec!["mod:foo", "mod:bar", "use:crate::a::b", "use:super::c"]
        );
    }

    #[test]
    fn cpp_quoted_only() {
        let code = "#include \"local.h\"\n#include <vector>\n# include \"a/b.hpp\"\n";
        assert_eq!(extract_imports("cpp", code), vec!["local.h", "a/b.hpp"]);
    }

    #[test]
    fn csharp_excludes_static_global() {
        let code = "using System.Collections;\nusing static System.Math;\nglobal using System.Linq;\nusing Alias = System.Text;\n";
        assert_eq!(
            extract_imports("csharp", code),
            vec!["System.Collections", "System.Text"]
        );
    }

    #[test]
    fn csharp_keeps_namespace_with_keyword_prefix() {
        // `staticFoo` / `globalBar` are real namespaces, not the static/global
        // keyword (which the TS lookahead requires be followed by whitespace).
        let code = "using staticFoo.Bar;\nusing globalBar.Baz;\n";
        assert_eq!(
            extract_imports("csharp", code),
            vec!["staticFoo.Bar", "globalBar.Baz"]
        );
    }

    #[test]
    fn unknown_kind_empty() {
        assert!(extract_imports("kotlin", "import x").is_empty());
    }
}
