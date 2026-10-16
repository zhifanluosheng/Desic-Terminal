use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // tauri 的官方 build 步骤（资源处理、Windows manifest 等）保持不动。
    tauri_build::build();

    // 生成 http_bridge_dispatch.rs：单一事实源 = src/ 里的 #[tauri::command] 签名。
    if let Err(e) = generate_dispatch() {
        panic!("http_bridge dispatch codegen failed: {e}");
    }
}

/// 一个 command 的参数：名字 + 类型 + 类别（app/state/普通）。
#[derive(Debug, Clone)]
struct Arg {
    name: String,
    ty: String,
    kind: ArgKind,
}

#[derive(Debug, Clone, PartialEq)]
enum ArgKind {
    App,
    State,
    Normal,
}

/// 一个 command 的完整签名。
#[derive(Debug, Clone)]
struct CommandSig {
    module: String,
    name: String,
    args: Vec<Arg>,
    ret: Option<String>,
    is_async: bool,
}

/// 去掉 // 与 /* */ 注释（lib.rs 里有注释掉的 command，必须排除）。
fn strip_comments(txt: &str) -> String {
    let mut out = String::with_capacity(txt.len());
    let mut chars = txt.chars().peekable();
    let mut in_block = false;
    while let Some(c) = chars.next() {
        if in_block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            chars.next();
            while let Some(&nc) = chars.peek() {
                if nc == '\n' {
                    break;
                }
                chars.next();
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block = true;
            continue;
        }
        out.push(c);
    }
    out
}

/// 从 src/ 递归收集所有 .rs 文件。
fn collect_rs_files(src: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    files.push(path);
                }
            }
        }
    }
    files
}

/// 解析单个文件里的 #[tauri::command] fn 签名。
fn parse_file_commands(path: &Path, src: &Path) -> Vec<CommandSig> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let txt = strip_comments(&raw);
    let mut sigs = Vec::new();
    let mut chars = txt.char_indices().peekable();
    let module = module_of_file(path, src);

    // 逐行扫描，找 #[tauri::command] 后紧跟的 fn。
    let bytes = txt.as_bytes();
    let attr = "#[tauri::command]";
    let mut pos = 0usize;
    while let Some(found) = txt[pos..].find(attr) {
        let attr_start = pos + found;
        let attr_end = attr_start + attr.len();
        // 从属性后开始找 fn
        let after = &txt[attr_end..];
        if let Some(fn_rel) = find_fn_after(after) {
            let fn_start = attr_end + fn_rel;
            if let Some((name, args_str, ret, is_async)) = parse_fn_signature(&txt, fn_start) {
                let args = parse_args(&args_str);
                sigs.push(CommandSig {
                    module: module.clone(),
                    name,
                    args,
                    ret,
                    is_async,
                });
            }
        }
        pos = attr_end;
    }
    let _ = src;
    sigs
}

/// 在给定字符串里找下一个 `fn` 关键字（跳过空白与属性/注释，但这里注释已 strip）。
fn find_fn_after(s: &str) -> Option<usize> {
    let mut it = s.char_indices();
    let mut i = 0usize;
    let bytes = s.as_bytes();
    // 跳过空白与 pub/pub(crate)/async 前缀，直接找 "fn "
    let mut pos = 0usize;
    while pos < bytes.len() {
        if bytes[pos].is_ascii_whitespace() {
            pos += 1;
            continue;
        }
        // 尝试匹配 fn 关键字
        if bytes[pos..].starts_with(b"fn") {
            // 确认是单词边界
            if pos + 2 >= bytes.len() || !(bytes[pos + 2].is_ascii_alphanumeric() || bytes[pos + 2] == b'_') {
                return Some(pos);
            }
        }
        pos += 1;
    }
    let _ = &mut it;
    let _ = i;
    None
}

/// 解析 fn 签名：返回 (name, args_str, ret_str, is_async)。
fn parse_fn_signature(txt: &str, fn_start: usize) -> Option<(String, String, Option<String>, bool)> {
    let after = &txt[fn_start..];
    let bytes = after.as_bytes();
    let mut pos = 0usize;

    // 跳过 "fn"
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    // 现在应该在 fn 之后。找 "async" 前缀（在 fn 之前已处理，但这里防御）
    // 实际 fn_start 指向 "fn"，前面的 async 在调用方判断。这里直接解析 "fn name("
    if !after[pos..].starts_with("fn") {
        return None;
    }
    pos += 2;
    // 跳过空白
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    // 读 name
    let name_start = pos;
    while pos < bytes.len() && (bytes[pos].is_ascii_alphanumeric() || bytes[pos] == b'_') {
        pos += 1;
    }
    let name = &after[name_start..pos];
    // 跳过空白
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    // 读 ( ... ) 参数
    if bytes[pos] != b'(' {
        return None;
    }
    let paren_start = pos;
    let mut depth = 0i32;
    let mut args_end = pos;
    while pos < bytes.len() {
        match bytes[pos] {
            b'(' => {
                depth += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    args_end = pos;
                    pos += 1;
                    break;
                }
            }
            _ => {}
        }
        pos += 1;
    }
    let args_str = after[paren_start + 1..args_end].to_string();
    // 读 -> Ret
    let mut ret = None;
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if bytes[pos..].starts_with(b"->") {
        pos += 2;
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        let ret_start = pos;
        while pos < bytes.len() && bytes[pos] != b'{' && bytes[pos] != b';' {
            pos += 1;
        }
        ret = Some(after[ret_start..pos].trim().to_string());
    }
    // 判断 async：fn_start 之前是否有 "async"
    let prefix = &txt[..fn_start];
    let is_async = prefix.trim_end().ends_with("async");

    Some((name.to_string(), args_str, ret, is_async))
}

/// 解析参数字符串为 Vec<Arg>。
fn parse_args(args_str: &str) -> Vec<Arg> {
    let mut args = Vec::new();
    // 按逗号切分（这里参数类型不含逗号嵌套的复杂泛型，除了 Option<Vec<String>> 这类，
    // 但逗号只在顶层切分是安全的，因为泛型内部逗号也会被误切。改用深度扫描切分。）
    let mut depth = 0i32;
    let mut cur = String::new();
    for c in args_str.chars() {
        match c {
            '<' => {
                depth += 1;
                cur.push(c);
            }
            '>' => {
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                let seg = cur.trim().to_string();
                if !seg.is_empty() {
                    if let Some(a) = parse_one_arg(&seg) {
                        args.push(a);
                    }
                }
                cur = String::new();
            }
            _ => cur.push(c),
        }
    }
    let seg = cur.trim().to_string();
    if !seg.is_empty() {
        if let Some(a) = parse_one_arg(&seg) {
            args.push(a);
        }
    }
    args
}

fn parse_one_arg(seg: &str) -> Option<Arg> {
    let seg = seg.trim();
    if seg.is_empty() {
        return None;
    }
    // 找最外层 : 分隔 name:type
    if let Some(colon) = find_top_level_colon(seg) {
        let name = seg[..colon].trim().to_string();
        let name = name.strip_prefix("mut ").unwrap_or(&name).to_string();
        let ty = seg[colon + 1..].trim().to_string();
        let kind = classify_arg(&ty);
        return Some(Arg { name, ty, kind });
    }
    None
}

fn find_top_level_colon(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'<' => depth += 1,
            b'>' => depth -= 1,
            b':' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

fn classify_arg(ty: &str) -> ArgKind {
    if ty == "tauri::AppHandle" {
        ArgKind::App
    } else if ty.starts_with("tauri::State<") {
        ArgKind::State
    } else {
        ArgKind::Normal
    }
}

/// 从 State<'_, X> 提取内部类型 X。
fn state_inner(ty: &str) -> String {
    let open = ty.find('<').unwrap_or(0);
    let close = ty.rfind('>').unwrap_or(ty.len());
    let inner = &ty[open + 1..close];
    inner.trim().trim_start_matches("'_,").trim().trim_start_matches("'_,").trim().to_string()
}

/// camelCase 转换：snake_case -> camelCase（tauri invoke 的 key 约定）。
fn to_camel(s: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in s.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// 生成 dispatch 源文件。
fn generate_dispatch() -> Result<(), String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?;
    let src = Path::new(&manifest_dir).join("src");
    let out_path = src.join("http_bridge_dispatch.rs");

    // 1. 收集所有 command 签名。
    let files = collect_rs_files(&src);
    let mut sig_map: BTreeMap<String, CommandSig> = BTreeMap::new();
    for f in &files {
        for sig in parse_file_commands(f, &src) {
            sig_map.insert(sig.name.clone(), sig);
        }
    }

    // 2. 宏生成的 derivatives command（正则解析不到，硬编码）。
    let derivatives = [
        "intelligence_derivatives_overview",
        "intelligence_derivatives_positioning",
        "intelligence_derivatives_taker_flow",
        "intelligence_derivatives_crowding",
        "intelligence_derivatives_funding_basis",
        "intelligence_derivatives_liquidations",
        "intelligence_derivatives_system_risk",
        "intelligence_derivatives_position_tiers",
    ];
    for name in derivatives {
        if !sig_map.contains_key(name) {
            sig_map.insert(
                name.to_string(),
                CommandSig {
                    module: "crate::intelligence".to_string(),
                    name: name.to_string(),
                    args: vec![
                        Arg {
                            name: "app".to_string(),
                            ty: "tauri::AppHandle".to_string(),
                            kind: ArgKind::App,
                        },
                        Arg {
                            name: "query".to_string(),
                            ty: "DerivativesQuery".to_string(),
                            kind: ArgKind::Normal,
                        },
                    ],
                    ret: Some("Result<IntelligenceResponse, String>".to_string()),
                    is_async: true,
                },
            );
        }
    }

    // 3. 只保留 generate_handler! 里实际注册的命令。
    let lib_path = src.join("lib.rs");
    let lib_raw = fs::read_to_string(&lib_path).map_err(|e| e.to_string())?;
    let lib_txt = strip_comments(&lib_raw);
    let registered = parse_registered_commands(&lib_txt);
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut ordered: Vec<String> = Vec::new();
    for name in registered {
        let bare = name.rsplit("::").next().unwrap_or(&name).to_string();
        if sig_map.contains_key(&bare) {
            if used.insert(bare.clone()) {
                ordered.push(bare);
            }
        }
    }

    // 3.5 建立类型索引。
    let type_index = build_type_index(&src);

    // 4. 生成 match arm。
    let mut body = String::new();
    let mut problems = Vec::new();
    for name in &ordered {
        match sig_map.get(name) {
            Some(sig) => {
                body.push_str(&gen_arm(sig, &type_index));
            }
            None => problems.push(name.clone()),
        }
    }

    // 5. 写文件（内容未变化则不重写，避免无谓重编译）。
    let header = format!(
        "// AUTO-GENERATED by build.rs — do not edit by hand.\n\
         // Command dispatch table: command name -> real command function call.\n\
         // Regenerate by running cargo build (build.rs runs automatically).\n\n\
         /// Dispatch a command by name using the shared AppHandle + parsed JSON body.\n\
         pub async fn dispatch_command(\n\
         \x20   app: &tauri::AppHandle,\n\
         \x20   command: &str,\n\
         \x20   body: &serde_json::Map<String, serde_json::Value>,\n\
         ) -> Result<serde_json::Value, String> {{\n\
         \x20   use super::*;\n\
         \x20   use tauri::Manager;\n\
         \x20   let _ = app;\n\
         \x20   match command {{\n"
    );
    let footer = format!("        _ => Err(format!(\"unknown command: {{command}}\")),\n    }}\n}}\n");
    let content = format!("{header}{body}{footer}");

    if fs::read_to_string(&out_path).map(|old| old == content).unwrap_or(false) {
        // 未变化，跳过写。
        return Ok(());
    }
    fs::write(&out_path, content).map_err(|e| e.to_string())?;
    println!("cargo:rerun-if-changed={}", lib_path.display());
    println!("cargo:rerun-if-changed=src");
    if !problems.is_empty() {
        eprintln!("PROBLEM: registered but unresolved commands: {:?}", problems);
    }
    println!("cargo:warning=http_bridge dispatch codegen wrote {} arms", ordered.len());
    Ok(())
}

/// 从文件路径推导模块路径：lib.rs -> crate，foo.rs -> crate::foo，foo/bar.rs -> crate::foo::bar。
fn module_of_file(path: &Path, src: &Path) -> String {
    let rel = path.strip_prefix(src).unwrap_or(path);
    let rel = rel.to_string_lossy().replace('\\', "/");
    let rel = rel.trim_end_matches(".rs");
    if rel == "lib" {
        "crate".to_string()
    } else if let Some(idx) = rel.rfind('/') {
        let modname = &rel[idx + 1..];
        let parent = &rel[..idx];
        if parent.is_empty() {
            format!("crate::{modname}")
        } else {
            format!("crate::{}::{}", parent.replace('/', "::"), modname)
        }
    } else {
        format!("crate::{rel}")
    }
}

/// 从 crate 的 Cargo.toml 读 package name（含 desic- 前缀），转下划线。
fn read_crate_name(crate_dir: &Path) -> Option<String> {
    let toml_path = crate_dir.join("Cargo.toml");
    let txt = fs::read_to_string(toml_path).ok()?;
    for line in txt.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("name = ") {
            let name = rest.trim().trim_matches('"').replace('-', "_");
            return Some(name);
        }
    }
    None
}

/// 建立类型索引：类型名 -> 完整限定路径（本 crate 模块 + workspace crate）。
fn build_type_index(src: &Path) -> BTreeMap<String, String> {
    let mut index: BTreeMap<String, String> = BTreeMap::new();
    // 本 crate 各模块。
    for f in collect_rs_files(src) {
        let module = module_of_file(&f, src);
        let raw = fs::read_to_string(&f).unwrap_or_default();
        let txt = strip_comments(&raw);
        for name in regex_pub_types(&txt) {
            let path = if module == "crate" {
                name.clone()
            } else {
                format!("{module}::{name}")
            };
            index.insert(name, path);
        }
    }
    // workspace 各 crate。
    if let Ok(manifest_dir) = env::var("CARGO_MANIFEST_DIR") {
        let crates_root = Path::new(&manifest_dir).join("crates");
        if let Ok(entries) = fs::read_dir(&crates_root) {
            for entry in entries.flatten() {
                let crate_dir = entry.path();
                if !crate_dir.is_dir() {
                    continue;
                }
                let crate_path = read_crate_name(&crate_dir).unwrap_or_else(|| {
                    crate_dir.file_name().and_then(|n| n.to_str()).unwrap_or("").replace('-', "_")
                });
                let src_dir = crate_dir.join("src");
                for f in collect_rs_files(&src_dir) {
                    let raw = fs::read_to_string(&f).unwrap_or_default();
                    let txt = strip_comments(&raw);
                    for name in regex_pub_types(&txt) {
                        index.insert(name.clone(), format!("{crate_path}::{name}"));
                    }
                }
            }
        }
    }
    index
}

/// 提取一段文本里所有 pub struct / pub enum / pub type 的类型名。
fn regex_pub_types(txt: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in txt.lines() {
        let t = line.trim();
        let stripped = t
            .strip_prefix("pub struct ")
            .or_else(|| t.strip_prefix("pub enum "))
            .or_else(|| t.strip_prefix("pub type "))
            .or_else(|| t.strip_prefix("pub(crate) struct "))
            .or_else(|| t.strip_prefix("pub(crate) enum "))
            .or_else(|| t.strip_prefix("pub(crate) type "));
        if let Some(rest) = stripped {
            let name = rest
                .split(|c: char| c == '<' || c == '{' || c == '(' || c == ';' || c == '=' || c == ' ')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !name.is_empty() && name.chars().next().map_or(false, |c| c.is_ascii_uppercase()) {
                out.push(name);
            }
        }
    }
    out
}

/// 对参数类型做全限定：替换裸类型名为完整路径。
fn qualify_type(ty: &str, type_index: &BTreeMap<String, String>) -> String {
    let mut result = ty.to_string();
    let mut names: Vec<&String> = type_index.keys().collect();
    names.sort_by(|a, b| b.len().cmp(&a.len()));
    for name in names {
        let path = &type_index[name];
        result = replace_word(&result, name, path);
    }
    result
}

/// 简单单词边界替换：把 ty 中独立的 name 替换为 path（不引 regex crate）。
fn replace_word(ty: &str, name: &str, path: &str) -> String {
    let mut out = String::with_capacity(ty.len());
    let bytes = ty.as_bytes();
    let n = name.len();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(name.as_bytes()) {
            let before_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            let after_idx = i + n;
            let after_ok = after_idx >= bytes.len() || !(bytes[after_idx].is_ascii_alphanumeric() || bytes[after_idx] == b'_');
            if before_ok && after_ok {
                out.push_str(path);
                i += n;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// 解析 generate_handler! 里的命令名单（保序）。
fn parse_registered_commands(lib_txt: &str) -> Vec<String> {
    let mut out = Vec::new();
    let marker = "generate_handler![";
    if let Some(pos) = lib_txt.find(marker) {
        let after = &lib_txt[pos + marker.len()..];
        // 找匹配的 ] （简单：handler 块内无嵌套 ]）
        if let Some(end) = after.find(']') {
            let block = &after[..end];
            for line in block.lines() {
                let t = line.trim().trim_end_matches(',');
                if t.is_empty() || t == "]" {
                    continue;
                }
                out.push(t.to_string());
            }
        }
    }
    out
}

/// 生成单个 command 的 match arm。
fn gen_arm(sig: &CommandSig, type_index: &BTreeMap<String, String>) -> String {
    let name = &sig.name;
    let mut prelude = String::new();
    let mut call_args: Vec<String> = Vec::new();

    for (idx, a) in sig.args.iter().enumerate() {
        match a.kind {
            ArgKind::App => {
                call_args.push("app.clone()".to_string());
            }
            ArgKind::State => {
                let inner = qualify_type(&state_inner(&a.ty), type_index);
                call_args.push(format!("app.state::<{inner}>()"));
            }
            ArgKind::Normal => {
                let vname = if a.name.is_empty() {
                    format!("arg_{idx}")
                } else {
                    a.name.clone()
                };
                let key = if a.name.is_empty() {
                    name.clone()
                } else {
                    to_camel(&a.name)
                };
                let ty = qualify_type(&a.ty, type_index);
                if ty.starts_with("Option<") {
                    let inner = &ty[7..ty.len() - 1];
                    prelude.push_str(&format!(
                        "            let {vname}: Option<{inner}> = body.get(\"{key}\").map(|v| serde_json::from_value(v.clone())).transpose().map_err(|e| e.to_string())?.unwrap_or(None);\n"
                    ));
                } else {
                    prelude.push_str(&format!(
                        "            let {vname}: {ty} = body.get(\"{key}\").cloned().ok_or_else(|| format!(\"missing required key {key}\")).and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;\n"
                    ));
                }
                call_args.push(vname);
            }
        }
    }

    // 决定调用路径：lib.rs 里的命令裸名，子模块命令 crate::module::name。
    let full_path = if sig.module == "crate" {
        name.clone()
    } else {
        format!("{}::{}", sig.module, name)
    };
    let call = format!("{full_path}({})", call_args.join(", "));
    let call = if sig.is_async {
        format!("({call}).await")
    } else {
        call
    };

    let ret = sig.ret.as_deref().unwrap_or("");
    let result_body = if ret.starts_with("Result<") {
        format!(
            "            let _res = {call};\n\
             \x20           match _res {{\n\
             \x20               Ok(v) => serde_json::to_value(&v).map_err(|e| e.to_string()),\n\
             \x20               Err(e) => Err(e.to_string()),\n\
             \x20           }}\n"
        )
    } else {
        format!(
            "            let _res = {call};\n\
             \x20           serde_json::to_value(&_res).map_err(|e| e.to_string())\n"
        )
    };

    format!(
        "        \"{name}\" => {{\n{prelude}{result_body}        }}\n"
    )
}
