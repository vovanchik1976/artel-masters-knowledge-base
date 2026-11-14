/// Архивация папок/файлов в ZIP (потоковая, без загрузки всего файла в RAM).
///
/// Формат — **ZIP** (не tar.zst): открывается «из коробки» на Windows/macOS/Linux
/// (проводник Windows, Finder, файловые менеджеры) без доп. инструментов.
/// Распаковка защищена от path traversal (zip-энтри с `..`, абсолютными путями
/// или drive-префиксами отклоняются).

use std::fs;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipArchive;

/// Опции записи ZIP: Deflate + ОБЯЗАТЕЛЬНЫЙ Zip64-флаг для всех записей.
///
/// Почему флаг всегда (BUG-UPLOAD-ZIP64-001): предел ZIP32 — 0xFFFFFFFF
/// (~4.0 ГБ) *на entry*; `zip 0.6` рвёт запись ошибкой
/// «Large file option has not been set», как только СЖАТЫЙ поток переваливает
/// порог (deflate сжатый бинарь не спасает, Stored — тоже: финиш-FIXUP
/// проверяет compressed_size). Условное включение по размеру невозможно —
/// размер известен только ПОСЛЕ записи. `true` безвредно (doc: «не навредит,
/// только +20 Б»), Win7-SP1/Explorer читает Zip64.
pub fn entry_options(level: Option<i32>) -> FileOptions {
    FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(true)
        .compression_level(level)
        .unix_permissions(0o644)
}

/// Читатель с подсчётом прочитанных байт — прогресс упаковки/распаковки БЕЗ
/// загрузки файла в память.
///
/// Колбэк вызывается на каждый `read` (≤ размера буфера `io::copy`/zstd), поэтому
/// ТРОТТЛИНГ живёт на стороне вызывающего (M2-диспетчер sidecar): здесь только
/// дешёвая арифметика и вызов замыкания. `processed` — счётчик ОПЕРАЦИИ (копится
/// между файлами), а не одного энтри.
///
/// Почему `min(total)`: ZIP читает центральный каталог с конца и затем
/// перечитывает данные, поэтому суммарно прочитанных байт может быть чуть
/// больше размера архива — процент не имеет права уехать за 100. `total == 0`
/// (неизвестен) — отдаём сырой счётчик, UI остаётся в неопределённом режиме.
pub(crate) struct ProgressReader<'a, R> {
    inner: R,
    processed: &'a mut u64,
    total: u64,
    on_progress: &'a mut dyn FnMut(u64, u64),
}

impl<'a, R> ProgressReader<'a, R> {
    pub(crate) fn new(
        inner: R,
        processed: &'a mut u64,
        total: u64,
        on_progress: &'a mut dyn FnMut(u64, u64),
    ) -> Self {
        Self {
            inner,
            processed,
            total,
            on_progress,
        }
    }
}

impl<R: Read> Read for ProgressReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let total = self.total;
        if n > 0 {
            let processed: &mut u64 = &mut *self.processed;
            *processed = processed.saturating_add(n as u64);
            let shown = if total > 0 {
                (*processed).min(total)
            } else {
                *processed
            };
            (self.on_progress)(shown, total);
        }
        Ok(n)
    }
}

/// `ZipArchive` требует `R: Read + Seek` — seek пробрасываем как есть
/// (перемещение по файлу не «читает» байты, счётчик не трогаем).
impl<R: Seek> Seek for ProgressReader<'_, R> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

/// Сумма размеров исходников в байтах — база (total) прогресса упаковки.
///
/// Ошибки отдельных файлов не фатальны (0): занижённый total не ломает полосу —
/// UI клампит процент на 100, а финальный кадр отправляется принудительно.
pub(crate) fn source_bytes_total(src: &Path, is_directory: bool) -> u64 {
    if !is_directory {
        return fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    for entry in WalkDir::new(src) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        // Корень папки в архив не попадает (как и в самом цикле упаковки),
        // каталоги размером не считаются.
        if path == src || entry.file_type().is_dir() {
            continue;
        }
        total = total.saturating_add(fs::metadata(path).map(|m| m.len()).unwrap_or(0));
    }
    total
}

/// Создать ZIP архив из файла или папки
///
/// * `path` — путь к исходному файлу или папке
/// * `is_directory` — true если папка, false если один файл
/// * `bundle_hash` — первые 12 символов используются в имени архива
/// * `level` — уровень deflate (None = дефолт 6; Some(1) = Fast для сырых
///   дампов — BUG-SMART-SINGLE-UPLOAD-001; Some(0) = Stored без сжатия)
///
/// Возвращает путь к созданному архиву (`{имя}_{hash12}.zip` в
/// `temp_dir()/firmware-desktop/`).
pub fn create_archive(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    level: Option<i32>,
) -> anyhow::Result<String> {
    create_archive_at(path, is_directory, bundle_hash, level, None)
}

/// Создать ZIP-архив с явным путём результата (Фаза 3, ручной «Архиватор»).
///
/// * `output_path` — `None` → temp (`temp_dir()/firmware-desktop/`, как при
///   upload); `Some(p)` → пишем ровно туда (папка-родитель создаётся).
///   Явный путь нужен ручному архиватору: temp может лежать на другом диске,
///   и последующий `rename_file` к цели упал бы с EXDEV.
pub fn create_archive_at(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    level: Option<i32>,
    output_path: Option<&str>,
) -> anyhow::Result<String> {
    create_archive_at_with_progress(
        path,
        is_directory,
        bundle_hash,
        level,
        output_path,
        &mut |_, _| {},
    )
}

/// То же, что [`create_archive_at`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)`.
///
/// `total` — сумма размеров ИСХОДНИКОВ (для папки считается предварительным
/// обходом). Финальный кадр `(total, total)` отправляется принудительно: без
/// него UI не доходит до 100 % при округлении/пустых файлах.
pub fn create_archive_at_with_progress(
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
        "{}_{}.zip",
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
            // Создаём во временной директории
            let tmp_dir = std::env::temp_dir().join("firmware-desktop");
            fs::create_dir_all(&tmp_dir)?;
            tmp_dir.join(&archive_name)
        }
    };
    let out_file = fs::File::create(&archive_path)
        .map_err(|e| anyhow::anyhow!("Failed to create archive {}: {}", archive_path.display(), e))?;
    let buf_writer = BufWriter::with_capacity(256 * 1024, out_file);
    let mut zip_writer = zip::ZipWriter::new(buf_writer);

    // Дефлейт (flate2/rust_backend — чистый Rust, кросс-платформенно).
    // Имена в zip всегда с '/' (спецификация) — на Windows исходный путь
    // содержит '\\', который заменяем ниже.
    let options = || entry_options(level);

    // Прогресс: байты ИСХОДНИКОВ — сумма размеров известна до старта операции.
    let total = source_bytes_total(src_path, is_directory);
    let mut processed: u64 = 0;

    if is_directory {
        // Добавляем всю папку рекурсивно (корень исключается — содержимое
        // ляжет в корень архива, как и раньше в tar.zst).
        for entry in WalkDir::new(src_path) {
            let entry = entry?;
            let entry_path = entry.path();
            if entry_path == src_path {
                continue; // пропускаем корень
            }
            // Относительный путь → имя zip-энтри (всегда с '/')
            let rel_path = entry_path.strip_prefix(src_path).unwrap_or(entry_path);
            let name = rel_path.to_string_lossy().replace('\\', "/");

            if entry.file_type().is_dir() {
                let dir_name = if name.ends_with('/') {
                    name
                } else {
                    format!("{}/", name)
                };
                zip_writer.add_directory(dir_name, options())?;
            } else {
                let file = fs::File::open(entry_path)?;
                zip_writer.start_file(name, options())?;
                // Счётчик живёт на читателе: `io::copy` тянет файл кусками,
                // поэтому кадры идут по ходу записи, а не после неё.
                let mut reader =
                    ProgressReader::new(file, &mut processed, total, &mut *on_progress);
                io::copy(&mut reader, &mut zip_writer)?;
            }
        }
    } else {
        // Один файл
        let fname = src_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .replace('\\', "/");
        let file = fs::File::open(src_path)?;
        zip_writer.start_file(fname, options())?;
        let mut reader = ProgressReader::new(file, &mut processed, total, &mut *on_progress);
        io::copy(&mut reader, &mut zip_writer)?;
    }

    // Финализируем центральный каталог zip и сбрасываем буфер на диск.
    let mut writer = zip_writer
        .finish()
        .map_err(|e| anyhow::anyhow!("Failed to finalize archive {}: {}", archive_path.display(), e))?;
    writer.flush()?;
    drop(writer);

    // Принудительный финальный кадр: ровно 100 %, даже если все файлы пустые
    // или total был занижён (файл вырос во время операции).
    if total > 0 {
        on_progress(total, total);
    }

    Ok(archive_path.to_string_lossy().to_string())
}

/// Распаковать ZIP архив в указанную директорию (защита от path traversal).
pub fn extract_archive(archive_path: &str, output_dir: &str) -> anyhow::Result<()> {
    extract_archive_with_progress(archive_path, output_dir, &mut |_, _| {})
}

/// То же, что [`extract_archive`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)`.
///
/// База прогресса распаковки — размер САМОГО АРХИВА (сжатые байты): распакованный
/// размер заранее неизвестен, а считать его вторым проходом — двойное чтение.
pub fn extract_archive_with_progress(
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
    let reader = ProgressReader::new(in_file, &mut processed, total, &mut *on_progress);
    let mut archive = ZipArchive::new(reader)
        .map_err(|e| anyhow::anyhow!("Failed to read zip archive {}: {}", archive_path, e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| anyhow::anyhow!("Failed to read zip entry #{}: {}", i, e))?;

        // Санитизируем имя энтри → безопасный относительный путь внутри out_path.
        // Энтри с `..`, абсолютными путями или drive-префиксами пропускаются.
        let Some(rel) = sanitize_entry_name(file.name()) else {
            continue;
        };

        if file.is_dir() {
            fs::create_dir_all(out_path.join(&rel))?;
            continue;
        }

        let dest = out_path.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&dest).map_err(|e| {
            anyhow::anyhow!("Failed to create {} while extracting {}: {}", dest.display(), archive_path, e)
        })?;
        io::copy(&mut file, &mut out)?;
    }

    // Явный drop: `archive` держит заём на `processed`/`on_progress`, а
    // финальный кадр обязан уйти после освобождения ссылок.
    drop(archive);
    if total > 0 {
        on_progress(total, total);
    }

    Ok(())
}

/// Контейнер архива (Фаза 3): ZIP (Explorer-native) и tar.zst (скорость+размер).
///
/// `as_str()` обязан совпадать с `manifest.container` клиента и с тем, что
/// детектит download (`DownloadAction.detectDownloadContainer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveContainer {
    Zip,
    TarZst,
}

impl ArchiveContainer {
    /// Имя контейнера для протокола/манифеста (`zip` | `tar_zst`).
    pub fn as_str(&self) -> &'static str {
        match self {
            ArchiveContainer::Zip => "zip",
            ArchiveContainer::TarZst => "tar_zst",
        }
    }

    /// Расширение файла (`.zip` | `.tar.zst`).
    pub fn extension(&self) -> &'static str {
        match self {
            ArchiveContainer::Zip => "zip",
            ArchiveContainer::TarZst => "tar.zst",
        }
    }

    /// Разбор имени контейнера из протокола. Неизвестное/пустое → `None`
    /// (дефолт выбирает вызывающий: M2-диспетчер — ZIP, UI — tar.zst).
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "zip" => Some(ArchiveContainer::Zip),
            "tar_zst" | "tar.zst" | "zst" => Some(ArchiveContainer::TarZst),
            _ => None,
        }
    }
}

/// Определить контейнер архива по СОДЕРЖИМОМУ (magic), с fallback на имя.
///
/// Порядок (байты весомее имени — паритет с `SingleUploadPolicy`/`DownloadAction`):
/// 1. `28 B5 2F FD` → tar.zst;
/// 2. `PK\x03\x04` / `PK\x05\x06` (пустой zip) → ZIP;
/// 3. имя оканчивается на `.tar.zst`/`.tzst` → tar.zst, `.zip` → ZIP;
/// 4. иначе — ошибка (такой контейнер не распаковываем: fail-closed).
pub fn detect_container(archive_path: &str) -> anyhow::Result<ArchiveContainer> {
    let mut header = [0u8; 4];
    let read = {
        let mut f = fs::File::open(archive_path)
            .map_err(|e| anyhow::anyhow!("Failed to open archive {}: {}", archive_path, e))?;
        io::Read::read(&mut f, &mut header)?
    };
    if read >= 4 {
        if header == crate::tar_zst::ZSTD_MAGIC {
            return Ok(ArchiveContainer::TarZst);
        }
        if header == [0x50, 0x4b, 0x03, 0x04] || header == [0x50, 0x4b, 0x05, 0x06] {
            return Ok(ArchiveContainer::Zip);
        }
    }

    let lower = archive_path.to_ascii_lowercase();
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Ok(ArchiveContainer::TarZst);
    }
    if lower.ends_with(".zip") {
        return Ok(ArchiveContainer::Zip);
    }

    anyhow::bail!(
        "Unsupported archive container (unknown magic and extension): {}",
        archive_path
    )
}

/// Упаковать файл/папку в выбранный контейнер (M2 `pack_archive`).
///
/// * `container` — ZIP (Explorer-native) или tar.zst (скорость/размер);
/// * `level` — уровень сжатия ДЛЯ ЭТОГО контейнера: deflate 0-9 (ZIP) /
///   zstd 1-19 (tar.zst). `None` — дефолт контейнера (ZIP 6 / tar.zst 3).
///
/// Возвращает путь к созданному архиву (`temp_dir()/firmware-desktop/`).
pub fn pack_archive(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    container: ArchiveContainer,
    level: Option<i32>,
    output_path: Option<&str>,
) -> anyhow::Result<String> {
    pack_archive_with_progress(
        path,
        is_directory,
        bundle_hash,
        container,
        level,
        output_path,
        &mut |_, _| {},
    )
}

/// То же, что [`pack_archive`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)` — общий вход для M2-диспетчера.
pub fn pack_archive_with_progress(
    path: &str,
    is_directory: bool,
    bundle_hash: &str,
    container: ArchiveContainer,
    level: Option<i32>,
    output_path: Option<&str>,
    on_progress: &mut dyn FnMut(u64, u64),
) -> anyhow::Result<String> {
    match container {
        ArchiveContainer::Zip => create_archive_at_with_progress(
            path,
            is_directory,
            bundle_hash,
            level,
            output_path,
            on_progress,
        ),
        ArchiveContainer::TarZst => crate::tar_zst::create_tar_zst_at_with_progress(
            path,
            is_directory,
            bundle_hash,
            level,
            output_path,
            on_progress,
        ),
    }
}

/// Распаковать архив ЛЮБОГО поддерживаемого контейнера (M2 `unpack_archive`).
///
/// Контейнер определяется по magic/имени ([`detect_container`]) — клиенту не
/// нужно знать, чем упаковано: legacy ZIP и новые tar.zst идут одним путём.
/// Возвращает распознанный контейнер (для логов/диагностики).
pub fn unpack_archive(archive_path: &str, output_dir: &str) -> anyhow::Result<ArchiveContainer> {
    unpack_archive_with_progress(archive_path, output_dir, &mut |_, _| {})
}

/// То же, что [`unpack_archive`], но с колбэком прогресса
/// `on_progress(processed_bytes, total_bytes)` — общий вход для M2-диспетчера.
pub fn unpack_archive_with_progress(
    archive_path: &str,
    output_dir: &str,
    on_progress: &mut dyn FnMut(u64, u64),
) -> anyhow::Result<ArchiveContainer> {
    let container = detect_container(archive_path)?;
    match container {
        ArchiveContainer::Zip => extract_archive_with_progress(archive_path, output_dir, on_progress)?,
        ArchiveContainer::TarZst => {
            crate::tar_zst::extract_tar_zst_with_progress(archive_path, output_dir, on_progress)?
        }
    }
    Ok(container)
}


/// Преобразовать имя zip-энтри в безопасный относительный путь.
///
/// Возвращает `None`, если имя опасно (абсолютный путь, Windows-диск, `..`).
/// Имена с '\\' нормализуются в '/' (архивы, созданные на Windows).
/// `pub(crate)`: тот же санитайзер использует распаковка tar.zst
/// ([`crate::tar_zst::extract_tar_zst`]).
pub(crate) fn sanitize_entry_name(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    // Абсолютные пути (POSIX '/' или Windows-UNC '\\') и пути на диске ('X:')
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return None;
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None; // Windows drive prefix
    }

    let mut out = PathBuf::new();
    for comp in normalized.split('/') {
        match comp {
            "" | "." => continue,      // пустые/текущие сегменты пропускаем
            ".." => return None,        // выход из директории — запрещён
            _ => out.push(comp),
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

/// Безопасно удалить temp-архив из `temp_dir()/firmware-desktop/` (BUG-DESKTOP-UI-003).
///
/// Защита от path traversal / произвольного удаления:
/// - путь ДОЛЖЕН быть абсолютным;
/// - после `fs::canonicalize` (резолв `..`, симлинков, относительных сегментов)
///   путь ОБЯЗАН лежать внутри `temp_dir()/firmware-desktop/` — иначе отказ;
/// - удаляются только обычные файлы (директории и симлинки-наружу отклоняются).
///
/// Идемпотентность: если файл уже удалён (NotFound) — возвращает Ok,
/// чтобы повторные вызовы из `finally`/`cancelUpload` были безвредны.
pub fn remove_archive(path: &str) -> anyhow::Result<()> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        anyhow::bail!("Archive path must be absolute: {}", path);
    }

    let tmp_dir = std::env::temp_dir().join("firmware-desktop");
    let allowed_root = match fs::canonicalize(&tmp_dir) {
        Ok(r) => r,
        // Папки нет — файла внутри неё существовать не может.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    // canonicalize отсекает "..", разрешает симлинки и возвращает каноничный путь.
    let full = match fs::canonicalize(requested) {
        Ok(f) => f,
        // Файл уже удалён — не ошибка (идемпотентность для finally + cancel).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    if !full.starts_with(&allowed_root) {
        anyhow::bail!(
            "Refusing to remove file outside temp firmware-desktop dir: {}",
            path
        );
    }

    // Только обычный файл: symlink_metadata не следует за симлинком,
    // поэтому симлинк (даже указывающий внутрь) сюда не пройдёт как файл.
    let meta = fs::symlink_metadata(&full)?;
    if !meta.file_type().is_file() {
        anyhow::bail!("Refusing to remove non-regular file: {}", path);
    }

    fs::remove_file(&full)
        .map_err(|e| anyhow::anyhow!("Failed to remove temp archive {}: {}", path, e))
}

/// Удалить устаревшие temp-архивы (`*.zip` и `*.tar.zst`) из
/// `temp_dir()/firmware-desktop/`.
///
/// Фаза 3: клиент снова создаёт `*.tar.zst` (скоростной контейнер), поэтому
/// подчищаются ОБА контейнера (`.zip` и `.zst`) старше `max_age_secs`.
/// Расширение сравнивается БЕЗ учёта регистра: Windows-ФС регистронезависима, и
/// `DUMP.ZIP` иначе остался бы в temp навсегда (BUG-JANITOR-WIN-001).
/// Удаляются только ОБЫЧНЫЕ файлы (симлинки и директории игнорируются —
/// защита от подмены). Ошибки отдельных файлов не фатальны — пропускаются.
/// Возвращает число удалённых файлов.
///
/// Безопасно при параллельных upload-сессиях: файлы, созданные меньше
/// `max_age_secs` назад, не трогаются. Вызывается silent при старте клиента.
pub fn cleanup_stale_archives(max_age_secs: u64) -> anyhow::Result<usize> {
    let mut removed = cleanup_in_dir(
        &std::env::temp_dir().join("firmware-desktop"),
        |ext| ext == Some("zip") || ext == Some("zst"),
        max_age_secs,
    )?;
    // Дворник после каждой операции (BUG-CANCEL-FINAL-001): слайсы multi-upload
    // `{pid}_{i}.part` (upload.rs::start_multi) переживают отмену/креш —
    // подчищаем и их. max_age_secs=0 сносит любые остатки (движок остановлен);
    // на startup порог тоже 0 (BUG-SINGLE-INSTANCE-001) — второй экземпляр запрещён замком.
    removed += cleanup_in_dir(
        &std::env::temp_dir().join("tdlib_upload_parts"),
        |ext| ext == Some("part"),
        max_age_secs,
    )?;
    Ok(removed)
}

/// Удалить обычные файлы в `dir`, для которых `wanted(ext)` истинно и возраст
/// ≥ `max_age_secs`. Отсутствие каталога — не ошибка (0). Ошибки отдельных
/// файлов не фатальны — пропускаются.
fn cleanup_in_dir(
    dir: &std::path::Path,
    wanted: impl Fn(Option<&str>) -> bool,
    max_age_secs: u64,
) -> anyhow::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };

    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        // Windows-ФС регистронезависима, поэтому и матчинг расширения — без учёта
        // регистра (BUG-JANITOR-WIN-001): иначе остатки `DUMP.ZIP` / `{pid}_0.PART`
        // дворник не видел и они жили в temp навсегда.
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !wanted(ext.as_deref()) {
            continue;
        }
        // Только обычные файлы — симлинки/директории не трогаем.
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let modified = match meta.modified() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let age_secs = match now.duration_since(modified) {
            Ok(d) => d.as_secs(),
            // Модифицировано «в будущем» (часы сдвинуты) — не трогаем.
            Err(_) => continue,
        };
        if age_secs >= max_age_secs {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RED (test-first): дворник чистит НЕ только `firmware-desktop/*.zip|zst`,
    /// но и multi-upload слайсы `{pid}_{i}.part` в `temp_dir()/tdlib_upload_parts`.
    /// Раньше слайсы переживали отмену/креш upload и копились на диске
    /// (cleanup_stale_archives матчил только расширения zip/zst).
    #[test]
    fn cleanup_sweeps_upload_part_slices() {
        let parts_dir = std::env::temp_dir().join("tdlib_upload_parts");
        fs::create_dir_all(&parts_dir).unwrap();
        let stale = parts_dir.join(format!("{}_0.part", std::process::id()));
        fs::write(&stale, vec![1u8; 64]).unwrap();

        // max_age=0 → удаление любых слайсов (дворник после каждой операции).
        let removed = cleanup_stale_archives(0).expect("cleanup_stale_archives");
        assert!(removed >= 1, "слайс .part должен удаляться дворником");
        assert!(!stale.exists(), "устаревший слайс обязан быть удалён");
        let _ = fs::remove_file(&stale);
    }

    /// RED (Windows-совместимость, test-first 2026-09-27): матчинг расширений был
    /// СТРОКОВЫМ (`ext == Some("zip")`), а Windows-ФС регистронезависима: остатки
    /// `DUMP.ZIP` / `{pid}_0.PART` дворник не «видел» и они жили в temp НАВСЕГДА —
    /// ровно тот мусор, который на релизной Windows никто не уберёт.
    ///
    /// Проверка герметична (свой каталог + точный счётчик): общие
    /// `temp/firmware-desktop` / `temp/tdlib_upload_parts` делят другие тесты,
    /// которые параллельно чистят те же расширения — счёт в них недетерминирован.
    #[test]
    fn cleanup_in_dir_matches_extensions_case_insensitively() {
        let dir =
            std::env::temp_dir().join(format!("firmware-core-case-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for name in ["UPPER.ZIP", "lower.zip", "Mixed.Zst", "UPPER.PART"] {
            fs::write(dir.join(name), vec![3u8; 16]).unwrap();
        }
        fs::write(dir.join("keep.txt"), b"not our business").unwrap();

        let removed = cleanup_in_dir(
            &dir,
            |ext| matches!(ext, Some("zip") | Some("zst") | Some("part")),
            0,
        )
        .expect("cleanup_in_dir");

        assert_eq!(removed, 4, "расширения в ЛЮБОМ регистре обязаны удаляться");
        assert!(!dir.join("UPPER.ZIP").exists(), ".ZIP обязан удаляться");
        assert!(!dir.join("Mixed.Zst").exists(), ".Zst обязан удаляться");
        assert!(!dir.join("UPPER.PART").exists(), ".PART обязан удаляться");
        assert!(
            dir.join("keep.txt").exists(),
            "файл с чужим расширением дворник трогать не должен"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Санитайзер имён zip-энтри: безопасные пути проходят, опасные отклоняются.
    #[test]
    fn sanitize_rejects_traversal_and_absolute() {
        // Опасные → None
        assert!(sanitize_entry_name("../evil").is_none());
        assert!(sanitize_entry_name("a/../../evil").is_none());
        assert!(sanitize_entry_name("/etc/passwd").is_none());
        assert!(sanitize_entry_name("//server/share").is_none());
        assert!(sanitize_entry_name("C:/windows").is_none());
        assert!(sanitize_entry_name("C:\\windows\\x").is_none());
        // Безопасные → Ok
        assert!(sanitize_entry_name("dump.bin").is_some());
        assert!(sanitize_entry_name("sub/file.bin").is_some());
        assert!(sanitize_entry_name("sub/dir/").is_some());
        assert!(sanitize_entry_name("sub\\file.bin").is_some()); // windows-имя нормализуется
    }

    /// Roundtrip: папка (вложенные файлы + пустая поддиректория) → zip → распаковка,
    /// содержимое идентично.
    #[test]
    fn zip_roundtrip_directory() {
        let base = std::env::temp_dir().join(format!("firmware-core-test-{}", std::process::id()));
        let src = base.join("src");
        let out = base.join("out");
        // Чистим от прошлых запусков
        let _ = fs::remove_dir_all(&base);

        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(src.join("empty")).unwrap();
        fs::write(src.join("main.bin"), b"FIRMWARE-DATA-1234").unwrap();
        fs::write(src.join("sub/readme.txt"), "hello zip".as_bytes()).unwrap();
        fs::write(src.join("sub/part2.bin"), vec![0u8; 5000]).unwrap();

        let created = create_archive(src.to_str().unwrap(), true, "0123456789abcdef", None)
            .expect("create_archive");
        assert!(created.ends_with(".zip"), "архив должен быть .zip: {}", created);

        extract_archive(&created, out.to_str().unwrap()).expect("extract_archive");

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
        // Пустая директория сохранена
        assert!(out.join("empty").is_dir());

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&created);
    }

    /// Один файл → zip с одним энтри → распаковка даёт файл.
    #[test]
    fn zip_roundtrip_single_file() {
        let base = std::env::temp_dir().join(format!("firmware-core-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src_file = base.join("fw.bin");
        fs::write(&src_file, vec![7u8; 200_000]).unwrap();

        let created = create_archive(src_file.to_str().unwrap(), false, "aaaa", None)
            .expect("create_archive");
        let out_dir = base.join("out");
        extract_archive(&created, out_dir.to_str().unwrap()).expect("extract_archive");

        assert_eq!(
            fs::read(&src_file).unwrap(),
            fs::read(out_dir.join("fw.bin")).unwrap()
        );

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&created);
    }

    /// BUG-UPLOAD-ZIP64-001 (RED): entry >4 ГБ обязан собираться (Zip64-флаг),
    /// а не падать «Large file option has not been set». Sparse-файл 5.0 ГБ
    /// (set_len — место на диске ~0): чтение дыр идёт нулями из SEEK_HOLE,
    /// поэтому deflate честно сжимает его до ~5 МБ за ~2 мин — это рабочий
    /// прогон, а не висяк. Регрессия — именно ошибка и размер entry.
    #[test]
    #[ignore = "долгий (~2 мин): гоняется вручную/PR, не в каждом прогоне"]
    fn zip64_sparse_entry_over_4gib() {
        use std::io::{Seek, SeekFrom, Write};

        let base = std::env::temp_dir().join(format!(
            "firmware-core-zip64-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src_file = base.join("sparse5g.bin");
        let five_gib: u64 = 5 * 1024 * 1024 * 1024;

        // sparse 5.0 ГБ: метаданные размера есть, блоков на диске нет.
        // Пишем по 1 страничному байту в 3 местах >4 ГБ — директорию прошли.
        // ═══
        let mut f = fs::File::create(&src_file).unwrap();
        f.set_len(five_gib).unwrap();
        for off in [
            4 * 1024 * 1024 * 1024u64 + 11,
            4 * 1024 * 1024 * 1024u64 + 4_194_304 + 101,
            five_gib - 7,
        ] {
            f.seek(SeekFrom::Start(off)).unwrap();
            f.write_all(&[0xABu8]).unwrap();
        }
        f.sync_all().unwrap();
        drop(f);

        assert_eq!(fs::metadata(&src_file).unwrap().len(), five_gib);

        let created = create_archive(src_file.to_str().unwrap(), false, "zip64", None)
            .expect("create_archive с Zip64-флагом обязана переступить 4 ГБ");

        // Метаданные: entry необрезан, размер — полные 5.0 ГБ.
        let in_file = fs::File::open(&created).unwrap();
        let mut archive = ZipArchive::new(in_file).unwrap();
        assert_eq!(archive.len(), 1);
        let entry = archive.by_index(0).unwrap();
        assert_eq!(
            entry.size(),
            five_gib,
            "entry обязано хранить полный размер >4 ГБ"
        );
        drop(entry);
        drop(archive);

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&created);
    }

    /// BUG-SMART-SINGLE-UPLOAD-001: уровень deflate пробрасывается в entry.
    /// Fast (Some(1)) собирается и читается; дефолт (None) — уровень 6.
    #[test]
    fn compression_level_fast_and_default() {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-level-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src_file = base.join("dump.bin");
        // Псевдошум: deflate почти не жмёт, но уровни обязаны отработать.
        let data: Vec<u8> = (0u32..50_000).map(|i| (i.wrapping_mul(2654435761) >> 8) as u8).collect();
        fs::write(&src_file, &data).unwrap();

        let fast = create_archive(src_file.to_str().unwrap(), false, "fast01", Some(1))
            .expect("level=1 (Fast)");
        let def = create_archive(src_file.to_str().unwrap(), false, "deflt6", None)
            .expect("level=None (default 6)");

        // Оба — валидные zip, entry читается побайтово идентично.
        for created in [&fast, &def] {
            let in_file = fs::File::open(created).unwrap();
            let mut archive = ZipArchive::new(in_file).unwrap();
            assert_eq!(archive.len(), 1);
            let mut entry = archive.by_index(0).unwrap();
            let mut buf = Vec::new();
            io::copy(&mut entry, &mut buf).unwrap();
            assert_eq!(buf, data, "содержимое entry обязано совпасть: {created}");
        }

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_file(&fast);
        let _ = fs::remove_file(&def);
    }

    /// BUG-UPLOAD-ZIP64-001: Zip64-флаг стоит на ВСЕХ записях безусловно
    /// (размер известен только ПОСЛЕ записи — условное включение невозможно).
    /// Проверяем напрямую через local header: с large_file(true) writer пишет
    /// Zip64 extra field (0x0001) ДО данных, без флага extra field пуст.
    #[test]
    fn zip64_flag_set_unconditionally() {
        for level in [None, Some(1)] {
            let dir = std::env::temp_dir().join(format!(
                "firmware-core-zf-{:?}-{}",
                level,
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();

            let cursor = std::io::Cursor::new(Vec::<u8>::new());
            let buf_writer = BufWriter::with_capacity(256 * 1024, cursor);
            let mut zw = zip::ZipWriter::new(buf_writer);
            zw.start_file("probe.bin", entry_options(level)).unwrap();
            zw.write_all(b"probe-data").unwrap();
            let cursor = zw.finish().unwrap().into_inner().unwrap().into_inner();

            let bytes = cursor;
            // Local header: сигнатура PK\x03\x04 (0..4), следом ищем Zip64
            // extra field ID 0x0001 (LE: 01 00) в пределах первых 128 байт.
            assert_eq!(&bytes[0..4], &[0x50, 0x4b, 0x03, 0x04]);
            let window = &bytes[..bytes.len().min(128)];
            let has_zip64_extra = window
                .windows(2)
                .any(|w| w == [0x01, 0x00]);
            assert!(
                has_zip64_extra,
                "local header без Zip64 extra field (level={level:?})"
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// Фаза 3: имена контейнеров совпадают с протоколом/манифестом клиента.
    #[test]
    fn container_names_match_protocol() {
        assert_eq!(ArchiveContainer::Zip.as_str(), "zip");
        assert_eq!(ArchiveContainer::TarZst.as_str(), "tar_zst");
        assert_eq!(ArchiveContainer::Zip.extension(), "zip");
        assert_eq!(ArchiveContainer::TarZst.extension(), "tar.zst");
        // parse: имена из манифеста и «человеческие» алиасы.
        assert_eq!(ArchiveContainer::parse("zip"), Some(ArchiveContainer::Zip));
        assert_eq!(
            ArchiveContainer::parse("TAR_ZST"),
            Some(ArchiveContainer::TarZst)
        );
        assert_eq!(
            ArchiveContainer::parse("tar.zst"),
            Some(ArchiveContainer::TarZst)
        );
        assert_eq!(ArchiveContainer::parse(""), None);
        assert_eq!(ArchiveContainer::parse("rar"), None);
    }

    /// pack_archive/unpack_archive: оба контейнера дают одинаковое содержимое,
    /// а распаковка определяет контейнер по magic (клиенту знать не нужно).
    #[test]
    fn pack_and_unpack_both_containers() {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-containers-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("fw.bin"), vec![42u8; 40_000]).unwrap();
        fs::write(src.join("sub/inner.txt"), "inner").unwrap();

        for container in [ArchiveContainer::Zip, ArchiveContainer::TarZst] {
            let created =
                pack_archive(src.to_str().unwrap(), true, "cafebabe0000", container, None, None)
                    .unwrap();
            assert!(
                created.ends_with(container.extension()),
                "{} должен оканчиваться на .{}",
                created,
                container.extension()
            );
            // Детект по байтам (не по имени) — magic весомее.
            assert_eq!(detect_container(&created).unwrap(), container);

            let out = base.join(format!("out-{}", container.as_str()));
            let detected = unpack_archive(&created, out.to_str().unwrap()).unwrap();
            assert_eq!(detected, container);
            assert_eq!(
                fs::read(src.join("fw.bin")).unwrap(),
                fs::read(out.join("fw.bin")).unwrap()
            );
            assert_eq!(
                fs::read(src.join("sub/inner.txt")).unwrap(),
                fs::read(out.join("sub/inner.txt")).unwrap()
            );

            let _ = fs::remove_file(&created);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// Детект чужого/пустого файла — честная ошибка (fail-closed), не panic.
    #[test]
    fn detect_container_rejects_unknown() {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-detect-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let junk = base.join("dump.bin");
        fs::write(&junk, vec![0x00u8; 64]).unwrap();
        assert!(detect_container(junk.to_str().unwrap()).is_err());
        // Имя «архивное», но байты чужие: magic не сходится → по имени тоже
        // не угадываем (ZIP по имени подходит, поэтому проверяем tar.zst-имена).
        let fake = base.join("dump.tar.zst");
        fs::write(&fake, vec![0u8; 8]).unwrap();
        assert_eq!(
            detect_container(fake.to_str().unwrap()).unwrap(),
            ArchiveContainer::TarZst
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// Фаза 3 (ручной «Архиватор»): `output_path` кладёт архив ровно по
    /// указанному пути (не в temp) — иначе на другом диске был бы EXDEV.
    #[test]
    fn pack_archive_writes_to_explicit_output_path() {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-outpath-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("fw.bin"), b"explicit output").unwrap();

        for container in [ArchiveContainer::Zip, ArchiveContainer::TarZst] {
            // Подпапка ещё не существует — создаётся по ходу.
            let dest = base
                .join("out")
                .join(format!("manual.{}", container.extension()));
            let created = pack_archive(
                src.to_str().unwrap(),
                true,
                "deadbeef",
                container,
                None,
                Some(dest.to_str().unwrap()),
            )
            .unwrap();
            assert_eq!(PathBuf::from(&created), dest, "архив должен лечь по заданному пути");
            assert!(dest.is_file());

            // И распаковывается как обычно (контейнер по magic).
            let unpack_dir = base.join(format!("unpack-{}", container.as_str()));
            assert_eq!(
                unpack_archive(dest.to_str().unwrap(), unpack_dir.to_str().unwrap()).unwrap(),
                container
            );
            assert_eq!(
                fs::read(unpack_dir.join("fw.bin")).unwrap(),
                b"explicit output"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    // ── Прогресс «Архиватора» (детерминированная полоса) ────────────────────
    // RED (test-first): `pack_archive`/`unpack_archive` были «чёрными ящиками» —
    // UI показывал только пульс «⏳», процента не было. Теперь колбэк обязан
    // получать монотонные кадры в БАЙТАХ и финальный кадр `(total, total)`;
    // иначе полоса висит на 0 % или не доходит до 100 %.

    /// Три файла по 300 КиБ: больше буфера io::copy, значит кадров будет ≥2.
    fn seed_progress_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "firmware-core-progress-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.bin"), vec![1u8; 300 * 1024]).unwrap();
        fs::write(src.join("sub/b.bin"), vec![2u8; 300 * 1024]).unwrap();
        fs::write(src.join("sub/c.bin"), vec![3u8; 300 * 1024]).unwrap();
        (base, src)
    }

    /// Инварианты кадров: total неизменен, processed монотонен и ≤ total,
    /// последний кадр — `(total, total)`.
    fn assert_progress_frames(frames: &[(u64, u64)], expected_total: u64) {
        assert!(
            frames.len() >= 2,
            "ожидалось ≥2 кадра прогресса, пришло {}",
            frames.len()
        );
        assert_eq!(
            frames[0].1, expected_total,
            "total в первом кадре должен равняться ожидаемому"
        );
        let mut prev = 0u64;
        for (processed, total) in frames {
            assert_eq!(
                *total, expected_total,
                "total не должен меняться по ходу операции"
            );
            assert!(
                *processed >= prev,
                "прогресс обязан быть монотонным: {processed} < {prev}"
            );
            assert!(
                *processed <= expected_total,
                "processed не может превышать total: {processed} > {expected_total}"
            );
            prev = *processed;
        }
        assert_eq!(
            frames.last().copied(),
            Some((expected_total, expected_total)),
            "финальный кадр обязан быть 100 %"
        );
    }

    #[test]
    fn zip_pack_reports_monotonic_progress_and_final_frame() {
        let (base, src) = seed_progress_fixture("pack");
        let dest = base.join("out.zip");
        let expected_total = 3 * 300 * 1024;

        let mut frames: Vec<(u64, u64)> = Vec::new();
        {
            let mut on_progress = |processed: u64, total: u64| frames.push((processed, total));
            create_archive_at_with_progress(
                src.to_str().unwrap(),
                true,
                "cafebabe0000",
                None,
                Some(dest.to_str().unwrap()),
                &mut on_progress,
            )
            .expect("create_archive_at_with_progress");
        }

        assert_progress_frames(&frames, expected_total);
        assert!(dest.is_file(), "архив обязан быть создан");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn zip_unpack_reports_monotonic_progress_and_final_frame() {
        let (base, src) = seed_progress_fixture("unpack");
        // Путь архива — ЯВНЫЙ и внутри своего каталога: temp-архивы с общим
        // `bundle_hash` делят имя (`src_cafebabe0000.zip`), и параллельные тесты
        // читают чужой недописанный файл (ложный «corrupt deflate stream»).
        let archive = base.join("fixture.zip");
        create_archive_at(
            src.to_str().unwrap(),
            true,
            "cafebabe0000",
            None,
            Some(archive.to_str().unwrap()),
        )
        .expect("create_archive_at");
        // База прогресса распаковки — размер САМОГО архива (сжатые байты):
        // клиент не знает распакованный размер до конца операции.
        let expected_total = fs::metadata(&archive).unwrap().len();
        let out = base.join("out");

        let mut frames: Vec<(u64, u64)> = Vec::new();
        {
            let mut on_progress = |processed: u64, total: u64| frames.push((processed, total));
            extract_archive_with_progress(
                archive.to_str().unwrap(),
                out.to_str().unwrap(),
                &mut on_progress,
            )
            .expect("extract_archive_with_progress");
        }

        assert_progress_frames(&frames, expected_total);
        assert!(out.join("a.bin").is_file(), "содержимое обязано распаковаться");
        let _ = fs::remove_file(&archive);
        let _ = fs::remove_dir_all(&base);
    }
}
