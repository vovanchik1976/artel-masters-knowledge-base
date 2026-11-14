/// SHA256-хэширование файлов (потоковое, без загрузки в RAM)
///
/// Выделено из scanner.rs для независимого использования.

use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// SHA256 файла (потоково, буфер 64 KB)
pub fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let start = std::time::Instant::now();
    let file = fs::File::open(path)
        .map_err(|e| anyhow::anyhow!("Failed to open {}: {}", path.display(), e))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let result = hex::encode(hasher.finalize());
    println!("DEBUG: hash of {} finished in {:?}", path.display(), start.elapsed());
    Ok(result)
}
