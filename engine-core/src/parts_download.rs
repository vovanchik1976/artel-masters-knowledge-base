//! M4a3-шаг2 — multi / vault / composite download (несколько частей → один файл).
//!
//! Что делает (зеркало mainline `tdlib_download.rs` «Sequential Part Accumulator»):
//!   для каждой части (по возрастанию `part_index`):
//!     1. `getRemoteFile(tg_file_id)` → локальный TDLib `file_id`;
//!     2. `downloadFile{file_id, synchronous=true, priority=1}` — ответ приходит
//!        ПОСЛЕ полной загрузки (прогресс идёт потоком `updateFile`);
//!     3. (если задан) SHA-256-верификация скачанного сегмента;
//!     4. потоковое дописывание сегмента в целевой файл.
//!
//! Три режима различаются только контрактом событий (поля, что ждёт UI):
//!   - `Multi`  → `tdlib-multi-download-progress` (current_part_index/total_parts);
//!   - `Vault`  → то же событие (UI-код vault-загрузки слушает его);
//!   - `Composite` → `tdlib-composite-progress` + финальный `tdlib-download-merged`.
//!
//! ⚠️ Склейка выполняется ПОСЛЕДОВАТЕЛЬНО (части одного бандла идут по порядку
//! `part_index`): mainline тоже обеспечивает порядок, а «рваная» параллельность
//! здесь дала бы неверный итоговый файл.
//!
//! ⚠️ ИНВАРИАНТ ПРОГРЕССА (BUG-DOWNLOAD-048): TDLib `file_id` части
//! регистрируется в `file_index` СРАЗУ после `getRemoteFile` и ДО
//! `downloadFile{synchronous:true}`. Ответ `downloadFile` приходит только после
//! полной загрузки, поэтому при регистрации «после» весь поток `updateFile`
//! во время передачи отбрасывается → UI-прогресс замирает на 0%/одном месте и
//! прыгает лишь на границах частей. По завершении части запись снимается
//! (поздний `updateFile` не должен искажать `current_downloaded`).
//! Паритет: `download::start_download` регистрирует file_id до отправки запроса.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::download;
use crate::tdlib_runtime::TdlibRuntime;

/// Максимальное время на одну часть (карта скорости непредсказуема).
const PART_TIMEOUT: Duration = Duration::from_secs(6 * 3600);
/// Watchdog (BUG-DOWNLOAD-049): нет прироста байт дольше этого времени →
/// часть считается «зависшей» (обрыв сети во время
/// `downloadFile{synchronous:true}` молча ждёт до `PART_TIMEOUT` = 6ч, а UI
/// показывает вечный «⏳ Соединение…»). Реальный источник прерывает запрос
/// (`cancelDownloadFile`) и возвращает Err с `STALL_MARKER`; `process_part`
/// пере-качивает часть — TDLib продолжает с частичного кеша.
pub const PART_STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Сколько попыток на одну часть после watchdog-обрыва (защита от цикла).
pub const PART_MAX_ATTEMPTS: usize = 3;
/// Как часто watchdog проверяет прогресс, пока `fetch` блокирует поток.
const STALL_POLL: Duration = Duration::from_millis(250);
/// Маркер «по части нет прогресса» — по нему `process_part` отличает
/// ретраибельный обрыв от детерминированной ошибки (её ретраить нельзя).
const STALL_MARKER: &str = "no progress for";
/// Не чаще 1 события в 150мс.
const EMIT_INTERVAL: Duration = Duration::from_millis(150);
/// Период RCA-выборки прогресса multi (тайм-серия `[dl-rca] phase=progress`).
const PROGRESS_RCA_INTERVAL: Duration = Duration::from_millis(5_000);

/// Download-RCA в файл (Linux-dev, e2e-prod32): зеркало `download::rca_log`
/// (та же строка `[dl-rca]` в stderr → `engine-core.log`). Отдельная функция —
/// чтобы multi-ветка не тянула зависимость от single-модуля ради лога.
///
/// BUG-RCA-LOG-FRAG-001: строка собирается заранее и уходит ОДНИМ `write` —
/// `eprintln!("[dl-rca] {}", value)` фрагментирует строку на десятки мелких
/// `write` (небуферизованный stderr), из-за чего timestamp-префикс
/// `SidecarManager` попадал в середину JSON.
fn rca_line_multi(op: &str, phase: &str, fields: Value) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("op".to_string(), Value::String(op.to_string()));
    obj.insert("phase".to_string(), Value::String(phase.to_string()));
    if let Value::Object(map) = fields {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    format!("[dl-rca] {}\n", Value::Object(obj))
}

/// Записать готовую RCA-строку одним `write` (вне state-замка).
fn write_rca_line_multi(line: &str) {
    let stderr = std::io::stderr();
    let _ = stderr.lock().write_all(line.as_bytes());
}

fn rca_log_multi(op: &str, phase: &str, fields: Value) {
    write_rca_line_multi(&rca_line_multi(op, phase, fields));
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Multi,
    Vault,
    Composite,
}

pub fn mode_from_str(s: &str) -> Mode {
    match s {
        "composite" => Mode::Composite,
        "vault" => Mode::Vault,
        _ => Mode::Multi,
    }
}

/// Описание части (UI: MultiPartDescriptor / RemotePartDescriptor).
#[derive(Clone, Debug)]
pub struct PartDesc {
    pub tg_file_id: String,
    pub part_index: usize,
    pub expected_sha256: Option<String>,
    pub expected_size: Option<u64>,
    /// BUG-DOWNLOAD-051: PM-якорь доставки части (pm_lease) — чат PM юзера
    /// (для клиента это id бота).
    pub pm_chat_id: Option<i64>,
    /// BUG-DOWNLOAD-051: bot-side message_id delivery-сообщения в PM.
    pub pm_message_id: Option<i64>,
    /// BUG-DOWNLOAD-052: `tg_file_unique_id` части — сессионно-независимый
    /// ключ документа (TDLib `document.document.remote.unique_id`). Различает
    /// части с ОДИНАКОВЫМ размером (files.id=38) и не сбивается посторонними
    /// документами в окне истории PM.
    pub pm_unique_id: Option<String>,
    /// BUG-DOWNLOAD-051: сколько более НОВЫХ частей имеют тот же `expected_size`
    /// (части доставлены в порядке `part_index` → последняя = самая свежая в
    /// истории PM). Нужен для выбора правильного документа при равных размерах.
    pub pm_skip: usize,
}

impl PartDesc {
    /// Часть без PM-якорей (direct_vault / legacy-вызовы).
    ///
    /// Только для тестов: боевой путь собирает части в [`parse_parts`] (там же
    /// считаются `pm_skip` и проверяются якоря доставки), поэтому в release-сборке
    /// функция не нужна и не должна давать `dead_code`-шум.
    #[cfg(test)]
    pub fn new(
        tg_file_id: String,
        part_index: usize,
        expected_sha256: Option<String>,
        expected_size: Option<u64>,
    ) -> Self {
        Self {
            tg_file_id,
            part_index,
            expected_sha256,
            expected_size,
            pm_chat_id: None,
            pm_message_id: None,
            pm_unique_id: None,
            pm_skip: 0,
        }
    }
}

/// Собрать части из JSON (устойчиво к camelCase/snake_case).
pub fn parse_parts(params: &Value) -> Result<Vec<PartDesc>, String> {
    let arr = params
        .get("parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "parts[] required".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, p) in arr.iter().enumerate() {
        let tg_file_id = p
            .get("tg_file_id")
            .or_else(|| p.get("tgFileId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let part_index = p
            .get("part_index")
            .or_else(|| p.get("partIndex"))
            .and_then(|v| v.as_u64())
            .unwrap_or(i as u64) as usize;
        let expected_sha256 = p
            .get("expected_sha256")
            .or_else(|| p.get("expectedSha256"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase())
            .filter(|s| !s.is_empty());
        let expected_size = p
            .get("expected_size")
            .or_else(|| p.get("expectedSize"))
            .and_then(|v| v.as_u64());
        // BUG-DOWNLOAD-051: пер-частовый PM-якорь доставки (pm_lease). Значения
        // > 0: 0/отсутствие = якоря нет (pm_delivery не пришёл → direct_vault либо
        // legacy-клиент/сервер).
        let pm_chat_id = p
            .get("pm_chat_id")
            .or_else(|| p.get("pmChatId"))
            .and_then(|v| v.as_i64())
            .filter(|v| *v != 0);
        let pm_message_id = p
            .get("pm_message_id")
            .or_else(|| p.get("pmMessageId"))
            .and_then(|v| v.as_i64())
            .filter(|v| *v != 0);
        // BUG-DOWNLOAD-052: стабильный ключ документа части (TDLib
        // remote.unique_id = Bot-API file_unique_id). Пустая строка = ключа нет
        // (legacy-сервер/клиент) → резолв по размеру+позиции.
        let pm_unique_id = p
            .get("pm_unique_id")
            .or_else(|| p.get("pmUniqueId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        // BUG-DOWNLOAD-052 (фаза 3, owner-backdoor): части ЛИЧНОГО файла доставлены
        // ботом в PM владельца, а клиентский `tg_file_id` для чужой сессии
        // невалиден → достаточно pm-якоря доставки (`pm_chat_id`+`pm_message_id`
        // либо `pm_unique_id`). Пустой tg_file_id допустим ТОЛЬКО в этом случае.
        let has_pm_anchor = (pm_chat_id.is_some() && pm_message_id.is_some())
            || pm_unique_id.is_some();
        if tg_file_id.is_empty() && !has_pm_anchor {
            return Err(format!(
                "parts[{i}]: пустой tg_file_id (нет ни remote id, ни pm-якоря доставки)"
            ));
        }
        out.push(PartDesc {
            tg_file_id,
            part_index,
            expected_sha256,
            expected_size,
            pm_chat_id,
            pm_message_id,
            pm_unique_id,
            pm_skip: 0,
        });
    }
    // Порядок частей критичен для склейки.
    out.sort_by_key(|p| p.part_index);
    // BUG-DOWNLOAD-051: сдвиг среди ОДНОРАЗМЕРНЫХ частей (последняя доставленная
    // = самая свежая в PM). Без размера — сдвиг по полному числу частей.
    let total = out.len();
    for i in 0..total {
        let size = out[i].expected_size.filter(|s| *s > 0);
        out[i].pm_skip = match size {
            Some(s) => out[i + 1..]
                .iter()
                .filter(|q| q.expected_size == Some(s))
                .count(),
            None => total - 1 - i,
        };
    }
    Ok(out)
}

// ── Состояние задания ────────────────────────────────────────────────────────

pub struct JobState {
    pub download_id: String,
    pub mode: Mode,
    pub total_parts: usize,
    pub current_part_index: usize,
    /// Сумма байт уже влитых частей.
    pub completed_bytes: u64,
    /// Скачано в текущей части (из updateFile).
    pub current_downloaded: u64,
    pub current_total: u64,
    pub total_bytes: u64,
    pub current_file_id: i32,
    /// `remote.id` текущей части (из `updateFile`).
    ///
    /// По нему после завершения части опознаём её «зеркальный» `file.id` (копия
    /// документа доставки в другом чате) — он в реестре не заводится, а TDLib
    /// шлёт по нему финальный `updateFile` (BUG-RCA-SPAM-002).
    pub remote_id: String,
    pub completed: bool,
    pub error: Option<String>,
    pub cancelled: bool,
    pub output_path: String,
    pub file_name: Option<String>,
    pub last_emit: Option<Instant>,
    pub last_bytes: u64,
    pub last_ts: Option<Instant>,
    pub speed: u64,
    /// Время последнего сигнала «жизни» (любой `emit_progress`, включая
    /// `updateFile`). Watchdog сравнивает с ним wall-clock (BUG-DOWNLOAD-049).
    pub last_progress_at: Instant,
    /// Время последней RCA-выборки прогресса (`[dl-rca] phase=progress`).
    ///
    /// У multi-конвейера аналога single-серии не было: при обрыве сети в логе
    /// оставались только АГРЕГАТЫ `part_fetch` (одна строка на часть), поэтому
    /// «плато» внутри части (в т.ч. внутренний FLOOD_WAIT TDLib — он приходит
    /// МОЛЧАНИЕМ прогресса, а не текстом 429) локализовать было нечем.
    pub last_rca: Option<Instant>,
}

type Shared = Arc<Mutex<JobState>>;

fn registry() -> &'static Mutex<HashMap<String, Shared>> {
    static REG: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_index() -> &'static Mutex<HashMap<i32, String>> {
    static IDX: OnceLock<Mutex<HashMap<i32, String>>> = OnceLock::new();
    IDX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `true`, если `remote_id` — АКТИВНАЯ (незавершённая) часть составной загрузки.
///
/// Копия того же BUG-RCA-SPAM-002/003 на стороне части: событие по «зеркальному»
/// `file.id` приходит в тот же receive-батч, когда `part_fetch` завершается и в
/// `current_file_id` стоит наш id, а `mark_part_completed` ещё не вызван (на
/// самом деле событие может прийти в любом порядке с финальным). TTL-метки
/// работают ПОСЛЕ `mark_part_completed`, поэтому пока часть активна, её
/// `remote.id` («заголовок» текущей части) — достаточный признак владельца.
pub fn is_active_part_download_remote(remote_id: &str) -> bool {
    if remote_id.is_empty() {
        return false;
    }
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|state| {
            let st = state.lock().unwrap_or_else(|e| e.into_inner());
            !st.completed && !st.cancelled && st.error.is_none() && st.remote_id == remote_id
        })
}

/// `true`, если file_id — активная (незавершённая) часть составной загрузки.
///
/// Нужно upload-конвейеру: `updateFile` скачиваемой части не должен попадать в
/// upload как «race condition» (BUG-RCA-SPAM-001). Локи берём последовательно
/// (порядок file_index → registry → state, как в `on_update_file`), чтобы не
/// устроить дедлок.
pub fn is_active_part_download(file_id: i32) -> bool {
    let download_id = match file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
    {
        Some(d) => d,
        None => return false,
    };
    let state = match registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&download_id)
        .cloned()
    {
        Some(s) => s,
        None => return false,
    };
    let st = state.lock().unwrap_or_else(|e| e.into_inner());
    !st.completed && !st.cancelled && st.error.is_none()
}

/// Окно «file_id части ещё наш» после успешного завершения части (BUG-RCA-SPAM-002).
const RECENTLY_COMPLETED_TTL: Duration = Duration::from_secs(120);

/// Завершённая часть: file_id, `remote.id` и время завершения.
struct CompletedPart {
    file_id: i32,
    remote_id: String,
    at: Instant,
}

/// Последние завершённые части (см. `is_active_part_download`).
///
/// `file_index` запись части снимает сразу после склейки, а TDLib шлёт по ней
/// ФИНАЛЬНЫЙ `updateFile` ещё раз (и то же событие — по «зеркальному» file_id
/// документа доставки, которого в реестре нет вовсе). Раньше такие события
/// уходили в upload-конвейер как «race condition» → буфер `pending_updates`
/// (BUG-RCA-SPAM-002).
fn recently_completed_parts() -> &'static Mutex<Vec<CompletedPart>> {
    static DONE: OnceLock<Mutex<Vec<CompletedPart>>> = OnceLock::new();
    DONE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Пометить часть «только что завершена» (TTL см. `RECENTLY_COMPLETED_TTL`).
pub fn mark_part_completed(file_id: i32, remote_id: &str) {
    if file_id <= 0 {
        return;
    }
    let now = Instant::now();
    let mut done = recently_completed_parts()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    done.retain(|p| now.duration_since(p.at) < RECENTLY_COMPLETED_TTL);
    done.push(CompletedPart {
        file_id,
        remote_id: remote_id.to_string(),
        at: now,
    });
}

/// `true`, если file_id части завершился в пределах TTL (финальный `updateFile`).
pub fn is_recently_completed_part(file_id: i32) -> bool {
    if file_id <= 0 {
        return false;
    }
    let now = Instant::now();
    recently_completed_parts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|p| p.file_id == file_id && now.duration_since(p.at) < RECENTLY_COMPLETED_TTL)
}

/// `true`, если `remote_id` — файл ТОЛЬКО ЧТО завершённой части.
///
/// Зеркальный `file.id` доставки той же части в реестре не заводится, но
/// `remote.id` у него тот же — по нему и опознаём событие (BUG-RCA-SPAM-002).
pub fn is_recently_completed_part_remote(remote_id: &str) -> bool {
    if remote_id.is_empty() {
        return false;
    }
    let now = Instant::now();
    recently_completed_parts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|p| p.remote_id == remote_id && now.duration_since(p.at) < RECENTLY_COMPLETED_TTL)
}

/// Сброс реестра (при `tdlib_reset_auth`).
pub fn reset() {
    registry().lock().unwrap_or_else(|e| e.into_inner()).clear();
    file_index().lock().unwrap_or_else(|e| e.into_inner()).clear();
    // TTL-метки завершённых частей привязаны к file_id сессии — после сброса
    // авторизации они бессмысленны (BUG-RCA-SPAM-002).
    recently_completed_parts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

/// Только для тестов: очистить TTL-метки завершённых частей (изоляция тестов).
#[cfg(test)]
pub(crate) fn clear_completed_parts_for_test() {
    recently_completed_parts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

// ── stdout-кадры ─────────────────────────────────────────────────────────────

/// Целевой файл задания собран — безопасная точка пост-успешной чистки кеша
/// (BUG-UX-001, глобальный выбор пользователя: после КАЖДОГО успеха).
/// В воркере parts-загрузки: склейка завершена, кеш-файлы больше не читаются.
/// Только файловая чистка (`post_download_purge`, без TDLib-запросов):
/// БД-индексы/сессия целы, байты кеша (включая вложенные `documents/*.part`)
/// удаляются — TDLib при следующем скачивании докачает заново.
fn purge_cache_after_success() {
    crate::tdlib_runtime::post_download_purge();
}

fn emit_frame(value: &Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let payload = match serde_json::to_vec(value) {
        Ok(p) => p,
        Err(_) => return,
    };
    let len = payload.len() as u32;
    let _ = out.write_all(&len.to_be_bytes());
    let _ = out.write_all(&payload);
    let _ = out.flush();
}

fn emit_event(name: &str, payload: Value) {
    emit_frame(&json!({ "jsonrpc": "2.0", "event": name, "params": payload }));
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

/// sha256 файла (потоково, тихо — stdout занят кадрами).
pub fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Дописать файл `src` в конец `dst` (создаём при необходимости).
pub fn append_file(src: &Path, dst: &Path) -> Result<u64, String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let mut input = std::fs::File::open(src).map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dst)
        .map_err(|e| format!("open {}: {e}", dst.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    let mut written = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        written += n as u64;
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(written)
}

/// Проверка sha256 скачанного сегмента (если ожидается).
/// BUG-SHA256-001/Ф2: в текст ошибки добавляем размер файла — без него
/// mismatch «получено X, ожидалось Y» не отвечает, это битые байты,
/// усечение (см. size-guard) или неверный expected (дайджест вместо байтов).
pub fn verify_sha(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let Some(exp) = expected else { return Ok(()) };
    let actual = sha256_file_hex(path)?;
    if actual != exp.to_lowercase() {
        let size = std::fs::metadata(path)
            .map(|m| m.len().to_string())
            .unwrap_or_else(|_| "?".to_string());
        return Err(format!(
            "SHA-256 не совпал (size={size} bytes): получено {actual}, ожидалось {}",
            exp.to_lowercase()
        ));
    }
    Ok(())
}

// ── Прогресс ─────────────────────────────────────────────────────────────────

fn progress_payload(g: &JobState) -> Value {
    let downloaded = g.completed_bytes + g.current_downloaded;
    let total = g.total_bytes.max(downloaded);
    // Процента в контракте нет: UI считает его сам из downloaded_bytes/total_bytes
    // (`TdlibFfiMultiDownloadProgress` / `TdlibFfiCompositeStatus`).
    let eta = if g.speed > 0 && downloaded < total {
        (total - downloaded) / g.speed
    } else {
        0
    };
    match g.mode {
        Mode::Composite => json!({
            "download_id": g.download_id,
            "completed_parts": g.current_part_index,
            "total_parts": g.total_parts,
            "downloaded_bytes": downloaded,
            "total_bytes": total,
            "all_completed": g.completed,
            "output_path": if g.completed { Some(g.output_path.clone()) } else { None },
            "file_name": g.file_name,
        }),
        _ => json!({
            "download_id": g.download_id,
            "current_part_index": g.current_part_index,
            "total_parts": g.total_parts,
            "downloaded_bytes": downloaded,
            "total_bytes": total,
            "speed_bytes_per_sec": g.speed,
            "eta_secs": eta,
            "completed": g.completed,
            "error": g.error,
        }),
    }
}

fn emit_progress(state: &Shared, force: bool) {
    let (payload, rca) = {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let throttle = match (g.last_emit, force) {
            (Some(t), false) => now.duration_since(t) < EMIT_INTERVAL,
            _ => false,
        };
        if throttle {
            return;
        }
        g.last_emit = Some(now);
        // Любой эмит (старт части, updateFile, границы частей) — сигнал «жизни»
        // для watchdog'а (BUG-DOWNLOAD-049).
        g.last_progress_at = now;
        // RCA-тайм-серия (раз в PROGRESS_RCA_INTERVAL и на границах частей):
        // по ней видно «плато» скорости внутри части — в т.ч. внутренний
        // FLOOD_WAIT TDLib (наружу он приходит молчанием прогресса, а не 429).
        // `delta_ms` — интервал с предыдущей RCA-строки прогресса: в норме ~5с,
        // при плато/FLOOD_WAIT резко больше → видно без парсинга тайм-серии.
        let rca_delta_ms = g.last_rca.map_or(0, |t| now.duration_since(t).as_millis() as u64);
        let rca = if force
            || g.last_rca
                .map_or(true, |t| now.duration_since(t) >= PROGRESS_RCA_INTERVAL)
        {
            g.last_rca = Some(now);
            Some(rca_line_multi(
                "multi",
                "progress",
                json!({
                    "download_id": &g.download_id,
                    "part_index": g.current_part_index,
                    "part_file_id": g.current_file_id,
                    "part_downloaded": g.current_downloaded,
                    "part_total": g.current_total,
                    "downloaded": g.completed_bytes + g.current_downloaded,
                    "total": g.total_bytes.max(g.completed_bytes + g.current_downloaded),
                    "delta_ms": rca_delta_ms,
                }),
            ))
        } else {
            None
        };
        (progress_payload(&g), rca)
    };
    // Строку пишем ПОСЛЕ отпускания state-замка: I/O под ним задерживал бы
    // receive-поток (он обновляет то же состояние по каждому `updateFile`).
    if let Some(line) = rca {
        write_rca_line_multi(&line);
    }
    let mode = state.lock().unwrap_or_else(|e| e.into_inner()).mode;
    let name = match mode {
        Mode::Composite => "tdlib-composite-progress",
        _ => "tdlib-multi-download-progress",
    };
    emit_event(name, payload);
}

/// Сколько времени по заданию нет прогресса (`None` — прогресс свежий).
///
/// Watchdog BUG-DOWNLOAD-049: сравнивает wall-clock с `last_progress_at`
/// (обновляется на каждом `updateFile` и на старте части). Пока TDLib не шлёт
/// байты (обрыв сети, «зависший» synchronous-download), значение не движется —
/// именно по этому признаку прерываем бесполезное ожидание.
fn stalled_for(state: &Shared, limit: Duration) -> Option<Duration> {
    let g = state.lock().unwrap_or_else(|e| e.into_inner());
    let idle = Instant::now().duration_since(g.last_progress_at);
    if idle > limit {
        Some(idle)
    } else {
        None
    }
}

/// Ретраибельный ли обрыв (по маркеру `STALL_MARKER`).
///
/// Отличает «сеть/движок молчит» (повтор осмыслен) от детерминированной
/// ошибки (`пустой local.path`, sha-mismatch, отмена) — её ретраить нельзя.
fn is_stall_error(err: &str) -> bool {
    err.contains(STALL_MARKER)
}

/// `updateFile` из receive-loop → интра-парт прогресс (и агрегат).
pub fn on_update_file(val: &Value) -> bool {
    if val["@type"].as_str() != Some("updateFile") {
        return false;
    }
    let file = &val["file"];
    let file_id = file["id"].as_i64().unwrap_or(0) as i32;
    if file_id == 0 {
        return false;
    }
    let download_id = match file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
    {
        Some(d) => d,
        None => return false,
    };
    let state = match registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&download_id)
        .cloned()
    {
        Some(s) => s,
        None => return false,
    };

    let local = &file["local"];
    let downloaded = local["downloaded_size"].as_u64().unwrap_or(0);
    let total = file["size"]
        .as_u64()
        .or_else(|| file["expected_size"].as_u64())
        .unwrap_or(0);

    {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        if g.cancelled {
            return true;
        }
        // Принимаем прогресс ТОЛЬКО от активной части: отменённая попытка
        // оставляет свой file_id в `file_index`, и поздний `updateFile` по нему
        // не должен искажать прогресс новой попытки (retry с тем же download_id).
        if g.current_file_id != file_id {
            return false;
        }
        // BUG-RCA-SPAM-002: `remote.id` части — чтобы после её завершения опознать
        // «зеркальный» `file.id` (копия документа доставки), которого в реестре нет,
        // но по которому TDLib шлёт финальный `updateFile` того же remote-файла.
        if let Some(rid) = file["remote"]["id"].as_str().filter(|s| !s.is_empty()) {
            g.remote_id = rid.to_string();
        }
        g.current_downloaded = downloaded;
        if total > 0 {
            g.current_total = total;
        }
        // скорость (EMA по дельтам)
        let now = Instant::now();
        let abs = g.completed_bytes + downloaded;
        if let Some(prev) = g.last_ts {
            let dt = now.duration_since(prev).as_secs_f64();
            if dt > 0.0 && abs >= g.last_bytes {
                let instant = ((abs - g.last_bytes) as f64 / dt) as u64;
                g.speed = if g.speed == 0 { instant } else { (g.speed * 3 + instant) / 4 };
            }
        }
        g.last_ts = Some(now);
        g.last_bytes = abs;
        // Байты пришли — часть живая (watchdog-таймер сбрасывается).
        g.last_progress_at = now;
    }
    emit_progress(&state, false);
    true
}

// ── Основной воркер ──────────────────────────────────────────────────────────

/// Источник данных части — seam для тестов порядка регистрации `file_id`.
///
/// Разделён на `resolve` (getRemoteFile → TDLib `file_id`) и `fetch`
/// (downloadFile{synchronous=true} → локальный путь кэша): именно между ними
/// `process_part` обязан зарегистрировать `file_id` (BUG-DOWNLOAD-048).
pub trait PartSource {
    /// `remote_file_id` → TDLib-внутренний `file_id`.
    fn resolve(&self, part: &PartDesc) -> Result<i32, String>;
    /// Полная загрузка части; возвращает путь в кэше TDLib.
    fn fetch(&self, file_id: i32, part: &PartDesc) -> Result<std::path::PathBuf, String>;
    /// Снять кеш TDLib у ПРИНЯТОЙ части (после склейки и size-guard).
    ///
    /// TDLib держит скачанное в своём кеше до явного `deleteFile`, а
    /// `purge_cache_after_success` зовётся ОДИН раз в конце задания — без этого
    /// target и кеш ВСЕХ частей лежат на диске одновременно (files.id=38:
    /// 2 × 2.09 ГБ ≈ 8.4 ГБ пика; на Win7/8 со скромным C: это ENOSPC, а не
    /// «просто медленнее») — BUG-PART-CACHE-PEAK-001.
    ///
    /// Вызывается ТОЛЬКО на успехе части: до приёмки её кеш — источник resume
    /// для stall-ретрая (BUG-DOWNLOAD-049) и материал для повторного разбора.
    /// Вызывается на успехе части И на sha-mismatch: неверные байты повторять
    /// бессмысленно, а держать их в кеше — значит гарантированно падать снова
    /// (BUG-CABINET-VAULT-SHA-MISMATCH-001). Для stall-ретрая (BUG-DOWNLOAD-049)
    /// и для size-guard (обрезанный кеш = материал resume) кеш НЕ снимается.
    ///
    /// Дефолт — no-op (тестовые источники его не переопределяют).
    fn release_cache(&self, _file_id: i32) {}
}

/// Боевой источник — TDLib через `send_and_wait`.
///
/// `state` — для watchdog'а (BUG-DOWNLOAD-049): пока ждём ответ `downloadFile`,
/// раз в `STALL_POLL` проверяем `last_progress_at`; если часть «молчит» дольше
/// `PART_STALL_TIMEOUT`, прерываем запрос (`cancelDownloadFile`) и возвращаем
/// Err с `STALL_MARKER` — `process_part` повторит попытку.
///
/// `seq` — номер запроса: `@extra` не переиспользуется между попытками, иначе
/// поздний ответ «убитого» запроса мог быть доставлен новой попытке (класс
/// BUG-CANCEL-RESUME-002: коллизия зомби- и новой попытки по общему id).
struct TdlibPartSource<'a> {
    rt: &'a TdlibRuntime,
    state: &'a Shared,
    seq: std::sync::atomic::AtomicUsize,
}

impl TdlibPartSource<'_> {
    fn next_seq(&self) -> usize {
        self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    /// Прервать текущий `downloadFile`. Частичный кеш TDLib сохраняется —
    /// повторная часть продолжает с него, а не с нуля.
    fn abort_part(&self, file_id: i32) {
        let _ = self.rt.send_value(json!({
            "@type": "cancelDownloadFile",
            "file_id": file_id,
            "only_if_pending": false,
        }));
    }

    /// Отправить в TDLib `deleteFile` для ПРИНЯТОЙ части — BUG-PART-CACHE-PEAK-001.
    ///
    /// Точечно, в отличие от `post_download_purge`/`purge_cache_dirs` (те сносят
    /// каталог целиком — убили бы кеш параллельной вкладки, поэтому и гейтятся
    /// `shouldPurgeTdlibCacheOnCancel`): `deleteFile` снимает ровно этот file_id,
    /// поэтому безопасен и посреди задания.
    ///
    /// Best-effort и без ожидания ответа (как `cleanupStuckUploads`): снятие кеша —
    /// оптимизация МЕСТА, а не корректность, и блокировать воркер на лишний
    /// round-trip нет смысла. В RCA пишем факт отправки (`…_sent`), а не
    /// «TDLib подтвердил удаление».
    ///
    /// Вызывается из [`PartSource::release_cache`] — если связь разорвётся,
    /// компилятор скажет «method is never used» (так и была поймана попытка
    /// объявить метод в inherent-impl вместо trait-impl).
    fn delete_cached_part(&self, file_id: i32) {
        match self.rt.send_value(json!({
            "@type": "deleteFile",
            "file_id": file_id,
        })) {
            Ok(()) => rca_log_multi(
                "multi",
                "part_cache_release_sent",
                json!({ "file_id": file_id }),
            ),
            Err(e) => rca_log_multi(
                "multi",
                "part_cache_release_error",
                json!({ "file_id": file_id, "error_text": e }),
            ),
        }
    }

    /// `getRemoteFile(tg_file_id)` → TDLib `file_id`.
    ///
    /// Годится только для id, полученных СВОЕЙ сессией (direct_vault, desktop
    /// upload). Bot-side Vault-якорь pm_lease так резолвить нельзя
    /// (BUG-DOWNLOAD-051: TDLib 400 Invalid remote file identifier).
    fn resolve_via_remote_file(&self, part: &PartDesc) -> Result<i32, String> {
        let seq = self.next_seq();
        let remote = self.rt.send_and_wait(
            json!({
                "@type": "getRemoteFile",
                "remote_file_id": part.tg_file_id,
                "file_type": { "@type": "fileTypeDocument" },
                "@extra": format!("pd_remote_{}_{}", part.part_index, seq),
            }),
            Duration::from_secs(60),
        )?;
        let file_id = remote["id"].as_i64().unwrap_or(0) as i32;
        if file_id <= 0 {
            return Err(format!(
                "getRemoteFile(part {}): нет file_id (remote_file_id={})",
                part.part_index, part.tg_file_id
            ));
        }
        Ok(file_id)
    }

    /// Резолв части через PM-доставку (BUG-DOWNLOAD-051/052, pm_lease).
    ///
    /// Делегирует в общий [`download::resolve_pm_part_document`]: strict-getMessage
    /// по кандидатам id (`id`, `id<<20`, `id>>20` — TDLib клиента отдаёт
    /// `real << 20`), проверка `doc_matches_part` (unique_id → размер), затем
    /// история PM (окно ≥ 24) по `unique_id`, далее по `size`+`pm_skip`.
    fn resolve_via_pm(&self, pm_chat: i64, part: &PartDesc) -> Result<i32, String> {
        let expected = part.expected_size.unwrap_or(0);
        let info = download::resolve_pm_part_document(
            self.rt,
            pm_chat,
            part.pm_message_id,
            part.pm_unique_id.as_deref(),
            expected,
            part.pm_skip,
        )?;
        let file_id = info["file_id"].as_i64().unwrap_or(0) as i32;
        if file_id <= 0 {
            return Err(format!(
                "PM-резолв части {}: документ без file_id (chat={pm_chat})",
                part.part_index
            ));
        }
        Ok(file_id)
    }
}

impl PartSource for TdlibPartSource<'_> {
    fn resolve(&self, part: &PartDesc) -> Result<i32, String> {
        // BUG-DOWNLOAD-051: pm_lease — сначала СВОЁ PM-сообщение доставки.
        // `tg_file_id` в этом режиме — Vault-якорь (bot-side file_id), который
        // сессия юзера не резолвит: `getRemoteFile → 400 Invalid remote file
        // identifier` (live 2026-09-25, files.id=35/38).
        if let Some(pm_chat) = part.pm_chat_id {
            return match self.resolve_via_pm(pm_chat, part) {
                Ok(file_id) => Ok(file_id),
                Err(pm_err) => {
                    // Не сдаёмся: tg_file_id может быть client-scoped (переходный
                    // случай — клиент со старым сервером / direct_vault-совместимый).
                    self.resolve_via_remote_file(part).map_err(|rf_err| {
                        format!(
                            "part {}: PM-резолв не удался ({pm_err}); \
                             getRemoteFile не удался ({rf_err})",
                            part.part_index
                        )
                    })
                }
            };
        }
        self.resolve_via_remote_file(part)
    }

    fn fetch(&self, file_id: i32, part: &PartDesc) -> Result<std::path::PathBuf, String> {
        // downloadFile (synchronous=true → ответ после полной загрузки).
        //
        // Опрос-wait вместо «слепого» 6-часового ожидания: TDLib при обрыве
        // сети может не прислать ни ответа, ни `updateFile` (BUG-DOWNLOAD-049).
        let seq = self.next_seq();
        let fetch_started = Instant::now();
        let fetch_res = self.rt.send_and_wait_polling(
            json!({
                "@type": "downloadFile",
                "file_id": file_id,
                "priority": 1,
                "offset": 0,
                "limit": 0,
                "synchronous": true,
                "@extra": format!("pd_dl_{}_{}", part.part_index, seq),
            }),
            PART_TIMEOUT,
            STALL_POLL,
            || match stalled_for(self.state, PART_STALL_TIMEOUT) {
                Some(idle) => {
                    self.abort_part(file_id);
                    Some(format!(
                        "{STALL_MARKER} {:.0}s (part {}, file_id={file_id})",
                        idle.as_secs_f64(),
                        part.part_index
                    ))
                }
                None => None,
            },
        );
        let fetch_ms = fetch_started.elapsed().as_millis() as u64;
        match &fetch_res {
            Ok(file) => rca_log_multi(
                "multi",
                "part_fetch",
                json!({
                    "part_index": part.part_index,
                    "file_id": file_id,
                    "ms": fetch_ms,
                    "priority": 1,
                    "synchronous": true,
                    "size": file["size"].as_u64().unwrap_or(0),
                }),
            ),
            Err(e) => rca_log_multi(
                "multi",
                "part_fetch_error",
                json!({
                    "part_index": part.part_index,
                    "file_id": file_id,
                    "ms": fetch_ms,
                    "error_text": e,
                }),
            ),
        }
        let file = fetch_res?;
        let path = file["local"]["path"].as_str().unwrap_or("");
        if path.is_empty() {
            return Err(format!(
                "downloadFile(part {}): пустой local.path (file_id={file_id})",
                part.part_index
            ));
        }
        Ok(std::path::PathBuf::from(path))
    }

    /// BUG-PART-CACHE-PEAK-001: снять кеш принятой части (см. [`Self::delete_cached_part`]).
    ///
    /// Явная делегация — намеренно: без неё у `TdlibPartSource` осталась бы
    /// дефолтная no-op реализация трейта, и боевой путь молча НЕ снимал бы кеш
    /// (тесты на фейковых источниках такую рассинхронизацию не видят).
    fn release_cache(&self, file_id: i32) {
        self.delete_cached_part(file_id);
    }
}

/// Обработать одну часть с watchdog-ретраем (BUG-DOWNLOAD-049).
///
/// Ретраибелен только обрыв (`STALL_MARKER`) — «движок молчит дольше
/// `PART_STALL_TIMEOUT`»; отмена и детерминированные ошибки (sha-mismatch,
/// пустой путь) падают сразу, иначе мы бы маскировали реальные баги.
/// Возвращает `Err` — вызывающий завершает задание через `finish_with_error`.
fn process_part<S: PartSource>(
    source: &S,
    state: &Shared,
    part: &PartDesc,
    out_path: &Path,
) -> Result<(), String> {
    let mut last_err = String::new();
    for _attempt in 1..=PART_MAX_ATTEMPTS {
        match process_part_once(source, state, part, out_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if !is_stall_error(&e) {
                    return Err(e);
                }
                last_err = e;
                // Снимаем попытку с учёта и стартуем новое окно watchdog'а:
                // иначе (а) поздний `updateFile` старого file_id исказит прогресс,
                // (б) новый `fetch` мгновенно «увидит» уже истёкший обрыв.
                let stale_file_id = {
                    let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
                    if g.cancelled {
                        return Err("Download cancelled".to_string());
                    }
                    let id = g.current_file_id;
                    g.current_file_id = 0;
                    g.current_downloaded = 0;
                    g.current_total = 0;
                    // Прерванная попытка больше не источник `remote.id` (BUG-RCA-SPAM-002):
                    // иначе метка завершения части ушла бы с чужим remote-ключом.
                    g.remote_id.clear();
                    g.last_progress_at = Instant::now();
                    id
                };
                if stale_file_id > 0 {
                    file_index()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&stale_file_id);
                }
                emit_progress(state, true);
            }
        }
    }
    Err(last_err)
}

/// Одна попытка части: resolve → (регистрация) → fetch → sha → append.
fn process_part_once<S: PartSource>(
    source: &S,
    state: &Shared,
    part: &PartDesc,
    out_path: &Path,
) -> Result<(), String> {
    // Проверка отмены перед частью.
    {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        if g.cancelled {
            return Err("Download cancelled".to_string());
        }
    }

    let file_id = source.resolve(part)?;

    // Регистрируем file_id ДО передачи: `updateFile` идёт потоком во время
    // `downloadFile{synchronous:true}`, и без записи в `file_index` все эти
    // события отбрасываются (`on_update_file` → None) — прогресс-бар «зависает»
    // на 0%/одном месте и прыгает только на границах частей (BUG-DOWNLOAD-048).
    // Бонус: `cancel()` получает актуальный `current_file_id` и реально
    // отправляет `cancelDownloadFile` по качающейся части.
    {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.current_file_id = file_id;
        g.current_downloaded = 0;
        g.current_total = 0;
        // Новая часть — свой `remote.id` (заполнится первым `updateFile`).
        g.remote_id.clear();
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(file_id, g.download_id.clone());
    }
    // Часть стартовала — сразу отдаём UI метку `Part i/n` и общий total,
    // не дожидаясь первых байт (иначе бар молчит до конца первой части).
    emit_progress(state, true);

    let cached = source.fetch(file_id, part)?;

    let phase_started = Instant::now();
    if let Err(e) = verify_sha(&cached, part.expected_sha256.as_deref()) {
        // BUG-CABINET-VAULT-SHA-MISMATCH-001: байты уже НЕВЕРНЫ — держать их в
        // кеше TDLib нельзя. Иначе повтор (и следующий запуск клиента) снова
        // читает отравленный файл: sha «падает» с тем же хэшем, а UI висит на
        // «Соединение…» (кеш есть, передачи нет). Снятие — точечный `deleteFile`
        // по этой части, не каталоговый пург (ср. BUG-PART-CACHE-PEAK-001).
        source.release_cache(file_id);
        return Err(format!("part {}: {e}", part.part_index));
    }
    let sha_ms = phase_started.elapsed().as_millis() as u64;

    let io_started = Instant::now();
    let written = append_file(&cached, out_path).map_err(|e| format!("part {}: {e}", part.part_index))?;
    rca_log_multi(
        "multi",
        "part_io",
        json!({
            "part_index": part.part_index,
            "file_id": file_id,
            "written": written,
            "sha_ms": sha_ms,
            "append_ms": io_started.elapsed().as_millis() as u64,
        }),
    );

    // BUG-PUBLISH-MULTIPART-ANCHOR-001 (клиентская страховка): скачанный размер
    // части обязан совпасть с объявленным `expected_size`. Карточка «3.4 ГБ» на
    // документе 1.95 ГБ иначе даёт либо TDLib 400 (обрыв внутренней загрузки),
    // либо молча усечённый файл (при пустом byte_sha256 sha-проверки нет вовсе).
    // Ошибка детерминированная (не stall) → без ретраев, сразу fail.
    if let Some(expected) = part.expected_size {
        if expected > 0 && written != expected {
            return Err(format!(
                "part {}: size mismatch: downloaded {written} bytes, expected {expected} \
                 (broken catalog card)",
                part.part_index
            ));
        }
    }

    let part_remote_id = {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.completed_bytes += written;
        g.current_downloaded = 0;
        g.current_total = 0;
        g.current_part_index += 1;
        g.current_file_id = 0;
        if g.total_bytes < g.completed_bytes {
            g.total_bytes = g.completed_bytes;
        }
        let rid = g.remote_id.clone();
        g.remote_id.clear();
        rid
    };
    // Завершённая часть больше не источник прогресса: поздний `updateFile`
    // по её file_id не должен искажать `current_downloaded`.
    file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&file_id);
    // ...но и upload-конвейеру она не принадлежит: TTL-метка гасит её финальный
    // `updateFile` — и по СВОЕМУ file_id, и по «зеркальному» (тот же `remote.id`
    // документа доставки) (BUG-RCA-SPAM-002).
    mark_part_completed(file_id, &part_remote_id);
    // Часть принята (склеена + размер сошёлся) → её кеш TDLib больше не нужен.
    // Снимаем СРАЗУ, а не в конце задания: иначе target и кеш всех частей лежат
    // на диске одновременно (BUG-PART-CACHE-PEAK-001). Ошибка снятия не фатальна
    // (это место, а не корректность) — но и молчать о ней не будем, иначе пик
    // вернётся незаметно.
    source.release_cache(file_id);

    emit_progress(state, true);
    Ok(())
}

/// Синхронный воркер одного задания (в фоновом потоке).
fn run_job(rt: &Arc<TdlibRuntime>, state: &Shared, parts: Vec<PartDesc>) {
    let source = TdlibPartSource {
        rt: rt.as_ref(),
        state,
        seq: std::sync::atomic::AtomicUsize::new(0),
    };
    run_job_with_source(state, parts, &source);
}

/// Ядро воркера, отвязанное от TDLib (seam для тестов watchdog-ретраев).
fn run_job_with_source<S: PartSource>(state: &Shared, parts: Vec<PartDesc>, source: &S) {
    // Целевой файл: начинаем с чистого листа (части дописываются по порядку).
    let output_path = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.output_path.clone()
    };
    let out_path = Path::new(&output_path).to_path_buf();
    if let Err(e) = std::fs::create_dir_all(out_path.parent().unwrap_or(Path::new("."))) {
        finish_with_error(state, format!("create output dir: {e}"));
        return;
    }
    if let Err(e) = std::fs::File::create(&out_path) {
        finish_with_error(state, format!("create output file: {e}"));
        return;
    }

    for part in parts {
        if let Err(e) = process_part(source, state, &part, &out_path) {
            finish_with_error(state, e);
            return;
        }
    }

    // Финал.
    {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.completed = true;
        g.total_bytes = g.total_bytes.max(g.completed_bytes);
    }
    emit_progress(state, true);

    let (mode, download_id, output) = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        (g.mode, g.download_id.clone(), g.output_path.clone())
    };
    if mode == Mode::Composite {
        emit_event(
            "tdlib-download-merged",
            json!({ "download_id": download_id, "output_path": output }),
        );
    }
    // BUG-UX-001: итог собран (склейка завершена) → чистим кеш целиком.
    purge_cache_after_success();
}

fn finish_with_error(state: &Shared, err: String) {
    let (mode, active_file_id) = {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.error = Some(err.clone());
        g.completed = false;
        let active = g.current_file_id;
        g.current_file_id = 0;
        (g.mode, active)
    };
    // Снимаем с учёта file_id незавершённой части: иначе «зомби»-запись
    // остаётся в `file_index` и мэпится на retry с тем же download_id.
    if active_file_id > 0 {
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&active_file_id);
    }
    emit_progress(state, true);
    // Composite-контракт не несёт `error` (UI слушает лишь all_completed), а
    // страховочный слушатель ошибок в DownloadPage — `tdlib-download-progress`
    // с полем error. Без этого composite-ошибка «подвесила» бы UI.
    if mode == Mode::Composite {
        emit_event(
            "tdlib-download-progress",
            json!({
                "file_id": 0,
                "downloaded": 0,
                "total": 0,
                "percent": 0,
                "speed_bytes_per_sec": 0,
                "eta_secs": 0,
                "completed": false,
                "cancelled": false,
                "error": err,
                "local_path": Value::Null,
                "file_name": Value::Null,
            }),
        );
    }
}

/// Запустить задание. Возвращает строку-подтверждение (как mainline).
pub fn start(
    rt: &Arc<TdlibRuntime>,
    download_id: String,
    parts: Vec<PartDesc>,
    output_path: String,
    file_name: Option<String>,
    mode: Mode,
) -> Result<String, String> {
    if parts.is_empty() {
        return Err("start_download: parts[] пуст".into());
    }
    if output_path.is_empty() {
        return Err("start_download: outputPath обязателен".into());
    }
    let total_hint: u64 = parts.iter().filter_map(|p| p.expected_size).sum();
    let total_parts = parts.len();

    let state: Shared = Arc::new(Mutex::new(JobState {
        download_id: download_id.clone(),
        mode,
        total_parts,
        current_part_index: 0,
        completed_bytes: 0,
        current_downloaded: 0,
        current_total: 0,
        total_bytes: total_hint,
        current_file_id: 0,
        remote_id: String::new(),
        completed: false,
        error: None,
        cancelled: false,
        output_path: output_path.clone(),
        file_name: file_name.clone(),
        last_emit: None,
        last_bytes: 0,
        last_ts: None,
        speed: 0,
        last_progress_at: Instant::now(),
        last_rca: None,
    }));
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(download_id.clone(), Arc::clone(&state));

    // BUG-DOWNLOAD-048: стартовое событие — UI сразу получает total и
    // «Part 1/n», а не молчит до конца первой части (0% «навсегда»).
    emit_progress(&state, true);

    let rt2 = Arc::clone(rt);
    let st2 = Arc::clone(&state);
    std::thread::spawn(move || run_job(&rt2, &st2, parts));

    Ok(format!(
        "{mode:?} download started: download_id={download_id}, parts={total_parts}, output={output_path}"
    ))
}

/// Отмена задания по `download_id`.
///
/// BUG-CANCEL-RESUME-002: кроме `cancelDownloadFile` немедленно уведомляем UI
/// (`finish_with_error("cancelled by user")`) — иначе промис загрузки в
/// renderer'е висел бы до ближайшего чекпоинта между частями (а на большой
/// части — минуты), и пользователь считал бы Cancel «не сработавшим».
pub fn cancel(rt: &TdlibRuntime, download_id: &str) -> Result<Value, String> {
    let state = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(download_id)
        .cloned()
        .ok_or_else(|| format!("cancel_download: неизвестный download_id={download_id}"))?;
    let file_id = {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.cancelled = true;
        g.current_file_id
    };
    if file_id > 0 {
        let _ = rt.send_value(json!({
            "@type": "cancelDownloadFile",
            "file_id": file_id,
            "only_if_pending": false,
        }));
    }
    // Промпт-уведомление UI (идемпотентно: если уже завершено/ошибка — не трогаем).
    let already_settled = {
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        g.completed || g.error.is_some()
    };
    if !already_settled {
        finish_with_error(&state, "cancelled by user".to_string());
    }
    Ok(json!({ "status": "cancelled", "download_id": download_id }))
}

/// Отмена по `file_id` (UI зовёт `tdlib_cancel_download({fileId})`).
/// Возвращает true, если file_id принадлежал part-заданию.
pub fn cancel_for_file(rt: &TdlibRuntime, file_id: i32) -> bool {
    let download_id = file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned();
    match download_id {
        Some(id) => cancel(rt, &id).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Глобальные реестры (`registry`/`file_index`) — на процесс, поэтому тесты,
    /// которые их трогают, обязаны идти последовательно: `reset()` одного теста
    /// иначе чистит состояние параллельно идущего другого.
    fn global_state_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn parse_parts_allows_empty_tg_file_id_with_pm_anchor() {
        // BUG-DOWNLOAD-052 (фаза 3, owner-backdoor): части ЛИЧНОГО файла доставлены
        // ботом в PM владельца — клиентский remote id невалиден/отсутствует,
        // достаточно pm-якоря доставки (pm_chat_id+pm_message_id, pm_unique_id).
        let params = json!({
            "parts": [
                { "tg_file_id": "", "part_index": 0, "expected_size": 2093796556u64,
                  "pm_chat_id": 8898752180i64, "pm_message_id": 617611264i64,
                  "pm_unique_id": "AgADr5wAAvCuuUk" },
                { "tg_file_id": "", "part_index": 1, "expected_size": 1314464227u64,
                  "pm_chat_id": 8898752180i64, "pm_message_id": 616562688i64,
                  "pm_unique_id": "AgADtZwAAvCuuUk" }
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].tg_file_id.is_empty());
        assert_eq!(parts[0].pm_message_id, Some(617611264));
        assert_eq!(parts[0].pm_unique_id.as_deref(), Some("AgADr5wAAvCuuUk"));
        // Порядок частей для склейки сохранён.
        assert_eq!(parts[0].part_index, 0);
        assert_eq!(parts[1].part_index, 1);
    }

    #[test]
    fn parse_parts_rejects_empty_tg_file_id_without_pm_anchor() {
        // Без remote id И без pm-якоря часть нечем резолвить — ошибка (не молчим).
        let params = json!({ "parts": [{ "tg_file_id": "", "part_index": 0 }] });
        assert!(parse_parts(&params).is_err());
    }


    #[test]
    fn parse_parts_sorts_and_validates() {
        let params = json!({
            "parts": [
                { "tg_file_id": "B", "part_index": 1, "expected_sha256": "ABCD", "expected_size": 7 },
                { "tg_file_id": "A", "partIndex": 0 }
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].tg_file_id, "A");
        assert_eq!(parts[1].tg_file_id, "B");
        assert_eq!(parts[1].expected_sha256.as_deref(), Some("abcd"));
        assert_eq!(parts[1].expected_size, Some(7));

        let bad = json!({ "parts": [ { "part_index": 0 } ] });
        assert!(parse_parts(&bad).is_err());
    }

    #[test]
    fn parse_parts_empty_sha_means_no_verification() {
        // BUG-SHA256-001: сервер отдаёт `parts[].sha256 = ""`, когда настоящий
        // байтовый хэш неизвестен (старые строки `byte_sha256 IS NULL`, бандлы,
        // `.7z` вне TARGET_EXTENSIONS клиента). Пустая строка ОБЯЗАНА стать
        // `None` — иначе verify_sha сравнивал бы байты с "" и ронял скачивание.
        let params = json!({
            "parts": [
                { "tg_file_id": "A", "part_index": 0, "expected_sha256": "" },
                { "tg_file_id": "B", "part_index": 1 }
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].expected_sha256, None, "пустой sha → проверки нет");
        assert_eq!(parts[1].expected_sha256, None, "отсутствие ключа → проверки нет");
    }

    #[test]
    fn part_size_mismatch_fails_loudly() {
        // BUG-PUBLISH-MULTIPART-ANCHOR-001 (клиентская страховка): размер
        // скачанной части обязан совпасть с `expected_size`. Иначе карточка
        // «3.4 ГБ» на документе 1.95 ГБ даёт либо TDLib 400, либо молча
        // усечённый файл (sha256 при пустом byte_sha256 не спасает).
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-size-guard");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        struct CachedSource {
            dir: std::path::PathBuf,
            len: usize,
        }
        impl PartSource for CachedSource {
            fn resolve(&self, _part: &PartDesc) -> Result<i32, String> {
                Ok(1)
            }
            fn fetch(&self, _file_id: i32, _part: &PartDesc) -> Result<std::path::PathBuf, String> {
                let p = self.dir.join("cached.bin");
                std::fs::write(&p, vec![0u8; self.len]).unwrap();
                Ok(p)
            }
        }

        let mk_state = |id: &str| -> Shared {
            Arc::new(Mutex::new(JobState {
                download_id: id.into(),
                mode: Mode::Multi,
                total_parts: 1,
                current_part_index: 0,
                completed_bytes: 0,
                current_downloaded: 0,
                current_total: 0,
                total_bytes: 10,
                current_file_id: 0,
                remote_id: String::new(),
                completed: false,
                error: None,
                cancelled: false,
                output_path: dir.join("out.bin").to_string_lossy().to_string(),
                file_name: None,
                last_emit: None,
                last_bytes: 0,
                last_ts: None,
                speed: 0,
                last_progress_at: Instant::now(),
                last_rca: None,
            }))
        };
        let part = |expected: u64| PartDesc::new("remote-file".into(), 0, None, Some(expected));

        // Документ короче заявленного размера → громкий отказ, не «успех».
        let state = mk_state("size-guard-short");
        let src = CachedSource { dir: dir.clone(), len: 6 };
        let err = process_part(&src, &state, &part(10), &dir.join("out-short.bin"))
            .expect_err("размер != expected_size обязан ронять часть");
        assert!(
            err.contains("size mismatch") || err.contains("expected"),
            "ошибка обязана называть причину (size): {err}"
        );

        // Размер совпал → ок (регресс-защита корректной части).
        let state = mk_state("size-guard-ok");
        let src = CachedSource { dir: dir.clone(), len: 6 };
        process_part(&src, &state, &part(6), &dir.join("out-ok.bin"))
            .expect("часть с совпавшим размером должна пройти");
        assert_eq!(
            state.lock().unwrap().completed_bytes, 6,
            "completed_bytes должен равняться размеру части"
        );

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-UX-001: успех задания чистит кеш — каждый `*.part`
    /// в `documents/` после склейки удаляется (`run_job_with_source` зовёт
    /// `purge_cache_after_success` → рекурсивный `purge_cache_dirs`).
    #[test]
    fn successful_job_purges_part_cache() {
        let _guard = global_state_lock();
        reset();
        // Гнездо кеша как у TDLib: documents/<id>_<n>.part.
        let cache = std::env::temp_dir().join("engine-core-purge-red");
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(cache.join("documents")).unwrap();
        std::fs::create_dir_all(cache.join("temp")).unwrap();
        std::fs::write(cache.join("documents").join("4220_0.part"), b"PART0").unwrap();
        std::fs::write(cache.join("documents").join("4220_1.part"), b"PART1").unwrap();
        std::fs::write(cache.join("temp").join("_tmp"), b"TMP").unwrap();

        // Контракт: то, что делает run_job_with_source по успеху —
        // рекурсивная зачистка гнезда (тот же `purge_cache_dirs`, что зовёт воркер).
        let removed =
            crate::tdlib_runtime::purge_cache_dirs(&[cache.to_string_lossy().to_string()]);
        assert_eq!(
            removed, 3,
            "успех обязан чистить documents/*.part и temp/* целиком (глобальный выбор)"
        );
        assert!(
            std::fs::read_dir(cache.join("documents")).unwrap().next().is_none(),
            "documents/ после успеха обязан остаться пустым"
        );
        // Интеграция воркера: успешное задание обязано оставлять кеш пустым
        // (run_job_with_source → purge_cache_after_success).
        assert!(
            !cache.join("documents").join("4220_0.part").exists(),
            "кеш части пережил успех — run_job_with_source обязан звать purge"
        );
        let _ = std::fs::remove_dir_all(&cache);
        reset();
    }

    #[test]
    fn append_and_verify_sha256() {
        let dir = std::env::temp_dir().join("engine-core-parts-tests");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = dir.join("p1.bin");
        let p2 = dir.join("p2.bin");
        std::fs::write(&p1, b"HELLO").unwrap();
        std::fs::write(&p2, b"-WORLD").unwrap();
        let out = dir.join("out.bin");
        append_file(&p1, &out).unwrap();
        append_file(&p2, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"HELLO-WORLD");

        // sha256 "HELLO" (известное значение).
        let hex = sha256_file_hex(&p1).unwrap();
        assert_eq!(
            hex,
            "3733cd977ff8eb18b987357e22ced99f46097f31ecb239e878ae63760e83e4d5"
        );
        assert!(verify_sha(&p1, Some(&hex)).is_ok());
        // BUG-SHA256-001/Ф2: текст mismatch обязан нести размер файла —
        // иначе не отличить битые байты/усечение от неверного expected.
        let err = verify_sha(&p1, Some("deadbeef")).expect_err("чужой sha обязан ронять");
        assert!(
            err.contains("size=5 bytes"),
            "mismatch обязан содержать размер файла: {err}"
        );
        assert!(verify_sha(&p1, None).is_ok(), "без ожидания sha — всегда ок");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BUG-DOWNLOAD-048 (регресс): `file_id` части обязан попасть в `file_index`
    /// ДО старта передачи (`fetch`). Иначе все `updateFile` во время
    /// `downloadFile{synchronous:true}` отбрасываются → UI-прогресс «зависает»
    /// и прыгает только на границах частей.
    #[test]
    fn file_id_registered_before_part_transfer() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-order");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        struct ProbeSource {
            file_id: i32,
            dir: std::path::PathBuf,
            registered_at_fetch: Arc<Mutex<Vec<bool>>>,
        }
        impl PartSource for ProbeSource {
            fn resolve(&self, _part: &PartDesc) -> Result<i32, String> {
                Ok(self.file_id)
            }
            fn fetch(&self, file_id: i32, _part: &PartDesc) -> Result<std::path::PathBuf, String> {
                let registered = file_index()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(&file_id);
                self.registered_at_fetch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(registered);
                let p = self.dir.join("part0.bin");
                std::fs::write(&p, b"PART").unwrap();
                Ok(p)
            }
        }

        let part = PartDesc::new("remote-file".into(), 0, None, Some(4));
        let state: Shared = Arc::new(Mutex::new(JobState {
            download_id: "order-test".into(),
            mode: Mode::Multi,
            total_parts: 2,
            current_part_index: 0,
            completed_bytes: 0,
            current_downloaded: 0,
            current_total: 0,
            total_bytes: 8,
            current_file_id: 0,
            remote_id: String::new(),
            completed: false,
            error: None,
            cancelled: false,
            output_path: dir.join("out.bin").to_string_lossy().to_string(),
            file_name: None,
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 0,
            last_progress_at: Instant::now(),
            last_rca: None,
        }));

        let seen: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let source = ProbeSource {
            file_id: 777,
            dir: dir.clone(),
            registered_at_fetch: Arc::clone(&seen),
        };
        process_part(&source, &state, &part, &dir.join("out.bin")).unwrap();

        let flags = seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert_eq!(
            flags,
            vec![true],
            "file_id должен быть в file_index ДО передачи части (иначе updateFile части теряется)"
        );
        assert!(
            !file_index()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&777),
            "file_id завершённой части должен быть снят с учёта прогресса"
        );

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Механика intra-part прогресса: пока часть зарегистрирована в `file_index`,
    /// `updateFile` обновляет `current_downloaded`, а агрегат = completed + current.
    #[test]
    fn update_file_inside_part_updates_aggregate_progress() {
        let _guard = global_state_lock();
        reset();
        let state: Shared = Arc::new(Mutex::new(JobState {
            download_id: "intra-part".into(),
            mode: Mode::Multi,
            total_parts: 3,
            current_part_index: 1,
            completed_bytes: 1000,
            current_downloaded: 0,
            current_total: 0,
            total_bytes: 3000,
            current_file_id: 4242,
            remote_id: String::new(),
            completed: false,
            error: None,
            cancelled: false,
            output_path: "/tmp/intra-part.bin".into(),
            file_name: None,
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 0,
            last_progress_at: Instant::now(),
            last_rca: None,
        }));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("intra-part".into(), Arc::clone(&state));
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(4242, "intra-part".into());

        let upd = json!({
            "@type": "updateFile",
            "file": {
                "id": 4242,
                "size": 2000,
                "remote": { "id": "REMOTE-PART-0" },
                "local": { "downloaded_size": 500 }
            }
        });
        assert!(
            on_update_file(&upd),
            "updateFile активной части обязан обрабатываться (иначе бар «замерзает»)"
        );

        {
            let g = state.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(g.current_downloaded, 500);
            assert_eq!(g.current_total, 2000);
            // BUG-RCA-SPAM-002: `remote.id` части запоминается — по нему после
            // завершения гасится финальный `updateFile` «зеркального» file_id.
            assert_eq!(
                g.remote_id, "REMOTE-PART-0",
                "remote.id части обязан запоминаться из updateFile"
            );
            let payload = progress_payload(&g);
            assert_eq!(payload["downloaded_bytes"], json!(1500));
            assert_eq!(payload["total_bytes"], json!(3000));
        }

        // Снятая с учёта (завершённая) часть больше не двигает прогресс.
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&4242);
        assert!(!on_update_file(&upd), "завершённая часть не источник прогресса");

        reset();
    }

    /// Отменённая попытка оставляет file_id в `file_index`; поздний `updateFile`
    /// по нему НЕ должен двигать прогресс новой попытки с тем же download_id.
    #[test]
    fn update_file_ignores_stale_file_id_of_previous_attempt() {
        let _guard = global_state_lock();
        reset();
        let state: Shared = Arc::new(Mutex::new(JobState {
            download_id: "retry-job".into(),
            mode: Mode::Multi,
            total_parts: 3,
            current_part_index: 0,
            completed_bytes: 0,
            current_downloaded: 0,
            current_total: 0,
            total_bytes: 3000,
            current_file_id: 111,
            remote_id: String::new(),
            completed: false,
            error: None,
            cancelled: false,
            output_path: "/tmp/retry-job.bin".into(),
            file_name: None,
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 0,
            last_progress_at: Instant::now(),
            last_rca: None,
        }));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("retry-job".into(), Arc::clone(&state));
        // «Зомби»-запись отменённой попытки: чужой file_id → тот же download_id.
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(999, "retry-job".into());

        let stale = json!({
            "@type": "updateFile",
            "file": {
                "id": 999,
                "size": 1000,
                "local": { "downloaded_size": 800 }
            }
        });
        assert!(
            !on_update_file(&stale),
            "updateFile чужого (уже не активного) file_id не должен трогать новую попытку"
        );
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(g.current_downloaded, 0, "прогресс новой попытки не испорчен");

        drop(g);
        reset();
    }

    #[test]
    fn progress_payload_matches_ui_contract() {
        let g = JobState {
            download_id: "d1".into(),
            mode: Mode::Multi,
            total_parts: 3,
            current_part_index: 1,
            completed_bytes: 100,
            current_downloaded: 50,
            current_total: 200,
            total_bytes: 300,
            current_file_id: 0,
            remote_id: String::new(),
            completed: false,
            error: None,
            cancelled: false,
            output_path: "/tmp/o.bin".into(),
            file_name: Some("o.bin".into()),
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 10,
            last_progress_at: Instant::now(),
            last_rca: None,
        };
        let p = progress_payload(&g);
        // Поля контракта TdlibFfiMultiDownloadProgress.
        for k in [
            "download_id",
            "current_part_index",
            "total_parts",
            "downloaded_bytes",
            "total_bytes",
            "speed_bytes_per_sec",
            "eta_secs",
            "completed",
            "error",
        ] {
            assert!(p.get(k).is_some(), "нет поля {k}");
        }
        assert_eq!(p["downloaded_bytes"], json!(150));

        let c = JobState { mode: Mode::Composite, ..g };
        let cp = progress_payload(&c);
        for k in [
            "download_id",
            "completed_parts",
            "total_parts",
            "downloaded_bytes",
            "total_bytes",
            "all_completed",
        ] {
            assert!(cp.get(k).is_some(), "нет поля {k}");
        }
    }

    // ── BUG-DOWNLOAD-049: watchdog против «вечного ⏳ Соединение…» ────────────
    //
    // Симптом: обрыв сети во время multi/vault-скачивания → `downloadFile{
    // synchronous:true}` не отвечает и не шлёт `updateFile`; воркер «висит»
    // до `PART_TIMEOUT` (6 часов), UI показывает stall и НЕ возобновляется
    // после возврата сети (реагировать на `connectionState` было некому).
    //
    // Контракт: если по части нет прогресса дольше `PART_STALL_TIMEOUT`,
    // источник обязан прервать текущий `fetch` (боевой — `cancelDownloadFile`)
    // и вернуть Err с маркером `STALL_MARKER`; `process_part` пере-качивает
    // часть (TDLib продолжает с частичного кеша), максимум `PART_MAX_ATTEMPTS`.

    /// Собрать JobState как в `start()` (хелпер, чтобы тесты не дублировали
    /// 15 полей).
    fn mk_state(download_id: &str, mode: Mode, total_parts: usize, out: &Path) -> Shared {
        Arc::new(Mutex::new(JobState {
            download_id: download_id.to_string(),
            mode,
            total_parts,
            current_part_index: 0,
            completed_bytes: 0,
            current_downloaded: 0,
            current_total: 0,
            total_bytes: 0,
            current_file_id: 0,
            remote_id: String::new(),
            completed: false,
            error: None,
            cancelled: false,
            output_path: out.to_string_lossy().to_string(),
            file_name: None,
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 0,
            last_progress_at: Instant::now(),
            last_rca: None,
        }))
    }

    fn test_part(idx: usize) -> PartDesc {
        PartDesc::new(format!("REMOTE_{idx}"), idx, None, None)
    }

    // ── BUG-DOWNLOAD-051: parse_parts доносит пер-частовые PM-якоря ──────────
    //
    // pm_lease: сервер отдаёт `pm_delivery.{chat_id,message_id}` на каждую часть
    // (см. desktop_downloads_api._rewrite_part_coords_to_pm). Клиент обязан
    // передать их в Rust — без них resolve идёт в getRemoteFile(Vault-якорь) → 400.
    #[test]
    fn parse_parts_maps_pm_anchors_and_skip() {
        let params = json!({
            "parts": [
                {
                    "tg_file_id": "BOT_FID_0", "part_index": 0,
                    "expected_size": 100,
                    "pm_chat_id": 111, "pm_message_id": 501,
                },
                {
                    "tg_file_id": "BOT_FID_1", "part_index": 1,
                    "expected_size": 200,
                    "pm_chat_id": 111, "pm_message_id": 502,
                },
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_chat_id, Some(111));
        assert_eq!(parts[0].pm_message_id, Some(501));
        assert_eq!(parts[1].pm_message_id, Some(502));
        // Размеры разные → сдвиг 0 (документ однозначно определяется размером).
        assert_eq!(parts[0].pm_skip, 0);
        assert_eq!(parts[1].pm_skip, 0);
    }

    #[test]
    fn parse_parts_pm_skip_counts_later_equal_sizes() {
        // Три части одного размера: последняя доставленная — самая свежая, поэтому
        // часть 0 пропускает 2 более новых документа того же размера.
        let params = json!({
            "parts": [
                {"tg_file_id": "p0", "part_index": 0, "expected_size": 500, "pm_chat_id": 111, "pm_message_id": 1},
                {"tg_file_id": "p1", "part_index": 1, "expected_size": 500, "pm_chat_id": 111, "pm_message_id": 2},
                {"tg_file_id": "p2", "part_index": 2, "expected_size": 500, "pm_chat_id": 111, "pm_message_id": 3},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_skip, 2);
        assert_eq!(parts[1].pm_skip, 1);
        assert_eq!(parts[2].pm_skip, 0);
    }

    #[test]
    fn parse_parts_pm_skip_without_size_is_positional() {
        // Размер части неизвестен → сдвиг по позиции (последняя часть = свежая).
        let params = json!({
            "parts": [
                {"tg_file_id": "p0", "part_index": 0, "pm_chat_id": 111, "pm_message_id": 1},
                {"tg_file_id": "p1", "part_index": 1, "pm_chat_id": 111, "pm_message_id": 2},
                {"tg_file_id": "p2", "part_index": 2, "pm_chat_id": 111, "pm_message_id": 3},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_skip, 2);
        assert_eq!(parts[2].pm_skip, 0);
    }

    #[test]
    fn parse_parts_without_pm_delivery_has_no_anchors() {
        // direct_vault / legacy-сервер: pm-якорей нет → resolve пойдёт в getRemoteFile.
        let params = json!({
            "parts": [
                {"tg_file_id": "FID_0", "part_index": 0, "expected_size": 100,
                 "chat_id": -1003888664319i64, "message_id": 193},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_chat_id, None);
        assert_eq!(parts[0].pm_message_id, None);
        assert_eq!(parts[0].pm_unique_id, None);
        assert_eq!(parts[0].pm_skip, 0);
    }

    #[test]
    fn parse_parts_pm_unique_id_is_stable_part_key() {
        // BUG-DOWNLOAD-052: parts[].pm_unique_id = tg_file_unique_id документа
        // (TDLib remote.unique_id) — различает части с ОДИНАКОВЫМ размером.
        let params = json!({
            "parts": [
                {"tg_file_id": "p0", "part_index": 0, "expected_size": 2093796556,
                 "pm_chat_id": 8898752180i64, "pm_message_id": 577,
                 "pm_unique_id": "AgAD8KcAAkAKuEk"},
                {"tg_file_id": "p1", "part_index": 1, "expected_size": 2093796556,
                 "pm_chat_id": 8898752180i64, "pm_message_id": 578,
                 "pm_unique_id": "AgAD-acAAkAKuEk"},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_unique_id.as_deref(), Some("AgAD8KcAAkAKuEk"));
        assert_eq!(parts[1].pm_unique_id.as_deref(), Some("AgAD-acAAkAKuEk"));
        // Оба размера равны → skip по-прежнему считается (страховочный путь).
        assert_eq!(parts[0].pm_skip, 1);
    }

    #[test]
    fn parse_parts_empty_pm_unique_id_is_ignored() {
        // Пустой ключ (legacy-сервер) → None: резолв по размеру+позиции.
        let params = json!({
            "parts": [
                {"tg_file_id": "p0", "part_index": 0, "pm_chat_id": 111,
                 "pm_message_id": 1, "pm_unique_id": ""},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_unique_id, None);
    }

    #[test]
    fn parse_parts_zero_pm_ids_are_ignored() {
        // 0 = «якоря нет» (питон-контракт: 0 вместо None не должен стать чатом 0).
        let params = json!({
            "parts": [
                {"tg_file_id": "FID_0", "part_index": 0,
                 "pm_chat_id": 0, "pm_message_id": 0},
            ]
        });
        let parts = parse_parts(&params).unwrap();
        assert_eq!(parts[0].pm_chat_id, None);
        assert_eq!(parts[0].pm_message_id, None);
    }


    /// Фейковый источник: считает попытки и умеет «зависать» (watchdog-обрыв).
    struct StallSource {
        file_id: i32,
        dir: std::path::PathBuf,
        attempts: Arc<Mutex<usize>>,
        /// true → каждый `fetch` возвращает stall-ошибку (имитация обрыва).
        stall_forever: bool,
        /// Иная (не stall) ошибка — ретраить НЕЛЬЗЯ.
        other_error: Option<String>,
        /// Полезная нагрузка успешной части.
        payload: &'static [u8],
        /// file_id'ы, по которым источник снял кеш (BUG-PART-CACHE-PEAK-001).
        released: Arc<Mutex<Vec<i32>>>,
    }

    impl PartSource for StallSource {
        fn resolve(&self, _part: &PartDesc) -> Result<i32, String> {
            Ok(self.file_id)
        }

        fn fetch(&self, _file_id: i32, part: &PartDesc) -> Result<std::path::PathBuf, String> {
            let mut n = self.attempts.lock().unwrap_or_else(|e| e.into_inner());
            *n += 1;
            let attempt = *n;
            drop(n);
            if let Some(e) = &self.other_error {
                return Err(e.clone());
            }
            // Первая попытка «зависает» → watchdog обязан её прервать и повторить.
            if self.stall_forever || attempt == 1 {
                return Err(format!("{STALL_MARKER} 60s (part {})", part.part_index));
            }
            let p = self.dir.join(format!("part{}.bin", part.part_index));
            std::fs::write(&p, self.payload).map_err(|e| e.to_string())?;
            Ok(p)
        }

        fn release_cache(&self, file_id: i32) {
            self.released
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(file_id);
        }
    }

    #[test]
    fn part_retries_after_stall_watchdog() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-stall-retry");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("stall-retry", Mode::Multi, 1, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("stall-retry".into(), Arc::clone(&state));

        let attempts = Arc::new(Mutex::new(0usize));
        let source = StallSource {
            file_id: 901,
            dir: dir.clone(),
            attempts: Arc::clone(&attempts),
            stall_forever: false,
            other_error: None,
            payload: b"DATA",
            released: Arc::new(Mutex::new(Vec::new())),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);

        let tries = *attempts.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            tries, 2,
            "watchdog-обрыв обязан привести к автоматическому повтору части"
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"DATA");
        {
            let g = state.lock().unwrap_or_else(|e| e.into_inner());
            assert!(g.completed, "job должен завершиться успешно после retry");
            assert!(g.error.is_none(), "ошибки быть не должно: {:?}", g.error);
        }

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn part_gives_up_after_max_stall_attempts() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-stall-giveup");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("stall-giveup", Mode::Multi, 1, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("stall-giveup".into(), Arc::clone(&state));

        let attempts = Arc::new(Mutex::new(0usize));
        let source = StallSource {
            file_id: 902,
            dir: dir.clone(),
            attempts: Arc::clone(&attempts),
            stall_forever: true,
            other_error: None,
            payload: b"DATA",
            released: Arc::new(Mutex::new(Vec::new())),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);

        let tries = *attempts.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            tries, PART_MAX_ATTEMPTS,
            "бесконечный auto-retry недопустим: ровно PART_MAX_ATTEMPTS попыток"
        );
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        let err = g.error.clone().expect("job обязан завершиться ошибкой");
        assert!(
            err.contains(STALL_MARKER),
            "ошибка должна нести маркер обрыва (UI покажет retry-панель): {err}"
        );
        assert!(!g.completed);

        drop(g);
        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_stall_error_is_not_retried() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-noretry");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("no-retry", Mode::Multi, 1, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("no-retry".into(), Arc::clone(&state));

        let attempts = Arc::new(Mutex::new(0usize));
        let boom = "downloadFile(part 0): пустой local.path (file_id=903)".to_string();
        let source = StallSource {
            file_id: 903,
            dir: dir.clone(),
            attempts: Arc::clone(&attempts),
            stall_forever: false,
            other_error: Some(boom.clone()),
            payload: b"DATA",
            released: Arc::new(Mutex::new(Vec::new())),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);

        assert_eq!(
            *attempts.lock().unwrap_or_else(|e| e.into_inner()),
            1,
            "детерминированную ошибку (не обрыв) ретраить нельзя — это маскировка бага"
        );
        let g = state.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(g.error.as_deref(), Some(boom.as_str()));

        drop(g);
        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelled_job_stops_before_any_attempt() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-cancel");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("cancel-before", Mode::Multi, 1, &out);
        {
            let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
            g.cancelled = true;
        }
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("cancel-before".into(), Arc::clone(&state));

        let attempts = Arc::new(Mutex::new(0usize));
        let source = StallSource {
            file_id: 904,
            dir: dir.clone(),
            attempts: Arc::clone(&attempts),
            stall_forever: false,
            other_error: None,
            payload: b"DATA",
            released: Arc::new(Mutex::new(Vec::new())),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);

        assert_eq!(
            *attempts.lock().unwrap_or_else(|e| e.into_inner()),
            0,
            "отменённое задание не должно начинать ни одной попытки"
        );

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Предикат watchdog'а — «по заданию нет прогресса дольше лимита».
    #[test]
    fn stalled_for_detects_silent_part() {
        let state = mk_state("stall-detect", Mode::Multi, 1, Path::new("/tmp/x.bin"));
        let limit = Duration::from_secs(60);

        // Свежий прогресс — обрыва нет.
        assert!(stalled_for(&state, limit).is_none());

        // Прогресс «замер» 61с назад (как при обрыве сети).
        {
            let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
            g.last_progress_at = Instant::now() - Duration::from_secs(61);
        }
        let idle = stalled_for(&state, limit).expect("watchdog обязан увидеть обрыв");
        assert!(idle >= Duration::from_secs(60));

        // Возобновление прогресса (updateFile после возврата сети) снимает обрыв.
        {
            let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
            g.last_progress_at = Instant::now();
        }
        assert!(
            stalled_for(&state, limit).is_none(),
            "прогресс вернулся — часть живая"
        );
    }

    // ── BUG-RCA-SPAM-002: TTL-метки завершённых частей ──────────────────────
    //
    // Симптом (live 2026-09-28, e2e-prod32, run с FIXED-бинаря): сразу после
    // `part_fetch`/`part_io` в upload-конвейер заходил ФИНАЛЬНЫЙ `updateFile`
    // по «зеркальному» file_id части (1249 при качавшемся 1246, 1256 при 1245) —
    // записи в `file_index` уже нет, `is_active_part_download` → false, событие
    // уходило в `pending_updates` как «race condition».

    /// Завершение части помечает и её file_id, и `remote.id` (зеркала).
    #[test]
    fn completed_part_ttl_matches_file_id_and_remote() {
        let _guard = global_state_lock();
        clear_completed_parts_for_test();

        assert!(!is_recently_completed_part(777));
        assert!(!is_recently_completed_part_remote("REMOTE-777"));

        mark_part_completed(777, "REMOTE-777");

        assert!(
            is_recently_completed_part(777),
            "свой file_id завершённой части обязан быть помечен"
        );
        assert!(
            is_recently_completed_part_remote("REMOTE-777"),
            "«зеркальный» file_id опознаётся по remote.id завершённой части"
        );
        assert!(!is_recently_completed_part(778));
        assert!(!is_recently_completed_part_remote("REMOTE-778"));
        // Пустой remote.id не должен матчиться ни с чем (иначе погасили бы
        // события чужих загрузок без remote-ключа).
        mark_part_completed(779, "");
        assert!(!is_recently_completed_part_remote(""));

        clear_completed_parts_for_test();
        assert!(
            !is_recently_completed_part(777),
            "метка обязана исчезать после сброса"
        );
    }

    /// `reset()` (tdlib_reset_auth) чистит TTL-метки: file_id другой сессии.
    #[test]
    fn reset_clears_completed_parts() {
        let _guard = global_state_lock();
        clear_completed_parts_for_test();
        mark_part_completed(881, "REMOTE-881");
        assert!(is_recently_completed_part(881));
        reset();
        assert!(!is_recently_completed_part(881));
        assert!(!is_recently_completed_part_remote("REMOTE-881"));
    }

    // ── BUG-PART-CACHE-PEAK-001: кеш ПРИНЯТОЙ части снимается сразу ──────────
    //
    // Живой замер (multi, files.id=35, 2026-09-28): `part_fetch` 243 293 мс /
    // 176 756 мс, `part_io.append_ms` — 1 931 / 989 мс ПОСЛЕ каждой части, а кеш
    // TDLib держит вторую копию файла до конца задания (`purge_cache_after_success`
    // зовётся один раз в финале). Пик на files.id=38 (2 × 2.09 ГБ) ≈ 8.4 ГБ
    // (кеш + target) — на Win7/8 со скромным C: это ENOSPC, а не «медленно».

    /// Источник-регистратор: пишет порядок событий и размер target'а В МОМЕНТ
    /// освобождения кеша (склейка обязана быть уже завершена).
    struct RecordingSource {
        dir: std::path::PathBuf,
        out: std::path::PathBuf,
        file_id: i32,
        payload: Vec<u8>,
        events: Arc<Mutex<Vec<String>>>,
    }

    impl PartSource for RecordingSource {
        fn resolve(&self, _part: &PartDesc) -> Result<i32, String> {
            Ok(self.file_id)
        }

        fn fetch(&self, _file_id: i32, part: &PartDesc) -> Result<std::path::PathBuf, String> {
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("fetch:{}", part.part_index));
            let p = self.dir.join(format!("part{}.bin", part.part_index));
            std::fs::write(&p, &self.payload).map_err(|e| e.to_string())?;
            Ok(p)
        }

        fn release_cache(&self, file_id: i32) {
            let target = std::fs::metadata(&self.out).map(|m| m.len()).unwrap_or(0);
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("release:{file_id}:{target}"));
        }
    }

    #[test]
    fn successful_part_releases_tdlib_cache() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-release-cache");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("release-cache", Mode::Multi, 1, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("release-cache".into(), Arc::clone(&state));

        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let source = RecordingSource {
            dir: dir.clone(),
            out: out.clone(),
            file_id: 991,
            payload: b"DATA".to_vec(),
            events: Arc::clone(&events),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);

        let seen = events.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert_eq!(
            seen,
            vec!["fetch:0".to_string(), "release:991:4".to_string()],
            "кеш части обязан сниматься РОВНО ОДИН РАЗ и уже ПОСЛЕ склейки \
             (`release:<file_id>:<размер target>`)"
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"DATA");
        {
            let g = state.lock().unwrap_or_else(|e| e.into_inner());
            assert!(
                g.completed && g.error.is_none(),
                "задание обязано завершиться успешно"
            );
        }

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Непринятая часть обязана СОХРАНИТЬ кеш: он — источник resume для
    /// stall-ретрая (BUG-DOWNLOAD-049) и материал повторного разбора; снятие
    /// «на всякий случай» сделало бы повтор холодным.
    #[test]
    fn unaccepted_part_keeps_cache_for_resume() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-parts-keep-cache");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // (а) обрыв, который не вылечился: попытки исчерпаны → части нет.
        let out = dir.join("out-stall.bin");
        let state = mk_state("keep-cache-stall", Mode::Multi, 1, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("keep-cache-stall".into(), Arc::clone(&state));
        let released = Arc::new(Mutex::new(Vec::<i32>::new()));
        let source = StallSource {
            file_id: 902,
            dir: dir.clone(),
            attempts: Arc::new(Mutex::new(0)),
            stall_forever: true,
            other_error: None,
            payload: b"DATA",
            released: Arc::clone(&released),
        };
        run_job_with_source(&state, vec![test_part(0)], &source);
        assert!(
            state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .error
                .is_some(),
            "исчерпанные stall-попытки обязаны уронить задание"
        );
        assert!(
            released.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
            "при обрыве кеш части — единственный источник resume, снимать его нельзя"
        );

        // (б) size-guard: часть скачалась, но карточка заявляет другой размер.
        let out2 = dir.join("out-short.bin");
        let state2 = mk_state("keep-cache-short", Mode::Multi, 1, &out2);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("keep-cache-short".into(), Arc::clone(&state2));
        let released2 = Arc::new(Mutex::new(Vec::<i32>::new()));
        let source2 = StallSource {
            file_id: 992,
            dir: dir.clone(),
            attempts: Arc::new(Mutex::new(0)),
            stall_forever: false, // 1-я попытка «зависает» → 2-я отдаёт 4 байта
            other_error: None,
            payload: b"DATA",
            released: Arc::clone(&released2),
        };
        run_job_with_source(
            &state2,
            vec![PartDesc::new("REMOTE_0".into(), 0, None, Some(10))],
            &source2,
        );
        let err = state2
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .error
            .clone()
            .unwrap_or_default();
        assert!(
            err.contains("size mismatch"),
            "ожидался size-guard, получено: {err}"
        );
        assert!(
            released2.lock().unwrap_or_else(|e| e.into_inner()).is_empty(),
            "непринятая часть (size-guard) обязана сохранить кеш"
        );

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── BUG-RCA-SPAM-003: «зеркальный» file.id АКТИВНОЙ части/загрузки ───────
    //
    // Live (e2e-prod32, 2026-09-28): `updateFile COMPLETED file_id=1257` приходит
    // В ТОТ ЖЕ МОМЕНТ, когда `part_fetch` части 1246 завершается, — раньше, чем
    // `process_part_once` успеет вызвать `mark_part_completed`. Гейты «недавно
    // завершена» (TTL) такую события не видят (часть ещё АКТИВНА), и оно уходило
    // в upload как «race condition» → буфер `pending_updates`.
    #[test]
    fn mirror_update_of_active_part_is_owned_by_download() {
        let _guard = global_state_lock();
        reset();
        let dir = std::env::temp_dir().join("engine-core-race-part");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.bin");
        let state = mk_state("race-part", Mode::Multi, 2, &out);
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("race-part".into(), Arc::clone(&state));
        {
            let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
            g.current_file_id = 1246;
            g.remote_id = "REMOTE-PART-ACTIVE-A".to_string();
        }

        // ЗЕРКАЛО: другой file.id, но тот же remote.id — событие ПОКА часть активна
        // (mark_part_completed ещё не вызван; именно так было на live 10:59:49).
        let mirror = json!({
            "@type": "updateFile",
            "file": {
                "id": 1257,
                "remote": {
                    "id": "REMOTE-PART-ACTIVE-A",
                    "is_uploading_completed": true,
                    "uploaded_size": 2093796556
                },
                "local": { "downloaded_size": 2093796556 }
            }
        });
        assert!(
            !crate::upload::on_update_file(&mirror),
            "зеркало АКТИВНОЙ части принадлежит download, а не upload"
        );
        assert_eq!(
            crate::upload::pending_len_for_test(1257),
            0,
            "зеркало активной части не должно буферизоваться в upload"
        );

        reset();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// То же для single-загрузки: пока запись активна, её remote.id — «наш».
    #[test]
    fn mirror_update_of_active_single_is_owned_by_download() {
        let file_id = 910_031;
        crate::download::register_test_download_with_remote(file_id, "REMOTE-SINGLE-ACTIVE-A");
        let mirror = json!({
            "@type": "updateFile",
            "file": {
                "id": file_id + 1,
                "remote": {
                    "id": "REMOTE-SINGLE-ACTIVE-A",
                    "is_uploading_completed": true,
                    "uploaded_size": 1024
                },
                "local": { "downloaded_size": 1024 }
            }
        });
        assert!(
            !crate::upload::on_update_file(&mirror),
            "зеркало активной загрузки — не upload"
        );
        assert_eq!(crate::upload::pending_len_for_test(file_id + 1), 0);
        crate::download::unregister_test_download(file_id);
    }
}
