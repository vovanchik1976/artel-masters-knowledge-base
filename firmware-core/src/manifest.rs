/// Типы данных для manifest-файлов (сериализация/десериализация)
///
/// Все типы портируемые — не имеют зависимостей от Tauri.
/// Могут использоваться в CLI, серверной обработке, Android FFI.

use serde::{Deserialize, Serialize};

/// Целевой файл прошивки внутри бандла
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(rename = "kind")]
    pub kind: String, // "firmware" | "other"
}

/// Часть после split
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartInfo {
    pub index: u32,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tg_file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tg_file_unique_id: Option<String>,
}

/// Manifest бандла (папка или один большой файл)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub bundle_type: String, // "firmware_bundle" | "firmware_file"
    pub original_name: String,
    pub source_kind: String, // "directory" | "file"
    pub files: Vec<TargetFile>,
    pub bundle_sha256: String,
    pub parts: Vec<PartInfo>,
}

/// Результат сканирования (возвращается из Rust в JS)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub files: Vec<TargetFile>,
    pub total_size: u64,
    pub bundle_sha256: String,
}

/// Информация о пути (файл или папка)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathInfo {
    pub size: u64,
    pub is_dir: bool,
    pub name: String,
}

/// Результат split
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPart {
    pub index: u32,
    pub path: String,
    pub size: u64,
    /// SHA256 — опционально. Может быть None, если хэш считается позже
    /// (например, во время upload_part_file). Раньше считался в split_file,
    /// но это замедляло split в 2x — перенесено в upload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}
