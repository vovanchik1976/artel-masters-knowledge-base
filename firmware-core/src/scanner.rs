/// Сканирование директории/файла, фильтрация по расширениям,
/// параллельное SHA256-хэширование целевых файлов.

use std::fs;
use std::path::Path;

use rayon::prelude::*;
use sha2::Digest;
use walkdir::WalkDir;

use crate::hash;
use crate::manifest::{PathInfo, ScanResult, TargetFile};

/// Расширения, которые считаются целевыми (прошивки)
const TARGET_EXTENSIONS: &[&str] = &[
    "bin", "img", "fw", "pkg", "rom", "dump",
    "emmc", "nand", "spi", "ubifs", "squashfs",
];

/// Расширения, которые пропускаем при тяжёлом хэшировании
const SKIP_HASH_EXTENSIONS: &[&str] = &[
    "txt", "pdf", "jpg", "jpeg", "png", "gif",
    "doc", "docx", "url", "html", "htm", "md",
];

fn is_target_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        TARGET_EXTENSIONS.contains(&ext_str.as_str())
    } else {
        false
    }
}

fn should_skip_hash(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        SKIP_HASH_EXTENSIONS.contains(&ext_str.as_str())
    } else {
        false
    }
}

/// Получить информацию о файле/папке (размер, имя, is_dir)
pub fn get_path_info(path: &str) -> anyhow::Result<PathInfo> {
    let p = Path::new(path);
    if !p.exists() {
        anyhow::bail!("Path does not exist: {}", path);
    }

    let metadata = fs::metadata(p)?;
    let is_dir = metadata.is_dir();

    let size = if is_dir {
        WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| fs::metadata(e.path()).ok())
            .map(|m| m.len())
            .sum()
    } else {
        metadata.len()
    };

    Ok(PathInfo {
        size,
        is_dir,
        name: p.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
    })
}

/// Сканирование и хэширование файлов
///
/// Если `is_directory == true` — рекурсивный обход с параллельным хэшированием.
/// Если `false` — хэшируется один файл.
pub fn scan_and_hash(path: &str, is_directory: bool) -> anyhow::Result<ScanResult> {
    let p = Path::new(path);
    if !p.exists() {
        anyhow::bail!("Path does not exist: {}", path);
    }

    let mut files: Vec<TargetFile> = Vec::new();

    if is_directory {
        // Рекурсивный обход папки
        let entries: Vec<_> = WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .collect();

        // Параллельное хэширование через rayon
        let results: Vec<anyhow::Result<TargetFile>> = entries
            .par_iter()
            .map(|entry| {
                let rel_path = entry.path().strip_prefix(p)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .to_string();

                let is_target = is_target_file(entry.path());
                let skip_hash = should_skip_hash(entry.path());
                let size = entry.metadata()?.len();

                let sha256 = if is_target && !skip_hash {
                    hash::sha256_file(entry.path())?
                } else {
                    String::new()
                };

                let kind = if is_target { "firmware" } else { "other" };

                Ok(TargetFile {
                    path: rel_path,
                    size,
                    sha256,
                    kind: kind.to_string(),
                })
            })
            .collect();

        for result in results {
            files.push(result?);
        }
    } else {
        // Один файл (BUG-SHA256-001/Ф3): хэшируем ВСЕГДА, независимо от расширения.
        // Раньше не-TARGET (.7z/.zip/.rar/без расширения) получали sha256="" →
        // серверный manifest_byte_sha256() возвращал None → byte_sha256 пуст →
        // скачивание шло без проверки (fail-open). kind/is_target при этом НЕ
        // меняем: классификация firmware/other влияет на UI и дедуп-логику,
        // меняется только заполнение хэша.
        let is_target = is_target_file(p);
        let size = fs::metadata(p)?.len();

        let sha256 = hash::sha256_file(p)?;

        let fname = p.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        files.push(TargetFile {
            path: fname,
            size,
            sha256,
            kind: if is_target { "firmware".into() } else { "other".into() },
        });
    }

    // Bundle SHA256 = SHA256 суммы всех имён + размеров + хэшей
    let mut bundle_hasher = sha2::Sha256::new();
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
