//! tar.zst — скоростной контейнер (Фаза 3, BUG-SMART-SINGLE-UPLOAD-003).
//!
//! Почему второй контейнер (рядом с ZIP):
//! - **скорость+размер**: zstd даёт заметно лучший ratio, чем deflate, при
//!   сравнимой скорости → крупные дампы (4–10 ГБ) уходят на upload быстрее;
//! - **потоковость**: tar-поток пишется прямо в `zstd::Encoder` — файл не
//!   грузится в RAM;
//! - **совместимость чтения**: ZIP остаётся (Explorer открывает «из коробки»),
//!   tar.zst читается нашим клиентом и 7-Zip/Zstandard-утилитами.
//!
//! Безопасность распаковки — как в [`crate::archive`] (ZIP): имя энтри
//! санитизируется ([`sanitize_entry_name`]), симлинки/hardlink'и/устройства
//! **пропускаются** (tar умеет их хранить, и через symlink классически
//! «убегают» за пределы каталога распаковки).
//!
//! Уровни zstd: 1 (Fast, для сырых дампов на upload) … 19 (Ultra).
//! Дефолт контейнера — 3 (см. [`DEFAULT_LEVEL`]).

use std::fs;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::archive::{sanitize_entry_name, source_bytes_total, ProgressReader};

/// Magic-заголовок zstd-фрейма (`28 B5 2F FD`) — детект контейнера по байтам.
pub const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// Уровень zstd по умолчанию (компромисс скорость/размер для прошивок).
pub const DEFAULT_LEVEL: i32 = 3;
/// Границы уровня zstd, принимаемые клиентом.
pub const MIN_LEVEL: i32 = 1;
pub const MAX_LEVEL: i32 = 19;

/// Является ли заголовок началом zstd-фрейма (первый слой tar.zst).
pub fn is_tar_zst_magic(header: &[u8]) -> bool {
    header.len() >= 4 && header[..4] == ZSTD_MAGIC
}

/// Создать `.tar.zst` из файла или папки (потоково, без загрузки в RAM).
///
/// * `path` — исходный файл/папка;
/// * `is_directory` — true для папки (содержимое ложится в корень архива);
/// * `bundle_hash` — первые 12 символов идут в имя (`{имя}_{hash12}.tar.zst`);
/// * `level` — уровень zstd (`None` → [`DEFAULT_LEVEL`]; вне диапазона — clamp).
///
/// Возвращает путь к созданному архиву в `temp_dir()/firmware-desktop/`.
pub fn create_tar_zst(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    level: Option<i32>,
) -> anyhow::Result<String> {
    create_tar_zst_at(path, is_directory, bundle_hash, level, None)
}

/// Создать `.tar.zst` с явным путём результата (ручной «Архиватор»).
///
/// `output_path`: `None` → temp (`temp_dir()/firmware-desktop/`, как при
/// upload); `Some(p)` → пишем ровно туда (родительская папка создаётся).
/// Явный путь нужен, потому что temp может лежать на другом диске, и
/// последующий `rename_file` к цели упал бы с EXDEV.
pub fn create_tar_zst_at(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    level: Option<i32>,
    output_path: Option<&str>,
) -> anyhow::Result<String> {
    create_tar_zst_at_with_progress(
        path,
        is_directory,
        bundle_hash,
        level,
        output_path,
        &mut |_, _| {},
    )
}

/// То же, что [`create_tar_zst_at`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)`.
///
/// `total` — сумма размеров ИСХОДНИКОВ; финальный кадр `(total, total)`
/// отправляется принудительно (паритет с ZIP-веткой: UI обязан дойти до 100 %).
pub fn create_tar_zst_at_with_progress(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    level: Option<i32>,
    output_path: Option<&str>,
    on_progress: &mut dyn FnMut(u64, u64),
) -> anyhow::Result<String> {
    let src_path = Path::new(path);
    let hash12 = bundle_hash.get(..12).unwrap_or(bundle_hash);
    let archive_name = format!(
        "{}_{}.tar.zst",
        src_path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_else(|| std::borrow::Cow::Borrowed("firmware")),
        hash12
    );

    let archive_path = match output_path {
        Some(p) => {
            let p = PathBuf::from(p);
            if let Some(parent) = p.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)?;
                }
            }
            p
        }
        None => {
            let tmp_dir = std::env::temp_dir().join("firmware-desktop");
            fs::create_dir_all(&tmp_dir)?;
            tmp_dir.join(&archive_name)
        }
    };

    let level = level.unwrap_or(DEFAULT_LEVEL).clamp(MIN_LEVEL, MAX_LEVEL);

    let out_file = fs::File::create(&archive_path).map_err(|e| {
        anyhow::anyhow!("Failed to create archive {}: {}", archive_path.display(), e)
    })?;
    // BufWriter 256 КиБ (как в ZIP-ветке) + zstd поверх: сжатие блоками,
    // диск не «дребезжит» мелкими записями.
    let encoder = zstd::Encoder::new(BufWriter::with_capacity(256 * 1024, out_file), level)
        .map_err(|e| anyhow::anyhow!("Failed to init zstd encoder: {}", e))?;
    let mut builder = tar::Builder::new(encoder);
    // Заголовки детерминированные (mtime/uid/gid фиксированы) — одинаковый вход
    // даёт одинаковый архив; симлинки не разыменовываем.
    builder.mode(tar::HeaderMode::Deterministic);
    builder.follow_symlinks(false);

    // Прогресс: байты ИСХОДНИКОВ (счётчик один на операцию, копится по файлам).
    let total = source_bytes_total(src_path, is_directory);
    let mut processed: u64 = 0;

    if is_directory {
        // Как и в ZIP-ветке: сам корень не пишем — содержимое ложится в корень.
        for entry in WalkDir::new(src_path) {
            let entry = entry?;
            let entry_path = entry.path();
            if entry_path == src_path {
                continue;
            }
            let rel_path = entry_path.strip_prefix(src_path).unwrap_or(entry_path);
            let name = rel_path.to_string_lossy().replace('\\', "/");

            if entry.file_type().is_dir() {
                builder.append_dir(format!("{}/", name.trim_end_matches('/')), entry_path)?;
            } else if entry.file_type().is_file() {
                let file = fs::File::open(entry_path)?;
                // Счётчик на читателе: tar тянет файл кусками → кадры по ходу.
                // `append_file` принимает ТОЛЬКО `&mut fs::File`, поэтому
                // заголовок собираем сами — в том же детерминированном режиме,
                // что и `builder.mode(Deterministic)` (mtime/uid/gid фиксированы).
                let meta = file.metadata()?;
                let mut header = tar::Header::new_gnu();
                header.set_metadata_in_mode(&meta, tar::HeaderMode::Deterministic);
                let mut reader =
                    ProgressReader::new(file, &mut processed, total, &mut *on_progress);
                builder.append_data(&mut header, name, &mut reader)?;
            }
            // Симлинки и прочие спец-типы молча пропускаем (не тащим из ФС).
        }
    } else {
        let fname = src_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .replace('\\', "/");
        let file = fs::File::open(src_path)?;
        let meta = file.metadata()?;
        let mut header = tar::Header::new_gnu();
        header.set_metadata_in_mode(&meta, tar::HeaderMode::Deterministic);
        let mut reader = ProgressReader::new(file, &mut processed, total, &mut *on_progress);
        builder.append_data(&mut header, fname, &mut reader)?;
    }

    // Финализируем tar (два zero-блока) и закрываем zstd-фрейм (footer+checksum).
    let encoder = builder
        .into_inner()
        .map_err(|e| anyhow::anyhow!("Failed to finalize tar stream: {}", e))?;
    let mut writer = encoder
        .finish()
        .map_err(|e| anyhow::anyhow!("Failed to finalize zstd frame: {}", e))?;
    writer.flush()?;
    drop(writer);

    // Принудительный финальный кадр (паритет с ZIP): ровно 100 %.
    if total > 0 {
        on_progress(total, total);
    }

    Ok(archive_path.to_string_lossy().to_string())
}

/// Распаковать `.tar.zst` в указанный каталог.
///
/// Защита (fail-closed, паритет с ZIP-веткой):
/// - имена энтри санитизируются — `..`, абсолютные пути и drive-префиксы
///   (`C:`) **пропускаются**, ничего за пределы `output_dir` не пишется;
/// - симлинки/hardlink'и/устройства/FIFO пропускаются (tar их умеет хранить —
///   через symlink классически «убегают» из каталога распаковки);
/// - каталоги создаются по мере обхода.
pub fn extract_tar_zst(archive_path: &str, output_dir: &str) -> anyhow::Result<()> {
    extract_tar_zst_with_progress(archive_path, output_dir, &mut |_, _| {})
}

/// То же, что [`extract_tar_zst`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)`.
///
/// База прогресса — размер САМОГО АРХИВА (сжатые байты): распакованный размер
/// заранее неизвестен. Счётчик стоит на входном потоке декодера, поэтому
/// отражает реально прочитанное с диска, а не распакованный объём.
pub fn extract_tar_zst_with_progress(
    archive_path: &str,
    output_dir: &str,
    on_progress: &mut dyn FnMut(u64, u64),
) -> anyhow::Result<()> {
    let out_path = Path::new(output_dir);
    fs::create_dir_all(out_path)?;

    let total = fs::metadata(archive_path).map(|m| m.len()).unwrap_or(0);
    let mut processed: u64 = 0;
    let in_file = fs::File::open(archive_path)
        .map_err(|e| anyhow::anyhow!("Failed to open archive {}: {}", archive_path, e))?;
    let reader = ProgressReader::new(
        BufReader::with_capacity(256 * 1024, in_file),
        &mut processed,
        total,
        &mut *on_progress,
    );
    let decoder = zstd::Decoder::new(reader)
        .map_err(|e| anyhow::anyhow!("Failed to read zstd archive {}: {}", archive_path, e))?;
    let mut archive = tar::Archive::new(decoder);

    let mut index: u64 = 0;
    for entry in archive
        .entries()
        .map_err(|e| anyhow::anyhow!("Failed to read tar stream {}: {}", archive_path, e))?
    {
        let mut entry =
            entry.map_err(|e| anyhow::anyhow!("Failed to read tar entry #{}: {}", index, e))?;
        index += 1;

        // Тип энтри: только обычные файлы и каталоги (links/devices — мимо).
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            continue;
        }

        // Имя → безопасный относительный путь внутри output_dir.
        let raw_name = entry
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(rel) = sanitize_entry_name(&raw_name) else {
            continue;
        };

        if entry_type.is_dir() {
            fs::create_dir_all(out_path.join(&rel))?;
            continue;
        }

        let dest = out_path.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&dest).map_err(|e| {
            anyhow::anyhow!(
                "Failed to create {} while extracting {}: {}",
                dest.display(),
                archive_path,
                e
            )
        })?;
        io::copy(&mut entry, &mut out)?;
    }

    // Явный drop: `archive` держит заём на `processed`/`on_progress`.
    drop(archive);
    if total > 0 {
        on_progress(total, total);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_base(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-tarzst-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        base
    }

    /// Magic zstd-фрейма — детект контейнера по байтам.
    #[test]
    fn zstd_magic_detected() {
        assert!(is_tar_zst_magic(&[0x28, 0xb5, 0x2f, 0xfd]));
        assert!(!is_tar_zst_magic(&[0x50, 0x4b, 0x03, 0x04])); // zip
        assert!(!is_tar_zst_magic(&[0x28, 0xb5])); // короткий
    }

    /// Roundtrip папки: вложенные файлы + пустая поддиректория переживают
    /// упаковку/распаковку, имя архива оканчивается на `.tar.zst`.
    #[test]
    fn tar_zst_roundtrip_directory() {
        let base = test_base("dir");
        let src = base.join("src");
        let out = base.join("out");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(src.join("empty")).unwrap();
        fs::write(src.join("main.bin"), b"FIRMWARE-TARZST-1234").unwrap();
        fs::write(src.join("sub/readme.txt"), "hello tar.zst").unwrap();
        fs::write(src.join("sub/part2.bin"), vec![3u8; 300_000]).unwrap();

        let created =
            create_tar_zst(src.to_str().unwrap(), true, "0123456789abcdef", None).unwrap();
        assert!(
            created.ends_with(".tar.zst"),
            "имя архива должно оканчиваться на .tar.zst: {}",
            created
        );
        let head = fs::read(&created).unwrap();
        assert!(is_tar_zst_magic(&head), "файл должен начинаться с zstd-magic");

        extract_tar_zst(&created, out.to_str().unwrap()).unwrap();

        assert_eq!(
            fs::read(src.join("main.bin")).unwrap(),
            fs::read(out.join("main.bin")).unwrap()
        );
        assert_eq!(
            fs::read(src.join("sub/readme.txt")).unwrap(),
            fs::read(out.join("sub/readme.txt")).unwrap()
        );
        assert_eq!(
            fs::read(src.join("sub/part2.bin")).unwrap(),
            fs::read(out.join("sub/part2.bin")).unwrap()
        );
        assert!(out.join("empty").is_dir(), "пустая поддиректория потеряна");

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&created);
    }

    /// Один файл → архив с одним энтри → распаковка даёт файл.
    #[test]
    fn tar_zst_roundtrip_single_file() {
        let base = test_base("file");
        fs::create_dir_all(&base).unwrap();
        let src_file = base.join("fw.bin");
        fs::write(&src_file, vec![9u8; 150_000]).unwrap();

        let created = create_tar_zst(src_file.to_str().unwrap(), false, "abcd", Some(1)).unwrap();
        let out = base.join("out");
        extract_tar_zst(&created, out.to_str().unwrap()).unwrap();

        assert_eq!(
            fs::read(&src_file).unwrap(),
            fs::read(out.join("fw.bin")).unwrap()
        );

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&created);
    }

    /// Уровень вне диапазона не ломает сборку (clamp), архив валиден.
    #[test]
    fn tar_zst_level_is_clamped() {
        let base = test_base("level");
        fs::create_dir_all(&base).unwrap();
        let src_file = base.join("fw.bin");
        fs::write(&src_file, vec![1u8; 10_000]).unwrap();

        for level in [Some(-5), Some(0), Some(99), None] {
            // Хэш различается со single-file тестом: иначе оба теста пишут ОДИН
            // temp-архив (имя+hash) и параллельный прогон роняет assert ниже.
            let created =
                create_tar_zst(src_file.to_str().unwrap(), false, "level01", level).unwrap();
            assert!(fs::metadata(&created).unwrap().len() > 0);
            let _ = fs::remove_file(&created);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Path Traversal: энтри `../evil.txt` и абсолютный путь не пишутся за
    /// пределы каталога распаковки (fail-closed, паритет с ZIP-тестом).
    #[test]
    fn tar_zst_extract_rejects_traversal() {
        let base = test_base("traversal");
        fs::create_dir_all(&base).unwrap();
        let archive_path = base.join("evil.tar.zst");

        // Собираем «злой» tar вручную и жмём его zstd (как сделал бы атакующий).
        // ВАЖНО: `Header::set_path` сам отвергает `..` (safety-фича tar-крейта),
        // поэтому опасные имена пишем сырыми байтами в поле name — как это
        // делает реальный атакующий (или старый архиватор).
        fn raw_name_header(name: &str, size: u64) -> tar::Header {
            let mut header = tar::Header::new_gnu();
            header.set_size(size);
            header.set_mode(0o644);
            {
                let gnu = header.as_gnu_mut().expect("gnu header");
                let bytes = name.as_bytes();
                assert!(bytes.len() < gnu.name.len(), "имя длиннее tar-поля");
                gnu.name[..bytes.len()].copy_from_slice(bytes);
            }
            header.set_cksum();
            header
        }

        {
            let out_file = fs::File::create(&archive_path).unwrap();
            let encoder = zstd::Encoder::new(BufWriter::new(out_file), 1).unwrap();
            let mut builder = tar::Builder::new(encoder);

            builder
                .append(&raw_name_header("../evil.txt", 4), &b"evil"[..])
                .unwrap();
            builder
                .append(&raw_name_header("/abs/evil.txt", 5), &b"evil2"[..])
                .unwrap();
            builder
                .append(&raw_name_header("ok.txt", 4), &b"good"[..])
                .unwrap();

            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }

        let out = base.join("out");
        extract_tar_zst(archive_path.to_str().unwrap(), out.to_str().unwrap()).unwrap();

        // Легитимный файл распакован, «злые» — нет (ни в out, ни рядом с out).
        assert_eq!(fs::read(out.join("ok.txt")).unwrap(), b"good");
        assert!(
            !out.join("abs").exists(),
            "абсолютный путь не должен распаковываться"
        );
        assert!(
            !base.join("evil.txt").exists(),
            "../evil.txt не должен выйти за пределы каталога распаковки"
        );

        let _ = fs::remove_dir_all(&base);
    }

    /// Симлинк внутри архива не создаётся (защита от «побега» через symlink).
    #[test]
    fn tar_zst_extract_skips_symlinks() {
        let base = test_base("symlink");
        fs::create_dir_all(&base).unwrap();
        let archive_path = base.join("link.tar.zst");

        {
            let out_file = fs::File::create(&archive_path).unwrap();
            let encoder = zstd::Encoder::new(BufWriter::new(out_file), 1).unwrap();
            let mut builder = tar::Builder::new(encoder);

            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("/etc/passwd").unwrap();
            header.set_path("link").unwrap();
            header.set_cksum();
            builder.append(&header, &[][..]).unwrap();

            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }

        let out = base.join("out");
        extract_tar_zst(archive_path.to_str().unwrap(), out.to_str().unwrap()).unwrap();
        assert!(!out.join("link").exists(), "симлинк не должен создаваться");

        let _ = fs::remove_dir_all(&base);
    }

    // ── Прогресс tar.zst (детерминированная полоса «Архиватора») ────────────
    // RED (test-first): zstd-ветка тоже обязана отдавать байтовый прогресс —
    // иначе для папки на несколько гигабайт пользователь видит только пульс.

    fn seed_tar_zst_progress(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = test_base(tag);
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.bin"), vec![4u8; 400 * 1024]).unwrap();
        fs::write(src.join("sub/b.bin"), vec![5u8; 400 * 1024]).unwrap();
        (base, src)
    }

    /// Кадры: total неизменен, processed монотонен и ≤ total, финал = 100 %.
    fn assert_tar_zst_frames(frames: &[(u64, u64)], expected_total: u64) {
        assert!(
            frames.len() >= 2,
            "ожидалось ≥2 кадра прогресса, пришло {}",
            frames.len()
        );
        let mut prev = 0u64;
        for (processed, total) in frames {
            assert_eq!(*total, expected_total, "total не должен меняться");
            assert!(*processed >= prev, "прогресс обязан быть монотонным");
            assert!(*processed <= expected_total, "processed не может превышать total");
            prev = *processed;
        }
        assert_eq!(
            frames.last().copied(),
            Some((expected_total, expected_total)),
            "финальный кадр обязан быть 100 %"
        );
    }

    #[test]
    fn tar_zst_pack_reports_monotonic_progress_and_final_frame() {
        let (base, src) = seed_tar_zst_progress("progress-pack");
        let dest = base.join("out.tar.zst");
        let expected_total = 2 * 400 * 1024;

        let mut frames: Vec<(u64, u64)> = Vec::new();
        {
            let mut on_progress = |processed: u64, total: u64| frames.push((processed, total));
            create_tar_zst_at_with_progress(
                src.to_str().unwrap(),
                true,
                "deadbeef0000",
                Some(1),
                Some(dest.to_str().unwrap()),
                &mut on_progress,
            )
            .expect("create_tar_zst_at_with_progress");
        }

        assert_tar_zst_frames(&frames, expected_total);
        assert!(dest.is_file(), "архив обязан быть создан");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tar_zst_unpack_reports_monotonic_progress_and_final_frame() {
        let (base, src) = seed_tar_zst_progress("progress-unpack");
        // Явный путь: temp-архивы с одинаковым `bundle_hash` делят имя, и
        // параллельный тест прочитал бы чужой недописанный файл.
        let archive = base.join("fixture.tar.zst");
        create_tar_zst_at(
            src.to_str().unwrap(),
            true,
            "deadbeef0000",
            Some(1),
            Some(archive.to_str().unwrap()),
        )
        .expect("create_tar_zst_at");
        let expected_total = fs::metadata(&archive).unwrap().len();
        let out = base.join("out");

        let mut frames: Vec<(u64, u64)> = Vec::new();
        {
            let mut on_progress = |processed: u64, total: u64| frames.push((processed, total));
            extract_tar_zst_with_progress(
                archive.to_str().unwrap(),
                out.to_str().unwrap(),
                &mut on_progress,
            )
            .expect("extract_tar_zst_with_progress");
        }

        assert_tar_zst_frames(&frames, expected_total);
        assert!(out.join("a.bin").is_file(), "содержимое обязано распаковаться");
        let _ = fs::remove_file(&archive);
        let _ = fs::remove_dir_all(&base);
    }
}

