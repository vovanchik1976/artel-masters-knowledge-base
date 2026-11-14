//! Перекодировка локальных путей для sidecar, запущенного под wine
//! (=32-битный e2e-профиль: engine-core.exe + релизная ia32-DLL под wine).
//!
//! GUI (Electron на Linux) отдаёт нативные Linux-пути (`/home/...), а
//! Windows-бинарь под wine открывает файлы только Windows-путями. wine по
//! умолчанию монтирует корень `/` как `Z:\`, поэтому `/a/b` → `Z:\a\b`.
use std::env;

/// Чистая трансформация — покрыта юнит-тестами (env — через обёртку).
pub fn map_wine_path(path: &str, wine_mode: bool) -> String {
    if wine_mode && path.starts_with('/') {
        format!("Z:{}", path.replace('/', "\\"))
    } else {
        path.to_string()
    }
}

/// Текущий режим wine (env `ENGINE_WINE_Z_DRIVE=1`), выставляется e2e-профилем.
pub fn wine_mode_active() -> bool {
    env::var("ENGINE_WINE_Z_DRIVE").as_deref() == Ok("1")
}

/// Применить трансформацию к пути из RPC-параметра.
pub fn runtime_path(path: &str) -> String {
    map_wine_path(path, wine_mode_active())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_path_becomes_z_drive_under_wine() {
        assert_eq!(
            map_wine_path("/home/mega/f.bin", true),
            "Z:\\home\\mega\\f.bin")
    }

    #[test]
    fn unix_path_kept_outside_wine_mode() {
        assert_eq!(map_wine_path("/tmp/f.bin", false), "/tmp/f.bin");
        // дажe в wine верный вин не relative не трогаем (нет '/' в начале):
        assert_eq!(map_wine_path("f.bin", true), "f.bin");
    }

    #[test]
    fn windows_path_unchanged_even_in_wine_mode() {
        assert_eq!(map_wine_path("C:\\data\\f.bin", true), "C:\\data\\f.bin");
        assert_eq!(map_wine_path("Z:\\nope", true), "Z:\\nope");
    }
}