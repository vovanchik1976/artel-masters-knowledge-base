//! Дворник temp-мусора клиента — единая точка входа для RPC-команды
//! `cleanup_stale_archives` (вызывается из UI, `JanitorPolicy.buildJanitorRequest`).
//!
//! Чистит:
//!   1. `temp_dir()/firmware-desktop/*.zip|*.zst` — temp-архивы upload;
//!   2. `temp_dir()/tdlib_upload_parts/*.part` — слайсы multi-upload `{pid}_{i}.part`;
//!   3. (только на `startup`) файловый кеш TDLib — [`cache_dirs`], рекурсивно;
//!   4. (только на `startup`) медиа-кеш карточек — [`media_cache_dir`] (SP-15 срез 5).
//!
//! Почему кеш чистится именно на СТАРТЕ: он общий на TDLib-сессию, и upload с
//! download живут в разных вкладках параллельно. Операционный вызов (`op-end` /
//! `cancel`) обязан кеш НЕ трогать — иначе снесёт кеш живого параллельного
//! download (та же логика, что `JanitorPolicy.shouldPurgeTdlibCacheOnCancel`).
//! На старте передач не существует вовсе, поэтому чистка безопасна и закрывает
//! дыру: без неё кеш подчищался только после УСПЕШНОГО download (BUG-UX-001)
//! или вручную кнопкой, а пользователь, который только заливает прошивки,
//! копил его бесконечно (Windows: `%LOCALAPPDATA%\firmware-desktop-electron\tdlib_files`).
//!
//! БД/состояние TDLib (`state_root_dir`, `…/{api_id}/user`) НЕ трогаются никогда:
//! их удаление = потеря сессии.

/// Каталоги ФАЙЛОВОГО кеша TDLib (не БД!).
///
/// Источник — `crate::tdlib_runtime::files_dir()` (Windows: `%LOCALAPPDATA%`,
/// Linux-dev: `/tmp/tdlib_files_electron`) плюс legacy-каталог
/// `temp_dir()/tdlib_download_parts` (исторические части download; писался
/// старыми сборками, сейчас только чистится — см. `upload::clear_cache`).
pub fn cache_dirs() -> Vec<String> {
    vec![
        crate::tdlib_runtime::files_dir(),
        std::env::temp_dir()
            .join("tdlib_download_parts")
            .to_string_lossy()
            .to_string(),
    ]
}

/// Каталог медиа-кеша карточек (`<temp>/firmware-desktop/media`) — SP-15 срез 5 (D-071).
///
/// Галерея карточки качает превью/оригинал СВОИМ TDLib (как прошивку), а разметка
/// показывает `file://` — значит каталог обязан быть предсказуемым и общим для
/// движка (сюда складывает `downloadFile`) и UI (RPC-команда `media_cache_dir`).
pub fn media_cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("firmware-desktop").join("media")
}

/// Снести файлы медиа-кеша в явно заданном каталоге (число удалённых).
///
/// Вынесено с инъекцией каталога — тест герметичен (прод-путь [`purge_media_cache`]).
pub fn purge_media_dir(dir: &std::path::Path) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Снести медиа-кеш карточек (прод-путь).
///
/// Только СТАРТ (тот же инвариант, что у файлового кеша TDLib): операционный
/// вызов (`op-end`/`cancel`) обязан медиа НЕ трогать — иначе снесёт файлы, на
/// которые уже смотрят `file://`-превью открытой карточки.
pub fn purge_media_cache() -> usize {
    purge_media_dir(&media_cache_dir())
}

/// Применить кеш-ветку к результату базового свипа (чистая по эффекту часть дворника).
///
/// Вынесена отдельно, чтобы тесты кеш-ветки были ГЕРМЕТИЧНЫ: базовый свип
/// (`firmware_core::archive::cleanup_stale_archives`) трогает ОБЩИЕ
/// `temp/firmware-desktop` / `temp/tdlib_upload_parts`, и его вызов из
/// параллельного теста удалял бы фикстуры соседних тестов m2 (реальная гонка —
/// флаки-падения `pack_unpack_tar_zst_dispatch_roundtrip` /
/// `create_archive_dispatch_roundtrip`).
///
/// `include_tdlib_cache=false` → кеш не трогаем (операционный вызов).
/// `true` → плюс рекурсивная чистка ФАЙЛОВ в `cache_dirs` (стартовый вызов):
/// каталогов и БД состояния TDLib не касаемся (`purge_cache_dirs`).
pub fn apply_cache_sweep(
    base_removed: usize,
    include_tdlib_cache: bool,
    cache_dirs: &[String],
) -> usize {
    if !include_tdlib_cache {
        return base_removed;
    }
    base_removed + crate::tdlib_runtime::purge_cache_dirs(cache_dirs)
}

/// Свип temp-архивов/слайсов + (опционально) кеша, с явными каталогами кеша
/// (инъекция; прод-путь — [`sweep`]).
pub fn sweep_with_cache_dirs(
    max_age_secs: u64,
    include_tdlib_cache: bool,
    cache_dirs: &[String],
) -> usize {
    let mut swept = firmware_core::archive::cleanup_stale_archives(max_age_secs).unwrap_or(0);
    // SP-15 срез 5: медиа-кеш карточек чистится ТОЛЬКО стартовым вызовом
    // (`include_tdlib_cache=true`) — по той же причине, что файловый кеш TDLib:
    // операционный снос убил бы `file://`-превью уже открытой карточки.
    if include_tdlib_cache {
        swept += purge_media_cache();
    }
    apply_cache_sweep(swept, include_tdlib_cache, cache_dirs)
}

/// Прод-форма: порог + флаг «чистить ли кеш TDLib». Возвращает число удалённых файлов.
pub fn sweep(max_age_secs: u64, include_tdlib_cache: bool) -> usize {
    sweep_with_cache_dirs(max_age_secs, include_tdlib_cache, &cache_dirs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn probe_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("engine-core-janitor-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// RED (test-first, 2026-09-27): стартовый дворник чистит и файловый кеш TDLib.
    ///
    /// До фикса кеш не чистился вообще: удаление жило только в `purge_cache_after_success`
    /// (после УСПЕШНОГО download) и в ручной кнопке → у пользователя, который только
    /// заливает, кеш рос бесконечно (Windows: `%LOCALAPPDATA%`).
    ///
    /// Тест ГЕРМЕТИЧЕН: проверяет кеш-ветку `apply_cache_sweep`, НЕ дергая базовый
    /// свип, который чистит общий `temp/firmware-desktop` и гонялся бы с тестами m2.
    #[test]
    fn startup_sweep_purges_tdlib_cache() {
        let cache = probe_dir("cache-red");
        let nested = cache.join("documents");
        fs::create_dir_all(&nested).unwrap();
        let probe = nested.join("4220_0.part");
        fs::write(&probe, vec![7u8; 32]).unwrap();

        let dirs = vec![cache.to_string_lossy().to_string()];
        let _ = apply_cache_sweep(0, true, &dirs);

        assert!(
            !probe.exists(),
            "стартовый дворник обязан рекурсивно снести файловый кеш TDLib"
        );
        let _ = fs::remove_dir_all(&cache);
    }

    /// Операционный вызов (`op-end`/`cancel`) кеш НЕ трогает: он общий на сессию,
    /// параллельный download в другой вкладке потерял бы свои части.
    #[test]
    fn operational_sweep_keeps_tdlib_cache() {
        let cache = probe_dir("cache-guard");
        let probe = cache.join("documents").join("in-flight.part");
        fs::create_dir_all(probe.parent().unwrap()).unwrap();
        fs::write(&probe, vec![9u8; 32]).unwrap();

        let dirs = vec![cache.to_string_lossy().to_string()];
        let _ = apply_cache_sweep(0, false, &dirs);

        assert!(probe.exists(), "include_tdlib_cache=false обязан не трогать кеш");
        let _ = fs::remove_dir_all(&cache);
    }

    /// Список каталогов кеша: файлы TDLib + legacy-каталог частей download.
    #[test]
    fn cache_dirs_contains_files_dir_and_legacy_parts() {
        let dirs = cache_dirs();
        assert!(dirs.iter().any(|d| d == &crate::tdlib_runtime::files_dir()));
        assert!(
            dirs.iter().any(|d| d.ends_with("tdlib_download_parts")),
            "legacy-каталог частей download обязан попадать в свип: {dirs:?}"
        );
    }

    /// SP-15 срез 5 (D-071): медиа-кеш карточек — файлы в `<temp>/firmware-desktop/media`.
    #[test]
    fn media_cache_dir_is_under_firmware_desktop_temp() {
        let dir = media_cache_dir();
        assert!(
            dir.ends_with("media"),
            "каталог медиа-кеша обязан быть .../firmware-desktop/media: {dir:?}"
        );
        assert_eq!(dir.parent().unwrap().file_name().unwrap(), "firmware-desktop");
    }

    /// Стартовый снос медиа-кеша: файлы уходят, подкаталоги не трогаются
    /// (инъекция каталога — тест герметичен, общий temp не задет).
    #[test]
    fn purge_media_dir_removes_files_only() {
        let dir = probe_dir("media-purge");
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.join("a.img"), vec![1u8; 8]).unwrap();
        fs::write(dir.join("b.img"), vec![2u8; 8]).unwrap();
        fs::write(nested.join("keep.img"), vec![3u8; 8]).unwrap();

        let removed = purge_media_dir(&dir);

        assert_eq!(removed, 2, "обязаны снести оба файла кеша");
        assert!(!dir.join("a.img").exists());
        assert!(!dir.join("b.img").exists());
        assert!(nested.join("keep.img").exists(), "подкаталоги не трогаем");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Снос медиа-кеша обязан быть привязан к СТАРТОВОМУ свипу: операционный
    /// (`include_tdlib_cache=false`) не должен трогать файлы, на которые смотрят
    /// `file://`-превью открытой карточки.
    #[test]
    fn operational_sweep_keeps_media_cache() {
        let probe = media_cache_dir().join("probe-operational.img");
        fs::create_dir_all(media_cache_dir()).unwrap();
        fs::write(&probe, vec![5u8; 8]).unwrap();
        // include_tdlib_cache=false → ветка кеша не вызывается вовсе.
        let removed = apply_cache_sweep(0, false, &[]);
        assert_eq!(removed, 0);
        assert!(probe.exists(), "операционный свип обязан не трогать медиа-кеш");
        let _ = fs::remove_file(&probe);
    }
}
