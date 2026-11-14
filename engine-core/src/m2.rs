//! M2 — fs/scan/hash/archive команды для Electron Win7/8 порта.
//!
//! Реализует те же tauri-команды mainline commands.rs, но БЕЗ tauri:
//! вызываются из JSON-RPC диспетчера по имени команды (get_path_info,
//! scan_and_hash, sha256_file, create_archive, extract_archive, ...).
//!
//! ВАЖНО про stdout: firmware-core `hash::sha256_file` и `scanner::scan_and_hash`
//! печатают `println!("DEBUG: ...")` в stdout (см. M0-отчёт) — это ломает
//! framed JSON-RPC. Поэтому:
//!   * чистые функции firmware-core (`get_path_info`, `archive::*`) — зовём напрямую;
//!   * sha256/scan — тихие локальные аналоги (тот же алгоритм/фильтры), плюс
//!     сверка с firmware-core в юнит-тестах (см. main.rs tests).
//!
//! Все функции возвращают serde-значения (уже готовые для JSON-ответа).

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use firmware_core::archive::ArchiveContainer;
use firmware_core::manifest::{PathInfo, ScanResult, TargetFile};

/// Расширения, которые считаются целевыми (прошивки) — как в mainline scanner.rs.
const TARGET_EXTENSIONS: &[&str] = &[
    "bin", "img", "fw", "pkg", "rom", "dump",
    "emmc", "nand", "spi", "ubifs", "squashfs",
];

/// Расширения, которые пропускаем при тяжёлом хэшировании.
const SKIP_HASH_EXTENSIONS: &[&str] = &[
    "txt", "pdf", "jpg", "jpeg", "png", "gif",
    "doc", "docx", "url", "html", "htm", "md",
];

fn is_target_file(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    if let Some(ext) = p.extension() {
        let e = ext.to_string_lossy().to_lowercase();
        TARGET_EXTENSIONS.contains(&e.as_str())
    } else {
        false
    }
}

fn should_skip_hash(p: &Path) -> bool {
    if let Some(ext) = p.extension() {
        let e = ext.to_string_lossy().to_lowercase();
        SKIP_HASH_EXTENSIONS.contains(&e.as_str())
    } else {
        false
    }
}

/// Тихий потоковый sha256 (без println). Тот же алгоритм, что firmware-core.
fn quiet_sha256_file(path: &Path) -> anyhow::Result<String> {
    let file = fs::File::open(path)
        .map_err(|e| anyhow::anyhow!("Failed to open {}: {}", path.display(), e))?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────────────────────────────────────
// scan_and_hash (тихий аналог firmware_core::scanner::scan_and_hash)
// ─────────────────────────────────────────────────────────────────────────────

fn scan_and_hash_quiet(path: &str, is_directory: bool) -> anyhow::Result<ScanResult> {
    let p = Path::new(path);
    if !p.exists() {
        anyhow::bail!("Path does not exist: {}", path);
    }

    let mut files: Vec<TargetFile> = Vec::new();

    if is_directory {
        let entries: Vec<_> = WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .collect();

        for entry in entries {
            let rel_path = entry
                .path()
                .strip_prefix(p)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();

            let is_target = is_target_file(entry.path());
            let skip_hash = should_skip_hash(entry.path());
            let size = entry.metadata()?.len();

            let sha256 = if is_target && !skip_hash {
                quiet_sha256_file(entry.path())?
            } else {
                String::new()
            };

            let kind = if is_target { "firmware" } else { "other" };

            files.push(TargetFile {
                path: rel_path,
                size,
                sha256,
                kind: kind.to_string(),
            });
        }
    } else {
        // BUG-SHA256-001/Ф3: одиночный файл хэшируем всегда (паритет с
        // firmware-core scanner.rs) — иначе .7z/.zip уходят с пустым sha и
        // сервер оставляет byte_sha256 пустым (fail-open, кейс file 35).
        let is_target = is_target_file(p);
        let size = fs::metadata(p)?.len();
        let sha256 = quiet_sha256_file(p)?;
        let fname = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        files.push(TargetFile {
            path: fname,
            size,
            sha256,
            kind: if is_target { "firmware".into() } else { "other".into() },
        });
    }

    // Bundle SHA256 = SHA256 суммы имён + размеров + хэшей (как в mainline).
    let mut bundle_hasher = Sha256::new();
    for f in &files {
        bundle_hasher.update(f.path.as_bytes());
        bundle_hasher.update(&f.size.to_le_bytes());
        bundle_hasher.update(f.sha256.as_bytes());
    }
    let bundle_sha256 = hex::encode(bundle_hasher.finalize());
    let total_size: u64 = files.iter().map(|f| f.size).sum();

    Ok(ScanResult {
        files,
        total_size,
        bundle_sha256,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Диспетчер M2-команд
// ─────────────────────────────────────────────────────────────────────────────

/// Выполнить M2-команду. Возвращает JSON-значение результата или Err(String).
pub fn dispatch(cmd: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    match cmd {
        "get_path_info" => {
            let path = str_param(params, "path")?;
            let info: PathInfo =
                firmware_core::scanner::get_path_info(path).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
        }

        "scan_and_hash" => {
            let path = str_param(params, "path")?;
            let is_dir = bool_param(params, "is_directory")?;
            let res = scan_and_hash_quiet(path, is_dir).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(res).map_err(|e| e.to_string())?)
        }

        "sha256_file" => {
            let path = str_param(params, "path")?;
            let sha = quiet_sha256_file(Path::new(path)).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "sha256": sha, "path": path }))
        }

        "peek_file_header" => {
            let path = str_param(params, "path")?;
            let n = u64_param(params, "n")? as usize;
            let file =
                fs::File::open(path).map_err(|e| format!("Failed to open {path}: {e}"))?;
            let mut buf = Vec::with_capacity(n);
            file.take(n as u64)
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read {path}: {e}"))?;
            Ok(serde_json::json!(buf)) // массив байт (как Vec<u8> в tauri)
        }

        "read_file_bytes" => {
            let path = str_param(params, "path")?;
            let data = fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
            Ok(serde_json::json!(data))
        }

        "write_file_bytes" => {
            let path = str_param(params, "path")?;
            let data = bytes_param(params, "data")?;
            if let Some(parent) = Path::new(path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create dir: {e}"))?;
            }
            fs::write(path, &data).map_err(|e| format!("Failed to write {path}: {e}"))?;
            Ok(serde_json::json!(null))
        }

        "write_file_chunk" => {
            let path = str_param(params, "path")?;
            let data = bytes_param(params, "data")?;
            let is_first = bool_param(params, "is_first")?;
            if is_first {
                if let Some(parent) = Path::new(path).parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create dir: {e}"))?;
                }
                fs::write(path, &data).map_err(|e| format!("Failed to write {path}: {e}"))?;
            } else {
                let mut file = fs::OpenOptions::new()
                    .append(true)
                    .open(path)
                    .map_err(|e| format!("Failed to open {path}: {e}"))?;
                file.write_all(&data)
                    .map_err(|e| format!("Failed to append to {path}: {e}"))?;
            }
            Ok(serde_json::json!(null))
        }

        "rename_file" => {
            let from = str_param(params, "from")?;
            let to = str_param(params, "to")?;
            fs::rename(from, to)
                .map_err(|e| format!("Failed to rename {from} -> {to}: {e}"))?;
            Ok(serde_json::json!(null))
        }

        "delete_file" => {
            let path = str_param(params, "path")?;
            let p = Path::new(path);
            if !p.is_absolute() {
                return Err(format!("Path must be absolute: {path}"));
            }
            let meta = match fs::symlink_metadata(p) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!(null)),
                Err(e) => return Err(format!("Failed to stat {path}: {e}")),
            };
            if !meta.file_type().is_file() {
                return Err(format!("Refusing to delete non-regular file: {path}"));
            }
            fs::remove_file(p).map_err(|e| format!("Failed to delete {path}: {e}"))?;
            Ok(serde_json::json!(null))
        }

        "create_archive" => dispatch_pack("create_archive", params, None),
        "pack_archive" => dispatch_pack("pack_archive", params, None),
        "create_tar_zst" => {
            dispatch_pack("create_tar_zst", params, Some(ArchiveContainer::TarZst))
        }

        "extract_archive" => dispatch_unpack("extract_archive", params, None),
        "unpack_archive" => dispatch_unpack("unpack_archive", params, None),
        "extract_tar_zst" => {
            dispatch_unpack("extract_tar_zst", params, Some(ArchiveContainer::TarZst))
        }

        "remove_archive" => {
            let path = str_param(params, "path")?;
            firmware_core::archive::remove_archive(path).map_err(|e| e.to_string())?;
            Ok(serde_json::json!(null))
        }

        "cleanup_stale_archives" => {
            let max_age = u64_param(params, "max_age_secs")?;
            // `include_tdlib_cache` опционален (default false): чистить ли ещё и
            // файловый кеш TDLib. Ставит только стартовый вызов
            // (`JanitorPolicy.buildJanitorRequest`): кеш общий на сессию, и
            // операционный свип снёс бы файлы живого download в другой вкладке.
            let include_cache = params
                .get("include_tdlib_cache")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let n = crate::janitor::sweep(max_age, include_cache);
            Ok(serde_json::json!(n))
        }

        other => Err(format!("unknown M2 command: {other}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Архивные команды (Фаза 3): контейнеры zip | tar.zst
// ─────────────────────────────────────────────────────────────────────────────

/// Троттлинг кадров прогресса архива (см. `tests` — гейты T1–T3).
///
/// Правило: кадр уходит, если (а) он первый, (б) прошло ≥ 200 мс с прошлого,
/// (в) процент вырос хотя бы на 1, (г) это финальный кадр (`processed >= total`).
/// Так полоса остаётся плавной (≥5 fps по времени) и при этом не заливает
/// stdout тысячами кадров на гигабайтном файле (жёсткий потолок — ~101 кадр
/// на операцию: 0…100 % + heartbeat'ы).
///
/// `total == 0` (размер неизвестен) — процент не считается: UI остаётся в
/// неопределённом режиме «⏳», кадры идут только по времени.
struct ArchiveProgressThrottle {
    last_ms: Option<i64>,
    last_pct: Option<u64>,
}

impl ArchiveProgressThrottle {
    fn new() -> Self {
        Self {
            last_ms: None,
            last_pct: None,
        }
    }

    /// `now_ms` — монотонное время ОТ СТАРТА операции.
    fn should_emit(&mut self, processed: u64, total: u64, now_ms: i64) -> bool {
        let pct = if total > 0 {
            processed.saturating_mul(100) / total
        } else {
            0
        };
        let final_frame = total > 0 && processed >= total;
        let due_time = match self.last_ms {
            Some(t) => now_ms.saturating_sub(t) >= 200,
            None => true,
        };
        let due_pct = match self.last_pct {
            Some(p) => pct > p,
            None => true,
        };
        if final_frame || due_time || due_pct {
            self.last_ms = Some(now_ms);
            self.last_pct = Some(pct);
            true
        } else {
            false
        }
    }
}

/// Диспетчер упаковки: `create_archive` / `pack_archive` (`container` из
/// параметров, дефолт ZIP — исторический формат) и `create_tar_zst`
/// (`forced_container` = tar.zst, фасад для явного выбора).
///
/// Параметры: `path`, `is_directory`, `bundle_hash`, опционально `container`
/// (`"zip"` | `"tar_zst"`) и `compression_level`.
///
/// Уровень: диапазон зависит от контейнера (deflate 0-9 / zstd 1-19); значение
/// вне диапазона/мусор → дефолт контейнера (fail-open, как было для ZIP).
fn dispatch_pack(
    method: &str,
    params: &serde_json::Value,
    forced_container: Option<ArchiveContainer>,
) -> Result<serde_json::Value, String> {
    // Штатный путь: кадры прогресса уходят событием `archive-progress` в stdout
    // (Electron main → `fw:event` → вкладка «Архиватор»).
    let mut sink: fn(&str, serde_json::Value) = crate::emit_event;
    dispatch_pack_with(method, params, forced_container, &mut sink)
}

/// Ядро `dispatch_pack` с подменяемым приёмником событий (нужен тестам:
/// перехватить кадры прогресса, не читая stdout).
fn dispatch_pack_with(
    method: &str,
    params: &serde_json::Value,
    forced_container: Option<ArchiveContainer>,
    emit: &mut dyn FnMut(&str, serde_json::Value),
) -> Result<serde_json::Value, String> {
    let path = str_param(params, "path")?;
    let is_dir = bool_param(params, "is_directory")?;
    let hash = str_param(params, "bundle_hash")?;

    let container = forced_container
        .or_else(|| {
            params
                .get("container")
                .and_then(|v| v.as_str())
                .and_then(ArchiveContainer::parse)
        })
        .unwrap_or(ArchiveContainer::Zip);

    let (min_level, max_level) = match container {
        ArchiveContainer::Zip => (0, 9),
        ArchiveContainer::TarZst => (1, 19),
    };
    let level: Option<i32> = params
        .get("compression_level")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .filter(|&n| (min_level..=max_level).contains(&n));

    // Фаза 3 (ручной «Архиватор»): результат можно положить прямо туда, куда
    // выбрал пользователь. Без явного пути пишем в temp — как при upload
    // (там temp нужен для cleanup после отправки).
    let output_path: Option<&str> = params.get("output_path").and_then(|v| v.as_str());

    // BUG-M2-RPC-TIMEOUT-001: архивация может идти минуты — без метки в stderr
    // разбор «RPC error» на стороне клиента слепой (engine-core.log).
    let started = std::time::Instant::now();
    eprintln!(
        "m2[{method}]: start path={path} is_directory={is_dir} hash12={} container={} level={:?} output={}",
        hash.get(..12).unwrap_or(hash),
        container.as_str(),
        level,
        output_path.unwrap_or("<temp>")
    );
    // Кадры прогресса: троттлинг здесь (движок), НЕ в UI — иначе stdout
    // получает кадр на каждое чтение буфера (десятки тысяч на гигабайт).
    let mut throttle = ArchiveProgressThrottle::new();
    let mut on_progress = |processed: u64, total: u64| {
        let now_ms = started.elapsed().as_millis() as i64;
        if throttle.should_emit(processed, total, now_ms) {
            emit(
                "archive-progress",
                serde_json::json!({
                    "op": "pack",
                    "processed": processed,
                    "total": total,
                }),
            );
        }
    };
    match firmware_core::archive::pack_archive_with_progress(
        path,
        is_dir,
        hash,
        container,
        level,
        output_path,
        &mut on_progress,
    ) {
        Ok(p) => {
            eprintln!(
                "m2[{method}]: done in {:.1}s (container={}) → {p}",
                started.elapsed().as_secs_f64(),
                container.as_str()
            );
            // Возвращаем и путь, и контейнер: клиент пишет `container` в
            // манифест/лог, не угадывая формат по расширению.
            Ok(serde_json::json!(p))
        }
        Err(e) => {
            eprintln!(
                "m2[{method}]: FAILED after {:.1}s: {e}",
                started.elapsed().as_secs_f64()
            );
            Err(e.to_string())
        }
    }
}

/// Диспетчер распаковки: `extract_archive` / `unpack_archive` (контейнер
/// определяется по magic/имени) и `extract_tar_zst` (`forced_container`).
///
/// Параметры: `archive_path`, `output_dir`. Возвращает объект
/// `{ "container": "zip" | "tar_zst" }` — клиент логирует распознанный формат.
fn dispatch_unpack(
    method: &str,
    params: &serde_json::Value,
    forced_container: Option<ArchiveContainer>,
) -> Result<serde_json::Value, String> {
    let mut sink: fn(&str, serde_json::Value) = crate::emit_event;
    dispatch_unpack_with(method, params, forced_container, &mut sink)
}

/// Ядро `dispatch_unpack` с подменяемым приёмником событий (тесты).
fn dispatch_unpack_with(
    method: &str,
    params: &serde_json::Value,
    forced_container: Option<ArchiveContainer>,
    emit: &mut dyn FnMut(&str, serde_json::Value),
) -> Result<serde_json::Value, String> {
    let archive_path = str_param(params, "archive_path")?;
    let output_dir = str_param(params, "output_dir")?;
    let started = std::time::Instant::now();

    // Фасад extract_tar_zst: до распаковки убеждаемся, что внутри zstd — иначе
    // честная ошибка (чужой контейнер молча не «съедаем»).
    if let Some(forced) = forced_container {
        let detected = firmware_core::archive::detect_container(archive_path)
            .map_err(|e| e.to_string())?;
        if detected != forced {
            return Err(format!(
                "{method}: archive container is {}, expected {}",
                detected.as_str(),
                forced.as_str()
            ));
        }
    }

    eprintln!("m2[{method}]: start {archive_path} → {output_dir}");
    let mut throttle = ArchiveProgressThrottle::new();
    let mut on_progress = |processed: u64, total: u64| {
        let now_ms = started.elapsed().as_millis() as i64;
        if throttle.should_emit(processed, total, now_ms) {
            emit(
                "archive-progress",
                serde_json::json!({
                    "op": "unpack",
                    "processed": processed,
                    "total": total,
                }),
            );
        }
    };
    match firmware_core::archive::unpack_archive_with_progress(
        archive_path,
        output_dir,
        &mut on_progress,
    ) {
        Ok(container) => {
            eprintln!(
                "m2[{method}]: done in {:.1}s (container={})",
                started.elapsed().as_secs_f64(),
                container.as_str()
            );
            Ok(serde_json::json!({ "container": container.as_str() }))
        }
        Err(e) => {
            eprintln!(
                "m2[{method}]: FAILED after {:.1}s: {e}",
                started.elapsed().as_secs_f64()
            );
            Err(e.to_string())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Хелперы параметров (принимают snake_case; main может слать camelCase →
// нормализация в electron/main.ts)
// ─────────────────────────────────────────────────────────────────────────────

fn str_param<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("param '{key}' (string) required"))
}

fn bool_param(params: &serde_json::Value, key: &str) -> Result<bool, String> {
    params
        .get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("param '{key}' (bool) required"))
}

fn u64_param(params: &serde_json::Value, key: &str) -> Result<u64, String> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("param '{key}' (u64) required"))
}

/// Байты из JSON: принимаем массив чисел (serde_json Number), как Vec<u8> в tauri.
/// Electron main перед вызовом конвертирует Uint8Array/ArrayBuffer в массив чисел.
fn bytes_param(params: &serde_json::Value, key: &str) -> Result<Vec<u8>, String> {
    let v = params
        .get(key)
        .ok_or_else(|| format!("param '{key}' required"))?;
    if let Some(arr) = v.as_array() {
        let mut out = Vec::with_capacity(arr.len());
        for n in arr {
            let b = n
                .as_u64()
                .ok_or_else(|| format!("param '{key}' must be byte array"))?;
            out.push(b as u8);
        }
        return Ok(out);
    }
    Err(format!("param '{key}' must be byte array"))
}

// ── тесты ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_and_hash_single_file_quiet() {
        let dir = std::env::temp_dir().join("engine-core-m2-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fw.bin");
        std::fs::write(&f, b"abc").unwrap();
        let res = scan_and_hash_quiet(f.to_str().unwrap(), false).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].kind, "firmware");
        assert_eq!(
            res.files[0].sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_single_non_target_ext_still_hashes() {
        // BUG-SHA256-001/Ф3 (RED): одиночный .7z обязан хэшироваться — раньше
        // не-TARGET получал sha256="" и сервер оставлял byte_sha256 пустым.
        let dir = std::env::temp_dir().join("engine-core-m2-nontarget");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fw.7z");
        std::fs::write(&f, b"abc").unwrap();
        let res = scan_and_hash_quiet(f.to_str().unwrap(), false).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].kind, "other", "kind не меняем — только хэш");
        assert_eq!(
            res.files[0].sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "одиночный не-TARGET обязан нести байтовый хэш"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_quiet_matches() {
        // quiet_sha256_file совпадает с firmware_core (без stdout в тесте).
        let dir = std::env::temp_dir().join("engine-core-m2-tests2");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sample.bin");
        std::fs::write(&f, b"FW CLOUD M2 sample\n").unwrap();
        let a = quiet_sha256_file(&f).unwrap();
        let b = firmware_core::hash::sha256_file(&f).unwrap();
        assert_eq!(a, b);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_archive_dispatch_roundtrip() {
        // BUG-M2-RPC-TIMEOUT-001: регрессия стороны sidecar — `create_archive` /
        // `extract_archive` обязаны быть зарегистрированы в dispatch и давать
        // валидный zip → распакованный файл. Клиентская половина фикса
        // (NO_TIMEOUT_MS для долгих M2-команд, а не дефолтные 30с) покрыта
        // tests_upload/test_m2_long_op_rpc_timeout.py.
        let base = std::env::temp_dir().join("engine-core-m2-archive-test");
        let _ = std::fs::remove_dir_all(&base);
        let bundle = base.join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("fw.bin"), b"FW CLOUD M2 archive roundtrip").unwrap();

        let params = serde_json::json!({
            "path": bundle.to_str().unwrap(),
            "is_directory": true,
            "bundle_hash": "0123456789abcdef0123456789abcdef",
        });
        let out = dispatch("create_archive", &params)
            .expect("create_archive must dispatch (метод зарегистрирован в main.rs)");
        let zip_path = out
            .as_str()
            .expect("create_archive returns zip path string")
            .to_string();
        assert!(Path::new(&zip_path).is_file(), "zip not written: {zip_path}");

        // Повторный вызов поверх существующего zip (перезалив той же папки) — не паника.
        dispatch("create_archive", &params).expect("create_archive overwrite must succeed");

        let out_dir = base.join("extracted");
        dispatch(
            "extract_archive",
            &serde_json::json!({
                "archive_path": zip_path,
                "output_dir": out_dir.to_str().unwrap(),
            }),
        )
        .expect("extract_archive must dispatch");
        assert_eq!(
            fs::read_to_string(out_dir.join("fw.bin")).unwrap(),
            "FW CLOUD M2 archive roundtrip"
        );

        let _ = fs::remove_file(&zip_path);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Фаза 3: `pack_archive` с `container=tar_zst` и `unpack_archive` обязаны
    /// быть зарегистрированы в dispatch, давать zstd-контейнер и честно
    /// возвращать распознанный контейнер (клиент пишет это в лог/манифест).
    #[test]
    fn pack_unpack_tar_zst_dispatch_roundtrip() {
        let base = std::env::temp_dir().join("engine-core-m2-tarzst-test");
        let _ = std::fs::remove_dir_all(&base);
        let bundle = base.join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("fw.bin"), b"FW CLOUD M2 tar.zst roundtrip").unwrap();

        let params = serde_json::json!({
            "path": bundle.to_str().unwrap(),
            "is_directory": true,
            "bundle_hash": "feedfacecafebabe",
            "container": "tar_zst",
            "compression_level": 1,
        });
        let out = dispatch("pack_archive", &params)
            .expect("pack_archive must dispatch (метод зарегистрирован в main.rs)");
        let archive = out.as_str().expect("pack_archive returns path").to_string();
        assert!(
            archive.ends_with(".tar.zst"),
            "container=tar_zst должен дать .tar.zst: {archive}"
        );
        // Magic zstd в первых байтах — то, по чему потом детектит download.
        let head = fs::read(&archive).unwrap();
        assert_eq!(&head[..4], &[0x28, 0xb5, 0x2f, 0xfd]);

        let out_dir = base.join("extracted");
        let res = dispatch(
            "unpack_archive",
            &serde_json::json!({
                "archive_path": archive,
                "output_dir": out_dir.to_str().unwrap(),
            }),
        )
        .expect("unpack_archive must dispatch");
        assert_eq!(
            res.get("container").and_then(|v| v.as_str()),
            Some("tar_zst"),
            "unpack_archive обязан вернуть распознанный контейнер"
        );
        assert_eq!(
            fs::read_to_string(out_dir.join("fw.bin")).unwrap(),
            "FW CLOUD M2 tar.zst roundtrip"
        );

        // Фасад extract_tar_zst на ZIP-файле — честная ошибка (не глотаем чужой
        // контейнер), и create_tar_zst всегда даёт zstd независимо от container.
        let zip_path = dispatch(
            "create_archive",
            &serde_json::json!({
                "path": bundle.to_str().unwrap(),
                "is_directory": true,
                "bundle_hash": "0badc0de",
            }),
        )
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
        assert!(zip_path.ends_with(".zip"));
        let err = dispatch(
            "extract_tar_zst",
            &serde_json::json!({
                "archive_path": zip_path,
                "output_dir": base.join("x").to_str().unwrap(),
            }),
        )
        .expect_err("extract_tar_zst обязан отказать на zip-контейнере");
        assert!(err.contains("expected tar_zst"), "неожиданная ошибка: {err}");

        let _ = fs::remove_file(&archive);
        let _ = fs::remove_file(&zip_path);
        let _ = std::fs::remove_dir_all(&base);
    }

    // ── Прогресс «Архиватора» (детерминированная полоса) ────────────────────
    // RED (test-first): кадры прогресса обязаны (1) уходить событием
    // `archive-progress`, (2) нести `op`/`processed`/`total`, (3) троттлиться
    // (не чаще 200 мс или на +1 %, финальный кадр — всегда).

    #[test]
    fn archive_progress_throttle_first_frame_and_percent_step() {
        let mut t = ArchiveProgressThrottle::new();
        // Первый кадр уходит всегда — иначе полоса не появится.
        assert!(t.should_emit(10, 1000, 0), "первый кадр обязан уйти");
        // Тот же процент (1 %) и окно < 200 мс → кадр съедается.
        assert!(
            !t.should_emit(15, 1000, 100),
            "тот же процент внутри 200 мс не должен уходить"
        );
        // +1 % (2 %) → уходит даже внутри окна (плавность полосы).
        assert!(t.should_emit(20, 1000, 100), "+1 % обязан уйти");
        // Тот же процент, но окно истекло (300 мс) → heartbeat уходит.
        assert!(t.should_emit(25, 1000, 400), "по 200 мс кадр обязан уйти");
    }

    #[test]
    fn archive_progress_throttle_forces_final_frame() {
        let mut t = ArchiveProgressThrottle::new();
        assert!(t.should_emit(1000, 1000, 0), "первый/финальный кадр");
        // processed >= total: кадр уходит ВСЕГДА, даже без времени и шага
        // процента — иначе UI не доходит до 100 %.
        assert!(t.should_emit(1000, 1000, 0), "финальный кадр обязан уйти");
    }

    #[test]
    fn archive_progress_throttle_indeterminate_when_total_unknown() {
        let mut t = ArchiveProgressThrottle::new();
        // total=0 (неизвестен) → процент не считается, UI остаётся в «⏳».
        assert!(t.should_emit(5, 0, 0));
        assert!(!t.should_emit(9, 0, 50), "внутри окна кадр съедается");
        assert!(t.should_emit(9, 0, 250), "heartbeat по 200 мс обязан уйти");
    }

    #[test]
    fn pack_and_unpack_emit_archive_progress_events() {
        let base = std::env::temp_dir().join("engine-core-m2-progress-events");
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        // 3 × 300 КиБ: гарантированно несколько чтений → несколько кадров.
        std::fs::write(src.join("a.bin"), vec![1u8; 300 * 1024]).unwrap();
        std::fs::write(src.join("b.bin"), vec![2u8; 300 * 1024]).unwrap();
        std::fs::write(src.join("c.bin"), vec![3u8; 300 * 1024]).unwrap();
        let expected_src_total = 3 * 300 * 1024;

        let events: std::cell::RefCell<Vec<(String, serde_json::Value)>> =
            std::cell::RefCell::new(Vec::new());
        let mut sink = |name: &str, payload: serde_json::Value| {
            events.borrow_mut().push((name.to_string(), payload));
        };
        let archive = dispatch_pack_with(
            "pack_archive",
            &serde_json::json!({
                "path": src.to_str().unwrap(),
                "is_directory": true,
                "bundle_hash": "0a0b0c0d",
            }),
            None,
            &mut sink,
        )
        .expect("pack_archive must dispatch")
        .as_str()
        .expect("pack_archive returns path")
        .to_string();

        assert!(
            !events.borrow().is_empty(),
            "упаковка обязана эмитить кадры прогресса"
        );
        for (name, payload) in events.borrow().iter() {
            assert_eq!(name, "archive-progress", "имя события прогресса");
            assert_eq!(
                payload.get("op").and_then(|v| v.as_str()),
                Some("pack"),
                "op обязан различать упаковку/распаковку"
            );
            assert_eq!(
                payload.get("total").and_then(|v| v.as_u64()),
                Some(expected_src_total),
                "total упаковки = сумма размеров исходников"
            );
        }
        let last = events.borrow().last().unwrap().1.clone();
        assert_eq!(
            last.get("processed").and_then(|v| v.as_u64()),
            Some(expected_src_total),
            "финальный кадр упаковки обязан дойти до total"
        );
        // Троттлинг: кадров не больше, чем шагов по 1 % (+ heartbeat'ы).
        assert!(
            events.borrow().len() <= 120,
            "кадры обязаны троттлиться, пришло {}",
            events.borrow().len()
        );

        events.borrow_mut().clear();
        let out_dir = base.join("out");
        let archive_size = std::fs::metadata(&archive).unwrap().len();
        dispatch_unpack_with(
            "unpack_archive",
            &serde_json::json!({
                "archive_path": archive,
                "output_dir": out_dir.to_str().unwrap(),
            }),
            None,
            &mut sink,
        )
        .expect("unpack_archive must dispatch");

        assert!(
            !events.borrow().is_empty(),
            "распаковка обязана эмитить кадры"
        );
        for (name, payload) in events.borrow().iter() {
            assert_eq!(name, "archive-progress");
            assert_eq!(payload.get("op").and_then(|v| v.as_str()), Some("unpack"));
            assert_eq!(
                payload.get("total").and_then(|v| v.as_u64()),
                Some(archive_size),
                "total распаковки = размер архива (сжатые байты)"
            );
        }
        let last = events.borrow().last().unwrap().1.clone();
        assert_eq!(
            last.get("processed").and_then(|v| v.as_u64()),
            Some(archive_size),
            "финальный кадр распаковки обязан дойти до total"
        );

        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_dir_all(&base);
    }
}
