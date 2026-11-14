/// # firmware-core
///
/// Портируемая библиотека для работы с файлами прошивок.
/// Не имеет зависимостей от Tauri — может использоваться в CLI,
/// серверной обработке, Android FFI.
///
/// ## Модули
///
/// * [`manifest`] — типы данных для сериализации/десериализации
/// * [`hash`] — SHA256-хэширование файлов
/// * [`scanner`] — сканирование директорий, фильтрация, параллельный hash
/// * [`archive`] — zip/tar.zst архивация (контейнеры, pack/unpack)
/// * [`tar_zst`] — tar.zst (zstd) — скоростной контейнер Фазы 3

pub mod archive;
pub mod hash;
pub mod manifest;
pub mod scanner;
pub mod tar_zst;
