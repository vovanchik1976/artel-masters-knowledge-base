// Линковка libtdjson (TDLib JSON FFI) — как в mainline desktop/src-tauri/build.rs.
//
// Linux/dev: pkg-config находит /usr/local/lib/libtdjson.so (уже установлен).
// Windows (CI, позже): импорт-лист libtdjson.dll.a из репозитория (MinGW).
/// Версия TDLib из pkg-config-файла `.pc` (строка `Version:`).
fn parse_pc_version(pc: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(pc).ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Version:") {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();

    if target.contains("windows") {
        let manifest_dir =
            std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        // Собственные TDLib-артефакты продукта: windows-x64 / windows-x86 (независимо от Tauri-клиента).
        let arch_dir = if target.contains("i686") { "windows-x86" } else { "windows-x64" };
        let tdlib_dir = manifest_dir.join("tdlib").join(arch_dir);

        // Версия TDLib-бандла (compile-time) → fallback выбора формата
        // setTdlibParameters, если рантайм-опрос getOption("version") не удался.
        // ВАЖНО: версии бандлов РАЗНЫЕ (x86 = 1.8.61, x64 = 1.8.65) — см. VERSION.
        let version = std::fs::read_to_string(tdlib_dir.join("VERSION"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| parse_pc_version(&tdlib_dir.join("tdjson.pc")))
            .unwrap_or_else(|| "unknown".to_string());
        println!("cargo:rustc-env=TDLIB_BUNDLE_VERSION={version}");

        if tdlib_dir.exists() {
            println!("cargo:rustc-link-search=native={}", tdlib_dir.display());
            println!("cargo:rustc-link-lib=dylib=tdjson");
        } else {
            println!("cargo:warning=TDLib не найден: {} — сборка tdlib для этой архитектуры не выполнена", tdlib_dir.display());
        }
        return;
    }

    // Linux / прочие: pkg-config должен находить libtdjson.
    match pkg_config::Config::new().atleast_version("1.8").probe("tdjson") {
        Ok(lib) => {
            println!("cargo:rustc-env=TDLIB_BUNDLE_VERSION={}", lib.version);
        }
        Err(e) => {
            println!("cargo:rustc-env=TDLIB_BUNDLE_VERSION=unknown");
            println!(
                "cargo:warning=TDLib JSON FFI: pkg-config tdjson not found: {}. \
                 TDLib runtime будет недоступен. Установите libtdjson (scripts/build_tdlib.sh).",
                e
            );
        }
    }
}
