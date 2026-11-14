//! M4a3 — single-file download через TDLib JSON FFI (без Tauri).
//!
//! Реализует основной путь DownloadPage mainline:
//!   1. `getRemoteFile(remote_file_id)` → TDLib file_id + size (send_and_wait);
//!   2. `start_download(file_id, save_path, chat_id, message_id)` — отправляет
//!      getMessage-warmup (если заданы) + downloadFile, регистрирует file_id;
//!   3. receive-loop runtime вызывает `on_update_file()` на каждый updateFile:
//!      прогресс (throttle) → событие `tdlib-download-progress`; по завершении
//!      файл перемещается из TDLib-кеша в save_path.
//!
//! Multi/composite/vault/owner download (несколько tg_file_id, склейка) — след.
//! шаг M4a3 (Sequential Part Accumulator), поверх тех же примитивов.
//!
//! ⚠️ Требование протокола: stdout — только кадры. Прогресс шлём событием, а не
//! println. Скорость/ETA считаются по таймстемпам между updateFile.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tdlib_runtime::TdlibRuntime;

/// Записать событие-кадр в stdout (из фонового receive-потока). length-prefix.
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

/// Эмиссия события download (без id — парсер main отделяет по `event`).
fn emit_event(name: &str, payload: Value) {
    emit_frame(&json!({
        "jsonrpc": "2.0",
        "event": name,
        "params": payload,
    }));
}

/// Реестр активных single-download (file_id → состояние).
///
/// BUG-UX-001 (auto-purge): после КАЖДОГО успешного single-download кеш TDLib
/// чистится целиком (`post_download_purge`, глобальный выбор) — файловая чистка
/// безопасна из receive-потока (без `cleanFileDatabase`/`send_and_wait`, иначе
/// дедлок единственного потребителя `td_json_client_receive`).
fn purge_cache_after_success() {
    crate::tdlib_runtime::post_download_purge();
}

#[derive(Clone)]
pub struct DownloadEntry {
    pub file_id: i32,
    pub target_path: Option<String>,
    pub total: u64,
    pub downloaded: u64,
    pub completed: bool,
    pub cancelled: bool,
    pub error: Option<String>,
    pub file_name: Option<String>,
    /// `remote.id` скачиваемого файла (из `updateFile`).
    ///
    /// Нужен, чтобы узнать «зеркало»: TDLib держит ОДИН remote-файл под
    /// несколькими `file.id` (наша загрузка + копия документа доставки в другом
    /// чате) и шлёт финальный `updateFile` по обоим — при этом зеркального
    /// `file.id` в реестре нет вовсе (BUG-RCA-SPAM-002).
    pub remote_id: Option<String>,
    /// Момент успешного завершения (`None` — ещё не завершён).
    ///
    /// BUG-RCA-SPAM-002: после завершения TDLib шлёт ФИНАЛЬНЫЙ `updateFile`
    /// (`is_uploading_completed=true`) — на этот раз `is_active_download` уже
    /// `false` (запись завершена), и событие снова попадало в upload-конвейер.
    /// Тот же финальный `updateFile` приходит и для «зеркального» file_id
    /// документа доставки (тот же `remote.id`, другой `file.id`) — он в реестре
    /// вообще отсутствует. Поэтому TTL-окно «файл ещё наш».
    pub completed_at: Option<Instant>,
    last_emit: Option<Instant>,
    last_emit_percent: i64,
    /// Время последней RCA-выборки прогресса (`[dl-rca] phase=progress`).
    /// Прогресс приходит раз в 512 КБ — писать строку на каждое событие нельзя,
    /// но нужна тайм-серия, чтобы видеть «плато» скорости (в т.ч. внутренний
    /// FLOOD_WAIT TDLib — он приходит молчанием, а не ошибкой).
    last_rca: Option<Instant>,
}

fn global_registry() -> &'static Mutex<HashMap<i32, DownloadEntry>> {
    static REG: OnceLock<Mutex<HashMap<i32, DownloadEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Время старта процесса (для скорости по умолчанию).
static START_TS: AtomicI64 = AtomicI64::new(0);

pub fn init() {
    START_TS.store(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
        Ordering::SeqCst,
    );
}

/// Сбросить реестр загрузок (вызывается при `tdlib_reset_auth`): после ресета
/// TDLib file_id невалидны, старые записи прогресса вводили бы UI в заблуждение.
pub fn reset() {
    let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.clear();
}

/// Период RCA-выборки прогресса single-download (тайм-серия в `[dl-rca]`).
const PROGRESS_RCA_INTERVAL_MS: u64 = 5_000;

/// `true`, если `remote_id` принадлежит АКТИВНОЙ (незавершённой) single-загрузке.
///
/// «Зеркальный» `file.id` копии документа доставки в другом чате не заводится в
/// реестре, но `updateFile` по нему приходит ещё ДО `complete()` — TTL-метки
/// (BUG-RCA-SPAM-002) его не увидят. Запись активна уже имеет `remote.id`
/// (выставляется при старте fetch), поэтому матчим по нему (BUG-RCA-SPAM-003).
pub fn is_active_download_remote(remote_id: &str) -> bool {
    if remote_id.is_empty() {
        return false;
    }
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|e| {
            !e.completed
                && !e.cancelled
                && e.error.is_none()
                && e.remote_id.as_deref() == Some(remote_id)
        })
}

/// `true`, если `file_id` — НЕЗАВЕРШЁННАЯ single-загрузка.
///
/// Нужно upload-конвейеру: `updateFile` скачиваемого файла (одно событие на
/// 512 КБ) раньше попадало в upload как «race condition» → «NOT FOUND in
/// file_index → buffering as pending»: спам в лог + утечка JSON в
/// `pending_updates` (BUG-RCA-SPAM-001). Завершённые записи реестра остаются
/// (UI читает из них local_path), поэтому проверяем именно активность.
pub fn is_active_download(file_id: i32) -> bool {
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .map(|e| !e.completed && !e.cancelled && e.error.is_none())
        .unwrap_or(false)
}

/// Окно «файл ещё наш» после завершения: разбираем финальный `updateFile`
/// (BUG-RCA-SPAM-002). 120 с с запасом покрывают лаг финального события и
/// повторный `updateFile` по зеркальному file_id документа доставки.
const RECENTLY_COMPLETED_TTL: Duration = Duration::from_secs(120);

/// `true`, если file_id — ТОЛЬКО ЧТО завершённая загрузка (в пределах TTL).
///
/// Завершённая запись остаётся в реестре (UI читает из неё `local_path`), но
/// upload-конвейеру она тоже не принадлежит: финальный `updateFile` приходил в
/// него как «race condition» и оседал в `pending_updates` (BUG-RCA-SPAM-002).
pub fn is_recently_completed_download(file_id: i32) -> bool {
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .and_then(|e| e.completed_at)
        .map(|t| t.elapsed() < RECENTLY_COMPLETED_TTL)
        .unwrap_or(false)
}

/// `true`, если `remote_id` — файл ТОЛЬКО ЧТО завершённой загрузки.
///
/// Зеркальный `file.id` (копия документа доставки в другом чате) в реестре не
/// заводится, но `remote.id` у него ТОТ ЖЕ — по нему и опознаём событие
/// (BUG-RCA-SPAM-002). Матч по remote безопасен: событие по СВОЕМУ upload'у
/// отсекается раньше — по `file_index` (см. `upload::on_update_file`).
pub fn is_recently_completed_remote(remote_id: &str) -> bool {
    if remote_id.is_empty() {
        return false;
    }
    let now = Instant::now();
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|e| {
            e.remote_id.as_deref() == Some(remote_id)
                && e.completed_at
                    .map(|t| now.duration_since(t) < RECENTLY_COMPLETED_TTL)
                    .unwrap_or(false)
        })
}

/// Download-RCA в файл (Linux-dev, e2e-prod32): одна JSON-строка с префиксом
/// `[dl-rca]` в stderr → `engine-core.log`. Формат полей — как у UI-зеркала
/// (`appendDownloadRca`): `op/phase/ms/...`, чтобы single и multi лежали рядом.
/// Best-effort: строка в stderr, файл дописывает SidecarManager.
pub fn rca_log(op: &str, phase: &str, fields: serde_json::Value) {
    let line = rca_line(op, phase, fields);
    let stderr = std::io::stderr();
    let _ = write_rca_line(&mut stderr.lock(), &line);
}

/// Собрать строку RCA-лога: ровно одна строка, без внутренних переводов.
fn rca_line(op: &str, phase: &str, fields: serde_json::Value) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("op".to_string(), serde_json::Value::String(op.to_string()));
    obj.insert("phase".to_string(), serde_json::Value::String(phase.to_string()));
    if let serde_json::Value::Object(map) = fields {
        for (k, v) in map {
            obj.insert(k, v);
        }
    }
    format!("[dl-rca] {}", serde_json::Value::Object(obj))
}

/// Записать RCA-строку ОДНИМ `write` в приёмник (BUG-RCA-LOG-FRAG-001).
///
/// `eprintln!`/`write_fmt` на НЕбуферизованном `stderr` делает отдельный `write`
/// на каждый фрагмент форматирования (serde_json Display — десятки мелких
/// `write`). Каждый такой write приходил в Electron отдельным chunk'ом, а
/// `SidecarManager` навешивал timestamp на chunk → метка попадала в середину
/// JSON и лог нельзя было распарсить (живой файл e2e-prod32: до 19 меток внутри
/// одной строки). Здесь строка собирается заранее вместе с `\n` и уходит одним
/// `write_all`.
fn write_rca_line<W: std::io::Write>(out: &mut W, line: &str) -> std::io::Result<()> {
    out.write_all(format!("{line}\n").as_bytes())
}

/// Тип события прогресса (совпадает по именам полей с mainline TdlibDownloadProgress).
fn progress_json(e: &DownloadEntry, percent: u32) -> Value {
    json!({
        "file_id": e.file_id,
        "downloaded": e.downloaded,
        "total": e.total,
        "percent": percent,
        "speed_bytes_per_sec": 0u64,
        "eta_secs": 0u64,
        "completed": e.completed,
        "cancelled": e.cancelled,
        "error": e.error,
        "local_path": e.target_path,
        "file_name": e.file_name,
    })
}

/// getRemoteFile: remote_file_id → {file_id, size}.
pub fn get_remote_file(
    rt: &TdlibRuntime,
    remote_file_id: &str,
    chat_id: Option<i64>,
) -> Result<Value, String> {
    if remote_file_id.is_empty() {
        return Err("getRemoteFile: empty remote_file_id".into());
    }
    let started = std::time::Instant::now();
    let extra = format!("grf_{}", uuid_suffix());
    let mut req = json!({
        "@type": "getRemoteFile",
        "remote_file_id": remote_file_id,
        "file_type": {"@type": "fileTypeDocument"},
        "@extra": extra,
    });
    if let Some(cid) = chat_id {
        // BUG-CROSS-USER-DOWNLOAD-005: chat_id — подсказка TDLib для поиска в
        // контексте приватной супергруппы.
        req["chat_id"] = json!(cid);
    }
    let resp = rt.send_and_wait(req, Duration::from_secs(15));
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match &resp {
        Ok(v) => rca_log(
            "single",
            "get_remote_file",
            json!({
                "ms": elapsed_ms,
                "file_id": v["id"].as_i64().unwrap_or(0),
                "size": v["size"].as_u64().unwrap_or(0),
            }),
        ),
        Err(e) => rca_log("single", "get_remote_file_error", json!({ "ms": elapsed_ms, "error_text": e })),
    }
    let resp = resp?;
    if resp["@type"].as_str() != Some("file") {
        return Err(format!(
            "getRemoteFile: unexpected response @type={}",
            resp["@type"].as_str().unwrap_or("?")
        ));
    }
    let file_id = resp["id"].as_i64().unwrap_or(0) as i32;
    if file_id == 0 {
        return Err("getRemoteFile: file without id".into());
    }
    let size = resp["size"].as_u64().unwrap_or(0);
    Ok(json!({ "file_id": file_id, "size": size }))
}

/// Извлечь сведения о документе из сообщения TDLib.
///
/// Структура `messageDocument` единая для обеих версий (BUG-RELEASE-SCHEMA-001):
/// `content.document` = `{ @type: "document", document: { @type: "file", id } }`
/// — без обёртки `inputDocument` (она только у `inputMessageDocument`).
///
/// `None` — если это не `message` либо в нём нет документа (например,
/// `@type=error` «Message not found» из-за расхождения id бот/клиент).
pub fn doc_info_from_message(msg: &Value) -> Option<Value> {
    if msg["@type"].as_str() != Some("message") {
        return None;
    }
    let doc = &msg["content"]["document"];
    if doc.is_null() || !doc.is_object() {
        return None;
    }
    // messageDocument → content.document.document (file).
    let file_id = doc["document"]["id"].as_i64().unwrap_or(0);
    if file_id == 0 {
        return None;
    }
    Some(json!({
        "file_id": file_id,
        "file_name": doc["file_name"].as_str().unwrap_or("").to_string(),
        "size": doc["document"]["size"].as_i64().unwrap_or(0),
        // BUG-DOWNLOAD-052: стабильный идентификатор файла Telegram,
        // сессионно-независимый ключ документа части (совпадает с Bot-API
        // `file_unique_id`, который сервер кладёт в `pm_delivery.unique_id`).
        "unique_id": doc["document"]["remote"]["unique_id"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        // SP-15 срез 5 (D-071): миниатюра Telegram внутри того же документа —
        // галерея карточки берёт её СВОИМ TDLib (как прошивку), не дёргая
        // серверный прокси (Bot API `getFile` ≤20 МБ). Нет миниатюры → 0,
        // вызывающий падает на оригинал (fail-open).
        "thumb_file_id": doc["thumbnail"]["file"]["id"].as_i64().unwrap_or(0),
        "thumb_size": doc["thumbnail"]["file"]["size"].as_i64().unwrap_or(0),
        "thumb_unique_id": doc["thumbnail"]["file"]["remote"]["unique_id"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    }))
}

/// Нужно ли после `getMessage` идти за документом в историю чата?
///
/// Да — только для `error`/`message` без документа (промах по id). Неожиданный
/// `@type` считаем настоящей ошибкой (fallback не делаем) — паритет с mainline.
pub fn should_fallback_to_history(resp: &Value) -> bool {
    match resp["@type"].as_str() {
        Some("error") | Some("message") => doc_info_from_message(resp).is_none(),
        _ => false,
    }
}

/// id последнего сообщения чата из ответа `getChat` (`last_message.id`).
///
/// BUG-DOWNLOAD-052 (live 2026-09-26, «документов в окне=0»): `getChatHistory`
/// с `from_message_id=0` в клиентской TDLib-сессии вернул **1 сообщение**
/// (не «срез от последнего»), поэтому окно не содержало документов доставки и
/// пер-частовый резолв по `unique_id` был невозможен. Явная точка отсчёта из
/// `getChat` снимает неоднозначность: `from_message_id = last_message.id`.
pub fn last_message_id_from_chat(resp: &Value) -> Option<i64> {
    resp["last_message"]["id"].as_i64().filter(|v| *v > 0)
}

/// История чата одним вызовом (для инъекции транспорта в тестах).
type HistoryCall<'a> = dyn FnMut(Value) -> Result<Value, String> + 'a;

/// Транспорт TDLib-запроса для боевого пути (`send_and_wait` с таймаутом 8с).
fn td_call(rt: &TdlibRuntime) -> impl FnMut(Value) -> Result<Value, String> + '_ {
    move |req: Value| rt.send_and_wait(req, Duration::from_secs(8))
}

/// Точка отсчёта окна истории в клиентской TDLib-сессии: `getChat.last_message.id`.
///
/// BUG-DOWNLOAD-052 (фаза 2) — общий контракт для ВСЕХ вызовов `getChatHistory`:
/// `from_message_id=0` отдаёт **одно** последнее сообщение (не срез ленты), поэтому
/// история всегда запрашивается от `last_message.id`. `0` — только если `getChat`
/// недоступен (совместимое поведение).
pub fn history_start_message_id(rt: &TdlibRuntime, chat_id: i64) -> i64 {
    let mut call = td_call(rt);
    call(json!({
        "@type": "getChat",
        "chat_id": chat_id,
        "@extra": format!("gc_{}", uuid_suffix()),
    }))
    .ok()
    .and_then(|resp| last_message_id_from_chat(&resp))
    .unwrap_or(0)
}

/// Объединить срезы истории: уникальные сообщения по `id`, новые первыми.
///
/// BUG-DOWNLOAD-052 (фаза 3): «срез от 0» (серверный последний) и «срез от
/// `getChat.last_message.id`» могут расходиться — локальный `last_message` в
/// клиентской TDLib иногда устаревает, и оба среза нужны вместе.
fn merge_history_pages(pages: Vec<Vec<Value>>) -> Vec<Value> {
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    for page in pages {
        for msg in page {
            let id = msg["id"].as_i64().unwrap_or(0);
            if id != 0 && !seen.insert(id) {
                continue;
            }
            out.push(msg);
        }
    }
    out.sort_by_key(|m| -m["id"].as_i64().unwrap_or(0));
    out
}

/// Срез истории чата от серверного «последнего» сообщения (`from_message_id=0`).
///
/// Используется как warm-up: TDLib тянет свежие сообщения с сервера, даже если
/// локальный `getChat.last_message` устарел (важно для только что созданной
/// PM-доставки). Результат может быть частичным (TDLib подгружает асинхронно),
/// поэтому окно собирается из нескольких страниц и объединяется.
fn warm_history_page(
    call: &mut HistoryCall<'_>, chat_id: i64, limit: i32,
) -> Vec<Value> {
    // `openChat` уведомляет TDLib, что чат активен: он форсирует загрузку истории
    // с сервера (без этого свежая PM-доставка не видна в холодной/фоновой сессии).
    let _ = call(json!({
        "@type": "openChat",
        "chat_id": chat_id,
        "@extra": format!("open_{}", uuid_suffix()),
    }));
    let mut pages: Vec<Vec<Value>> = Vec::new();
    // До 3 попыток: в холодной сессии первый запрос часто отдаёт одно сообщение,
    // пока TDLib не догрузит ленту с сервера.
    for attempt in 0..3 {
        let resp = call(json!({
            "@type": "getChatHistory",
            "chat_id": chat_id,
            "from_message_id": 0,
            "offset": 0,
            "limit": limit,
            "only_local": false,
            "@extra": format!("warm_{}", uuid_suffix()),
        }));
        if let Ok(resp) = resp {
            if let Some(arr) = resp["messages"].as_array() {
                let page: Vec<Value> = arr.clone();
                let len = page.len();
                pages.push(page);
                if len > 1 {
                    break;
                }
            }
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
    merge_history_pages(pages)
}

/// `chat_documents` с инъекцией транспорта (тестируемость BUG-DOWNLOAD-052).
///
/// Окно собирается из ДВУХ источников и объединяется (дедуп по `id`):
///   1. срез от серверного последнего (`from_message_id=0`) — подтягивает только
///      что созданную доставку, которую локальный `last_message` ещё не отразил;
///   2. срез от `getChat.last_message.id` — надёжен, когда серверный «последний»
///      не отдаётся (наблюдалось: 1 сообщение в холодной сессии).
pub fn chat_documents_with(
    call: &mut HistoryCall<'_>, chat_id: i64, limit: i32,
) -> Result<Vec<Value>, String> {
    let warm = warm_history_page(call, chat_id, limit);

    let last_id = call(json!({
        "@type": "getChat",
        "chat_id": chat_id,
        "@extra": format!("gc_{}", uuid_suffix()),
    }))
    .ok()
    .and_then(|resp| last_message_id_from_chat(&resp))
    .unwrap_or(0);

    let mut pages: Vec<Vec<Value>> = vec![warm];
    let tail = chat_history_page(call, chat_id, last_id, limit)?;
    if !tail.is_empty() {
        pages.push(tail);
    } else if last_id != 0 {
        let retry = chat_history_page(call, chat_id, 0, limit)?;
        if !retry.is_empty() {
            pages.push(retry);
        } else {
            eprintln!(
                "engine-core[download]: getChatHistory(chat={chat_id}, last_id={last_id}, \
                 limit={limit}) вернул пустой срез (и с from_message_id=0) — истории нет в сессии"
            );
        }
    }
    let messages = merge_history_pages(pages);
    // Возвращаем чат в прежнее состояние: резолв не должен оставлять его «открытым».
    let _ = call(json!({
        "@type": "closeChat",
        "chat_id": chat_id,
        "@extra": format!("close_{}", uuid_suffix()),
    }));
    Ok(messages.iter().filter_map(doc_info_from_message).collect())
}

/// Один срез истории чата (`getChatHistory`) — сырые сообщения.
fn chat_history_page(
    call: &mut HistoryCall<'_>, chat_id: i64, from_message_id: i64, limit: i32,
) -> Result<Vec<Value>, String> {
    let resp = call(json!({
        "@type": "getChatHistory",
        "chat_id": chat_id,
        "from_message_id": from_message_id,
        "offset": 0,
        "limit": limit,
        "only_local": false,
        "@extra": format!("hist_{}", uuid_suffix()),
    }))?;
    let messages = resp["messages"].as_array().ok_or_else(|| {
        format!(
            "chat_documents: getChatHistory(chat={chat_id}, from={from_message_id}) \
             без поля messages (@type={})",
            resp["@type"].as_str().unwrap_or("?")
        )
    })?;
    Ok(messages.clone())
}

/// Выбрать документ части из снимка истории PM (новые первыми).
///
/// * `size > 0` — матч ТОЛЬКО по размеру части; `skip` — сколько более новых
///   документов того же размера пропустить (части доставлены в порядке
///   `part_index`, последняя — самая свежая, поэтому для части `P` сдвиг равен
///   числу более поздних частей того же размера).
/// * `size == 0` — размер неизвестен: выбор чисто по позиции (документ `skip`-й
///   от свежего края).
///
/// Чужие документы (другие размеры) НЕ сбивают счётчик `skip`.
pub fn pick_document_by_size(docs: &[Value], size: u64, skip: usize) -> Option<Value> {
    let mut seen = 0usize;
    for d in docs {
        let dsize = d["size"].as_u64().unwrap_or(0);
        if size > 0 && dsize != size {
            continue;
        }
        if seen < skip {
            seen += 1;
            continue;
        }
        return Some(d.clone());
    }
    None
}

/// Минимальное окно истории PM при резолве части (BUG-DOWNLOAD-052).
///
/// `skip + 8` считается от НАШИХ частей, но в окне живут и посторонние документы
/// (например, собственные upload-сообщения клиента после доставки) — окно 9
/// сообщений их не перекрывает. 24 сообщения покрывают реальные PM-ленты.
const MIN_PM_HISTORY_WINDOW: i32 = 24;

/// Верхняя граница окна истории PM (ограничение TDLib: `limit <= 100`).
///
/// Нужна при ПЕРЕИСПОЛЬЗОВАНИИ активного lease: доставка сделана в начале
/// 24-часового окна lease, а PM-лента с тех пор выросла (свои upload-сообщения,
/// `/start`), поэтому часть может лежать глубже базового окна (BUG-DOWNLOAD-052
/// фаза 2, files.id=35: доставка за 26 сообщений до конца ленты).
const PM_HISTORY_MAX_WINDOW: i32 = 100;

/// Лестница окон истории PM для пер-частового резолва (BUG-DOWNLOAD-052 фаза 2).
///
/// Базовое окно (`max(skip+8, 24)`) → максимум (100) без дублей: сначала дешёвый
/// срез, затем — расширенный, если часть оказалась глубже.
pub fn pm_history_window_ladder(skip: usize) -> Vec<i32> {
    let base = std::cmp::max((skip + 8) as i32, MIN_PM_HISTORY_WINDOW);
    let mut out = vec![base];
    if PM_HISTORY_MAX_WINDOW > base {
        out.push(PM_HISTORY_MAX_WINDOW);
    }
    out
}

/// Документ с заданным `unique_id` (первый от свежего края) — точный матч части.
///
/// BUG-DOWNLOAD-052: `unique_id` (TDLib `remote.unique_id`) сессионно-независим
/// и уникален ДЛЯ КАЖДОЙ части, поэтому матч не сбивается ни равными размерами
/// (files.id=38: две части по 2 093 796 556 Б), ни посторонними документами в
/// окне истории.
pub fn pick_document_by_unique_id(docs: &[Value], unique_id: &str) -> Option<Value> {
    if unique_id.is_empty() {
        return None;
    }
    docs.iter()
        .find(|d| d["unique_id"].as_str() == Some(unique_id))
        .cloned()
}

/// Краткая характеристика документов окна для диагностики провала резолва.
fn describe_docs(docs: &[Value]) -> String {
    docs.iter()
        .take(8)
        .map(|d| {
            format!(
                "{{size={}, unique={}, name={}}}",
                d["size"].as_i64().unwrap_or(0),
                d["unique_id"].as_str().unwrap_or("?"),
                d["file_name"].as_str().unwrap_or("?")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `resolve_document_in_chat_with` — резолв документа части из истории PM
/// (BUG-DOWNLOAD-051/052).
///
/// Порядок выбора:
///   1. `unique_id` (если задан) — точный матч части (BUG-DOWNLOAD-052);
///   2. `size` + `skip` — прежний контракт (равные размеры частей).
///
/// Окно — max(skip + 8, MIN_PM_HISTORY_WINDOW), а при провале — лестница
/// `pm_history_window_ladder(skip)` до лимита TDLib: часть может лежать глубже
/// базового окна (переиспользованный lease: доставка 24-часовой давности при
/// выросшей PM-ленте), а посторонние документы (свои upload-сообщения клиента)
/// не должны вытеснять доставленные части.
pub fn resolve_document_in_chat_with(
    call: &mut HistoryCall<'_>, chat_id: i64, unique_id: Option<&str>, size: u64, skip: usize,
) -> Result<Value, String> {
    let mut last_err: Option<String> = None;
    for limit in pm_history_window_ladder(skip) {
        let docs = chat_documents_with(call, chat_id, limit)?;
        if let Some(uid) = unique_id.filter(|u| !u.is_empty()) {
            if let Some(found) = pick_document_by_unique_id(&docs, uid) {
                return Ok(found);
            }
        }
        if let Some(found) = pick_document_by_size(&docs, size, skip) {
            return Ok(found);
        }
        last_err = Some(format!(
            "в истории PM (chat={chat_id}) нет документа части: size={size}, \
             unique_id={}, skip={skip}, окно={limit}, документов в окне={} [{}]",
            unique_id.unwrap_or(""),
            docs.len(),
            describe_docs(&docs),
        ));
    }
    Err(last_err.unwrap_or_else(|| {
        format!("в истории PM (chat={chat_id}) нет документа части: size={size}")
    }))
}

/// Резолв самого свежего документа из истории PM (owner-backdoor download).
///
/// Расхождение id бот/клиент возможно (legacy-записи, см. host_ingest.py), поэтому
/// `getMessage` по bot-side delivery_message_id может дать Not Found. Доставка
/// выполнена за секунду до вызова, поэтому искомый файл — самый свежий документ
/// чата. Паритет с mainline `_resolve_latest_document_in_chat`
/// (`tauri_project/desktop/src-tauri/src/tdlib_download.rs`).
pub fn resolve_latest_document_in_chat(rt: &TdlibRuntime, chat_id: i64) -> Result<Value, String> {
    let mut call = td_call(rt);
    resolve_latest_document_in_chat_with(&mut call, chat_id)
}

/// `resolve_latest_document_in_chat` с инъекцией транспорта (тесты BUG-DOWNLOAD-052).
///
/// Окно — по лестнице `pm_history_window_ladder(0)` (24 → 100): «самый свежий
/// документ» может не попасть в узкое окно 8, если после доставки в PM пришли
/// другие сообщения (свои upload-сообщения клиента, сервисные `/start`).
pub fn resolve_latest_document_in_chat_with(
    call: &mut HistoryCall<'_>, chat_id: i64,
) -> Result<Value, String> {
    for limit in pm_history_window_ladder(0) {
        let docs = chat_documents_with(call, chat_id, limit)?;
        if let Some(found) = docs.into_iter().next() {
            return Ok(found);
        }
    }
    Err(format!(
        "resolve_latest_document_in_chat: не найден document в истории PM (chat={chat_id})"
    ))
}

/// Совпадает ли найденный документ с ожидаемой частью (BUG-DOWNLOAD-052).
///
/// `unique_id` (если задан) — приоритетный критерий: он различает части с
/// одинаковым размером. Размер — страховка: принимаем документ, когда unique_id
/// части неизвестен либо TDLib его не отдал (fail-open, как с sha256).
pub fn doc_matches_part(info: &Value, expected_size: u64, unique_id: Option<&str>) -> bool {
    let file_id = info["file_id"].as_i64().unwrap_or(0);
    if file_id <= 0 {
        return false;
    }
    let size = info["size"].as_u64().unwrap_or(0);
    let doc_unique = info["unique_id"].as_str().unwrap_or("");
    if let Some(uid) = unique_id.filter(|u| !u.is_empty()) {
        if !doc_unique.is_empty() {
            return doc_unique == uid;
        }
    }
    expected_size == 0 || size == 0 || size == expected_size
}

/// Кандидаты message_id для `getMessage` в клиентской TDLib-сессии.
///
/// BUG-DOWNLOAD-052 (live 2026-09-26): клиентский TDLib отдаёт `message.id` как
/// `real << 20` (доказательство из лога клиента: `updateMessageSendSucceeded
/// sent_message_id=613416960` = 585 << 20), поэтому bot-side id доставки (577)
/// как есть промахивается («Message not found»). Пробуем исходный id и оба
/// сдвига — покрывает и старые записи без сдвига.
pub fn shifted_message_id_candidates(message_id: i64) -> Vec<i64> {
    let mut out = vec![message_id];
    if message_id > 0 {
        if let Some(shifted) = message_id.checked_shl(20) {
            if shifted > 0 && !out.contains(&shifted) {
                out.push(shifted);
            }
        }
        let unshifted = message_id >> 20;
        if unshifted > 0 && unshifted != message_id && !out.contains(&unshifted) {
            out.push(unshifted);
        }
    }
    out
}

/// `getMessage` БЕЗ fallback на историю — строгий резолв документа части.
///
/// Провал (`error` / сообщение без документа) возвращается ошибкой: parts-путь
/// обязан отличать «id не найден» от «найден не тот документ». Слепой fallback
/// `get_message_file` (самый свежий документ чата) для частей недопустим — он
/// отдаёт чужой документ (BUG-DOWNLOAD-052).
pub fn get_message_doc_strict_with(
    call: &mut HistoryCall<'_>, chat_id: i64, message_id: i64,
) -> Result<Value, String> {
    let req = json!({
        "@type": "getMessage",
        "chat_id": chat_id,
        "message_id": message_id,
    });
    let resp = call(req)?;
    doc_or_error(chat_id, message_id, &resp)
}

/// Разбор ответа `getMessage`: либо документ части, либо диагностичная ошибка.
fn doc_or_error(chat_id: i64, message_id: i64, resp: &Value) -> Result<Value, String> {
    if let Some(info) = doc_info_from_message(resp) {
        return Ok(info);
    }
    match resp["@type"].as_str() {
        Some("error") => Err(format!(
            "getMessage(chat={chat_id} msg={message_id}): {} {}",
            resp["code"].as_i64().unwrap_or(0),
            resp["message"].as_str().unwrap_or("error")
        )),
        other => Err(format!(
            "getMessage(chat={chat_id} msg={message_id}): нет документа (@type={})",
            other.unwrap_or("?")
        )),
    }
}

/// Полный PM-резолв документа части (BUG-DOWNLOAD-051/052) — единый путь.
///
/// Используется и parts-конвейером (multi/vault), и `tdlib_get_message_file`
/// (single pm_lease). Порядок:
///   1. при известном `unique_id` — история PM (`resolve_document_in_chat`):
///      `unique_id`, затем `size`+`skip`;
///   2. `getMessage` по кандидатам id (`id`, `id<<20`, `id>>20`) — СТРОГО, с
///      проверкой `doc_matches_part` (никаких «самых свежих документов чата»);
///   3. при отсутствии `unique_id` — история PM как последний фолбэк.
///
/// Ошибка содержит и промахи `getMessage`, и состав окна истории — без этого
/// «нет документа части» неотличимо от неверного чата.
pub fn resolve_pm_part_document(
    rt: &TdlibRuntime,
    chat_id: i64,
    message_id: Option<i64>,
    unique_id: Option<&str>,
    expected_size: u64,
    skip: usize,
) -> Result<Value, String> {
    let mut call = td_call(rt);
    resolve_pm_part_document_with(&mut call, chat_id, message_id, unique_id, expected_size, skip)
}

/// [`resolve_pm_part_document`] с инъекцией транспорта (тесты BUG-RCA-SPAM-002).
pub fn resolve_pm_part_document_with(
    call: &mut HistoryCall<'_>,
    chat_id: i64,
    message_id: Option<i64>,
    unique_id: Option<&str>,
    expected_size: u64,
    skip: usize,
) -> Result<Value, String> {
    let mut probe_errors: Vec<String> = Vec::new();
    let has_unique = unique_id.map(|u| !u.is_empty()).unwrap_or(false);

    // Живой замер (e2e-prod32, 2026-09-28): bot-side `message_id` доставки в
    // клиентской TDLib промахивается ВСЕГДА — и как есть (404 Not Found), и в
    // сдвиге `id << 20` (404) — два холостых RPC на каждую часть и на каждый
    // старт (~90 мс + 2 строки шума в логе на ровном месте). Поэтому при
    // известном `unique_id` первым идёт резолв по истории PM (он и есть рабочий
    // путь), а `getMessage` остаётся фолбэком для legacy-записей без unique_id.
    if has_unique {
        match resolve_document_in_chat_with(call, chat_id, unique_id, expected_size, skip) {
            Ok(doc) => return Ok(doc),
            Err(e) => probe_errors.push(e),
        }
    }

    if let Some(mid) = message_id {
        for candidate in shifted_message_id_candidates(mid) {
            match get_message_doc_strict_with(call, chat_id, candidate) {
                Ok(info) => {
                    if doc_matches_part(&info, expected_size, unique_id) {
                        return Ok(info);
                    }
                    let detail = format!(
                        "getMessage(msg={candidate}): документ другой части \
                         (size={}, unique_id={}, expected={expected_size}, expected_unique={})",
                        info["size"].as_i64().unwrap_or(0),
                        info["unique_id"].as_str().unwrap_or(""),
                        unique_id.unwrap_or(""),
                    );
                    eprintln!("engine-core[download]: {detail}");
                    probe_errors.push(detail);
                }
                Err(e) => {
                    eprintln!("engine-core[download]: {e}");
                    probe_errors.push(e);
                }
            }
        }
    }

    // Legacy-путь (без unique_id): сначала пробуем id, затем историю.
    if !has_unique {
        match resolve_document_in_chat_with(call, chat_id, unique_id, expected_size, skip) {
            Ok(doc) => return Ok(doc),
            Err(e) => probe_errors.push(e),
        }
    }

    Err(if probe_errors.is_empty() {
        format!("resolve_pm_part_document: часть не найдена (chat={chat_id}, size={expected_size})")
    } else {
        probe_errors.join(" | ")
    })
}

/// getMessage: резолв document file_id из сообщения (download context).
///
/// У бота и клиента в PM разные message_id, поэтому `getMessage` по server
/// (bot-side) id может вернуть Not Found — тогда fallback на самый свежий
/// документ истории PM (как в mainline). Без этого owner-backdoor download
/// падал после выбора пути сохранения («путь выбирается и на этом ломается»).
pub fn get_message_file(
    rt: &TdlibRuntime,
    chat_id: i64,
    message_id: i64,
) -> Result<Value, String> {
    let extra = format!("gmf_{}", uuid_suffix());
    let req = json!({
        "@type": "getMessage",
        "chat_id": chat_id,
        "message_id": message_id,
        "@extra": extra,
    });
    // ВАЖНО: сырой ответ — ошибка TDLib здесь ожидаема (id бота ≠ id клиента).
    let resp = rt.send_and_wait_raw(req, Duration::from_secs(8))?;

    if !should_fallback_to_history(&resp) {
        if let Some(info) = doc_info_from_message(&resp) {
            return Ok(info);
        }
        return Err(format!(
            "tdlib_get_message_file: unexpected getMessage response @type={}",
            resp["@type"].as_str().unwrap_or("?")
        ));
    }

    eprintln!(
        "engine-core[download]: getMessage miss (@type={}) — fallback to chat history",
        resp["@type"].as_str().unwrap_or("?")
    );
    resolve_latest_document_in_chat(rt, chat_id).map_err(|e| {
        format!(
            "tdlib_get_message_file: delivery not found in PM (chat={chat_id} msg={message_id}): {e}"
        )
    })
}

/// Запустить single download: getMessage-warmup (опц.) + downloadFile (async).
///
/// Регистрирует file_id в реестре; завершение/прогресс приходят через
/// on_update_file из receive-loop.
pub fn start_download(
    rt: &TdlibRuntime,
    file_id: i32,
    priority: i32,
    offset: i64,
    limit: i64,
    synchronous: bool,
    save_path: Option<String>,
    chat_id: Option<i64>,
    message_id: Option<i64>,
) -> Result<String, String> {
    if file_id <= 0 {
        return Err("start_download: file_id must be > 0".into());
    }

    // getMessage warmup (как mainline BUG-DOWNLOAD-034) — улучшает привязку
    // file_id ↔ message перед downloadFile.
    if let (Some(cid), Some(mid)) = (chat_id, message_id) {
        let _ = get_message_file(rt, cid, mid);
    }

    // Регистрируем ДО отправки, чтобы не пропустить ранний updateFile.
    {
        let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
        reg.insert(
            file_id,
            DownloadEntry {
                file_id,
                target_path: save_path.clone(),
                total: 0,
                downloaded: 0,
                completed: false,
                cancelled: false,
                error: None,
                file_name: None,
                remote_id: None,
                completed_at: None,
                last_emit: None,
                last_emit_percent: 0,
                last_rca: None,
            },
        );
    }

    let extra = format!("dwn_{}", file_id);
    let req = json!({
        "@type": "downloadFile",
        "file_id": file_id,
        "priority": priority,
        "offset": offset,
        "limit": limit,
        "synchronous": synchronous,
        "@extra": extra,
    });
    rt.send_value(req)?;
    rca_log(
        "single",
        "download_file_sent",
        json!({
            "file_id": file_id,
            "priority": priority,
            "offset": offset,
            "limit": limit,
            "synchronous": synchronous,
            "chat_id": chat_id,
            "message_id": message_id,
        }),
    );

    Ok(format!(
        "Download started: file_id={}, chat_id={:?}, message_id={:?}",
        file_id, chat_id, message_id
    ))
}

/// Отмена: cancelDownloadFile + пометка в реестре + событие.
pub fn cancel_download(rt: &TdlibRuntime, file_id: i32) -> Result<Value, String> {
    let req = json!({
        "@type": "cancelDownloadFile",
        "file_id": file_id,
        "only_if_pending": false,
    });
    rt.send_value(req)?;
    let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = reg.get_mut(&file_id) {
        e.cancelled = true;
    }
    Ok(json!({ "status": "cancelled", "file_id": file_id }))
}

/// Список активных загрузок (registry → массив прогрессов).
pub fn get_downloads() -> Value {
    let reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
    let arr: Vec<Value> = reg
        .values()
        .filter(|e| !e.completed && !e.cancelled && e.error.is_none())
        .map(|e| progress_json(e, percent(e)))
        .collect();
    json!(arr)
}

fn percent(e: &DownloadEntry) -> u32 {
    if e.total > 0 {
        ((e.downloaded as f64 / e.total as f64) * 100.0).min(99.9) as u32
    } else {
        0
    }
}

/// Обработчик updateFile из receive-loop. Возвращает true, если обработано.
pub fn on_update_file(val: &Value) -> bool {
    if val["@type"].as_str() != Some("updateFile") {
        return false;
    }
    let file = &val["file"];
    let file_id = file["id"].as_i64().unwrap_or(0) as i32;
    if file_id == 0 {
        return false;
    }
    let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
    let Some(entry) = reg.get_mut(&file_id) else {
        return false; // файл не отслеживаем
    };
    if entry.cancelled {
        return true;
    }

    let local = &file["local"];
    let is_active = local["is_downloading_active"].as_bool().unwrap_or(false);
    let is_completed = local["is_downloading_completed"].as_bool().unwrap_or(false);
    let downloaded = local["downloaded_size"].as_u64().unwrap_or(0);
    let total = file["size"]
        .as_u64()
        .or_else(|| file["expected_size"].as_u64())
        .unwrap_or(entry.total);
    let local_path = local["path"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    entry.downloaded = downloaded;
    entry.total = total.max(downloaded);
    entry.file_name = file["file_name"].as_str().map(|s| s.to_string());
    if let Some(rid) = file["remote"]["id"].as_str().filter(|s| !s.is_empty()) {
        // BUG-RCA-SPAM-002: `remote.id` нужен, чтобы после завершения опознать
        // «зеркальный» file_id того же remote-файла (он в реестре не заводится).
        entry.remote_id = Some(rid.to_string());
    }

    // Готово — перемещаем из TDLib-кеша в target_path.
    if is_completed || (!is_active && total > 0 && downloaded >= total) {
        let phase_started = Instant::now();
        let from = local_path.unwrap_or_default();
        let to = entry.target_path.clone();
        entry.completed = true;
        let mut phase_ms: u64 = 0;
        if let (Some(tp), false) = (to.clone(), from.is_empty()) {
            let res = move_file(from, tp.clone());
            phase_ms = phase_started.elapsed().as_millis() as u64;
            match res {
                Ok(()) => entry.local_path_ok(&tp),
                Err(e) => {
                    entry.error = Some(e);
                    entry.completed = false;
                }
            }
        }
        if entry.completed {
            // BUG-RCA-SPAM-002: финальный `updateFile` приходит ПОСЛЕ завершения —
            // без отметки времени upload-гейт снова считал бы файл «чужим».
            entry.completed_at = Some(Instant::now());
        }
        let ev = progress_json(entry, if entry.completed { 100 } else { 0 });
        let completed_ok = entry.completed;
        let file_id_done = entry.file_id;
        let total_done = entry.total;
        drop(reg);
        emit_event("tdlib-download-progress", ev);
        if completed_ok {
            let purge_started = Instant::now();
            let removed = purge_cache_after_success();
            rca_log(
                "single",
                "finalize",
                json!({
                    "file_id": file_id_done,
                    "total": total_done,
                    "move_ms": phase_ms,
                    "purge_removed": removed,
                    "purge_ms": purge_started.elapsed().as_millis() as u64,
                }),
            );
        }
        return true;
    }

    // Прогресс с троттлингом: раз в 150мс или при смене процента.
    let now = Instant::now();
    let pct = percent(entry);
    let throttle = match entry.last_emit {
        Some(t) if now.duration_since(t) < Duration::from_millis(150) && pct == entry.last_emit_percent as u32 => {
            true
        }
        _ => false,
    };
    if !throttle {
        entry.last_emit = Some(now);
        entry.last_emit_percent = pct as i64;
        let ev = progress_json(entry, pct);
        // RCA-тайм-серия прогресса (раз в PROGRESS_RCA_INTERVAL_MS): по ней видно
        // «плато» скорости — в т.ч. внутренний FLOOD_WAIT TDLib, который наружу
        // приходит МОЛЧАНИЕМ прогресса, а не текстом ошибки (потому 429 в логе и
        // не появляется). Иначе пришлось бы писать строку на каждые 512 КБ.
        // `delta_ms` — интервал с предыдущей RCA-строки: в норме ~5с, при плато
        // резко больше → видно без парсинга тайм-серии.
        // Строку собираем под реестром, а пишем ПОСЛЕ `drop(reg)` — I/O под
        // замком держать незачем (пайп stderr + RPC-поток, ждущий реестр).
        let rca_delta_ms = entry.last_rca.map_or(0, |t| now.duration_since(t).as_millis() as u64);
        let rca = if entry
            .last_rca
            .map_or(true, |t| now.duration_since(t) >= Duration::from_millis(PROGRESS_RCA_INTERVAL_MS))
        {
            entry.last_rca = Some(now);
            Some(rca_line(
                "single",
                "progress",
                json!({
                    "file_id": entry.file_id,
                    "downloaded": entry.downloaded,
                    "total": entry.total,
                    "active": is_active,
                    "delta_ms": rca_delta_ms,
                }),
            ))
        } else {
            None
        };
        drop(reg);
        if let Some(line) = rca {
            let stderr = std::io::stderr();
            let _ = write_rca_line(&mut stderr.lock(), &line);
        }
        emit_event("tdlib-download-progress", ev);
    }
    true
}

/// Переместить файл: rename (быстро) → fallback copy+remove (EXDEV).
fn move_file(src: String, dst: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&dst).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    std::fs::rename(&src, &dst)
        .or_else(|rename_err| {
            std::fs::copy(&src, &dst)
                .and_then(|_| std::fs::remove_file(&src))
                .map_err(|copy_err| {
                    format!(
                        "rename failed ({}), copy+remove fallback failed: {}",
                        rename_err, copy_err
                    )
                })
        })
        .map_err(|e| format!("move to target: {e}"))
}

impl DownloadEntry {
    fn local_path_ok(&mut self, tp: &str) {
        // local_path в событии = target_path (куда реально положили файл).
        self.target_path = Some(tp.to_string());
    }
}

/// Уникальный суффикс для @extra (без uuid-крейта).
fn uuid_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{n:x}{:?}", std::thread::current().id())
}

/// Только для тестов: пометить file_id как активную single-загрузку
/// (реестр download живёт в этом же процессе; см. `is_active_download`).
#[cfg(test)]
pub(crate) fn register_test_download(file_id: i32) {
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            file_id,
            DownloadEntry {
                file_id,
                target_path: None,
                total: 0,
                downloaded: 0,
                completed: false,
                cancelled: false,
                error: None,
                file_name: None,
                remote_id: None,
                completed_at: None,
                last_emit: None,
                last_emit_percent: 0,
                last_rca: None,
            },
        );
}

/// Только для тестов: АКТИВНАЯ загрузка с известным `remote.id` (для теста
/// «зеркального» file.id — BUG-RCA-SPAM-003).
#[cfg(test)]
pub(crate) fn register_test_download_with_remote(file_id: i32, remote_id: &str) {
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            file_id,
            DownloadEntry {
                file_id,
                target_path: None,
                total: 0,
                downloaded: 0,
                completed: false,
                cancelled: false,
                error: None,
                file_name: None,
                remote_id: Some(remote_id.to_string()),
                completed_at: None,
                last_emit: None,
                last_emit_percent: 0,
                last_rca: None,
            },
        );
}

/// Только для тестов: пометить активную загрузку завершённой (BUG-RCA-SPAM-002).
#[cfg(test)]
pub(crate) fn complete_test_download(file_id: i32, remote_id: &str) {
    let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = reg.get_mut(&file_id) {
        e.completed = true;
        e.completed_at = Some(Instant::now());
        if !remote_id.is_empty() {
            e.remote_id = Some(remote_id.to_string());
        }
    }
}

/// Только для тестов: снять пометку активной загрузки.
#[cfg(test)]
pub(crate) fn unregister_test_download(file_id: i32) {
    global_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&file_id);
}

// Импорт Arc используется в cancel/get через TdlibRuntime параметр; держим.
#[allow(dead_code)]
fn _keep(_rt: &Arc<TdlibRuntime>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rca_log_format_has_op_and_phase() {
        // Download-RCA (Linux-dev, e2e-prod32): строка обязана нести префикс
        // `[dl-rca]` и поля op/phase — иначе grep по engine-core.log не выловит
        // single/multi фазы. Саму печать в stderr здесь не проверяем (только
        // формат JSON-объекта, который rca_log сериализует).
        let mut obj = serde_json::Map::new();
        obj.insert("op".to_string(), json!("single"));
        obj.insert("phase".to_string(), json!("download_file_sent"));
        obj.insert("priority".to_string(), json!(32));
        let v = Value::Object(obj);
        let s = v.to_string();
        assert!(s.contains("\"op\":\"single\""), "op обязан присутствовать: {s}");
        assert!(s.contains("\"phase\":\"download_file_sent\""), "phase обязана присутствовать: {s}");
        assert!(s.contains("\"priority\":32"), "параметры обязаны доноситься: {s}");
    }

    /// BUG-RCA-LOG-FRAG-001: одна логическая RCA-строка = ОДИН `write`.
    ///
    /// Репродукция живого дефекта (e2e-prod32, 2026-09-28): внутри одной
    /// JSON-строки `engine-core.log` оказалось до 19 timestamp-префиксов, потому
    /// что `eprintln!("[dl-rca] {}", value)` на НЕбуферизованном stderr делает
    /// отдельный `write` на каждый фрагмент форматирования serde_json, а
    /// `SidecarManager` навешивал метку на каждый chunk. Считаем write-и.
    #[test]
    fn rca_line_is_emitted_with_a_single_write() {
        struct CountingWriter {
            writes: usize,
            bytes: Vec<u8>,
        }
        impl std::io::Write for CountingWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                self.bytes.extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let line = rca_line(
            "single",
            "download_file_sent",
            json!({ "file_id": 1253, "priority": 32, "synchronous": false }),
        );
        let mut w = CountingWriter {
            writes: 0,
            bytes: Vec::new(),
        };
        write_rca_line(&mut w, &line).expect("write");

        assert_eq!(
            w.writes, 1,
            "строка RCA обязана уходить ОДНИМ write (иначе лог рвётся timestamp'ами)"
        );
        let text = String::from_utf8(w.bytes).expect("utf8");
        assert_eq!(
            text.lines().count(),
            1,
            "внутри строки не должно быть переводов: {text}"
        );
        let json_part = text.trim_end().trim_start_matches("[dl-rca] ");
        let v: Value = serde_json::from_str(json_part).expect("после префикса — целый JSON");
        assert_eq!(v["op"], json!("single"));
        assert_eq!(v["phase"], json!("download_file_sent"));
        assert_eq!(v["file_id"], json!(1253));
    }

    /// Гейт «активной загрузки»: реестр помнит и ЗАВЕРШЁННЫЕ записи (UI читает
    /// из них local_path) — они upload'у не мешают.
    #[test]
    fn is_active_download_only_for_unfinished_entries() {
        let file_id = 424_241;
        assert!(!is_active_download(file_id), "неизвестный файл — не наша загрузка");
        register_test_download(file_id);
        assert!(is_active_download(file_id), "активная запись — наша");
        {
            let mut reg = global_registry().lock().unwrap_or_else(|e| e.into_inner());
            let e = reg.get_mut(&file_id).expect("entry");
            e.completed = true;
        }
        assert!(
            !is_active_download(file_id),
            "завершённая запись не должна блокировать upload-конвейер"
        );
        unregister_test_download(file_id);
    }

    // ── BUG-DOWNLOAD-051: выбор документа части из истории PM ────────────────
    //
    // Симптом: multi-download публичного файла (pm_lease) падал в
    // `getRemoteFile(Vault-якорь) → TDLib 400 Invalid remote file identifier`.
    // После доставки частей в PM документы лежат в истории чата НОВЫЕ первыми:
    // последняя доставленная часть (старший part_index) — самая свежая.
    // Матчер обязан отдавать документ ИМЕННО запрошенной части (по размеру +
    // сдвигу среди частей того же размера), а не «самый свежий» (иначе все
    // части получили бы последнюю).

    fn doc(file_id: i32, size: u64) -> Value {
        json!({ "file_id": file_id, "size": size, "file_name": "" })
    }

    #[test]
    fn pick_document_by_size_returns_unique_match() {
        // [p2(size=300), p1(size=200), p0(size=100)] — новые первыми.
        let docs = vec![doc(12, 300), doc(11, 200), doc(10, 100)];

        assert_eq!(pick_document_by_size(&docs, 100, 0).unwrap()["file_id"], 10);
        assert_eq!(pick_document_by_size(&docs, 200, 0).unwrap()["file_id"], 11);
        assert_eq!(pick_document_by_size(&docs, 300, 0).unwrap()["file_id"], 12);
    }

    #[test]
    fn pick_document_by_size_uses_skip_for_equal_sizes() {
        // Все части одного размера: часть P должна получить документ с ПРАВИЛЬНЫМ
        // сдвигом от свежего края (иначе 3 одинаковых части → один и тот же файл).
        let docs = vec![doc(12, 500), doc(11, 500), doc(10, 500)];

        assert_eq!(pick_document_by_size(&docs, 500, 0).unwrap()["file_id"], 12);
        assert_eq!(pick_document_by_size(&docs, 500, 1).unwrap()["file_id"], 11);
        assert_eq!(pick_document_by_size(&docs, 500, 2).unwrap()["file_id"], 10);
        assert!(pick_document_by_size(&docs, 500, 3).is_none());
    }

    #[test]
    fn pick_document_by_size_skips_foreign_sizes() {
        // В PM попадаются чужие документы (другие файлы) — они не должны сбивать
        // ни выбор по размеру, ни счётчик `skip` (он считает ТОЛЬКО свои части).
        let docs = vec![doc(99, 777), doc(12, 500), doc(98, 555), doc(11, 500)];

        assert_eq!(pick_document_by_size(&docs, 500, 0).unwrap()["file_id"], 12);
        assert_eq!(pick_document_by_size(&docs, 500, 1).unwrap()["file_id"], 11);
        assert_eq!(pick_document_by_size(&docs, 777, 0).unwrap()["file_id"], 99);
    }

    #[test]
    fn pick_document_by_size_zero_means_any_document_by_position() {
        // Размер части неизвестен (expected_size пуст): выбираем по позиции.
        let docs = vec![doc(12, 1), doc(11, 2), doc(10, 3)];

        assert_eq!(pick_document_by_size(&docs, 0, 0).unwrap()["file_id"], 12);
        assert_eq!(pick_document_by_size(&docs, 0, 2).unwrap()["file_id"], 10);
        assert!(pick_document_by_size(&docs, 0, 3).is_none());
    }

    #[test]
    fn pick_document_by_size_missing_size_is_none() {
        let docs = vec![doc(12, 300), doc(11, 200)];
        assert!(pick_document_by_size(&docs, 100, 0).is_none());
    }

    // ── BUG-DOWNLOAD-052: точный матч части по unique_id + TDLib-сдвиг id ────
    //
    // Live 2026-09-26 (files.id=38, 3 части): part0 и part1 имеют ОДИНАКОВЫЙ
    // размер (2 093 796 556 Б), а в окне последних сообщений PM лежат и чужие
    // документы (свои upload-сообщения клиента 20 МБ). Матч «size+skip»
    // промахнулся («в истории PM нет документа части»), а `getMessage` по
    // bot-side id (577) не нашёл сообщение: клиентский TDLib видит message.id
    // как `real << 20` (в логе `updateMessageSendSucceeded sent_message_id=
    // 613416960` = 585 << 20). Правильный ключ — `remote.unique_id` документа.

    fn doc_u(file_id: i32, size: u64, unique_id: &str) -> Value {
        json!({
            "file_id": file_id,
            "size": size,
            "file_name": "",
            "unique_id": unique_id,
        })
    }

    #[test]
    fn doc_info_from_message_extracts_unique_id() {
        let msg = json!({
            "@type": "message",
            "id": 1,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "@type": "document",
                    "file_name": "32_0.part",
                    "document": {
                        "@type": "file",
                        "id": 707,
                        "size": 2093796556,
                        "remote": { "id": "BQACAgIAAxkD", "unique_id": "AgAD8KcAAkAKuEk" }
                    }
                }
            }
        });
        let info = doc_info_from_message(&msg).expect("документ должен извлечься");
        assert_eq!(info["unique_id"], "AgAD8KcAAkAKuEk");
        assert_eq!(info["size"], 2093796556i64);
        // Нет миниатюры в фикстуре — поля обязаны быть (0), а не отсутствовать:
        // иначе клиент SP-15 не отличит «нет thumb» от «движок старый».
        assert_eq!(info["thumb_file_id"], 0);
        assert_eq!(info["thumb_size"], 0);
    }

    /// SP-15 срез 5 (D-071): миниатюра документа — отдельный файл (`thumbnail.file`),
    /// и её `id`/размер обязаны приезжать клиенту вместе с оригиналом: галерея
    /// карточки грузит thumb СВОИМ TDLib, а оригинал — лениво при зумe.
    #[test]
    fn doc_info_from_message_extracts_thumbnail_file() {
        let msg = json!({
            "@type": "message",
            "id": 5,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "@type": "document",
                    "file_name": "IMG_0042.jpg",
                    "document": {
                        "@type": "file",
                        "id": 900,
                        "size": 26_214_400,
                        "remote": { "id": "BQACAgIAAxkD", "unique_id": "ORIG_UNIQUE" }
                    },
                    "thumbnail": {
                        "@type": "thumbnail",
                        "format": { "@type": "thumbnailFormatJpeg" },
                        "width": 320,
                        "height": 240,
                        "file": {
                            "@type": "file",
                            "id": 901,
                            "size": 12_345,
                            "remote": { "id": "BQACAgIAAxkE", "unique_id": "THUMB_UNIQUE" }
                        }
                    }
                }
            }
        });
        let info = doc_info_from_message(&msg).expect("документ должен извлечься");
        assert_eq!(info["file_id"], 900);
        assert_eq!(info["thumb_file_id"], 901);
        assert_eq!(info["thumb_size"], 12_345);
        assert_eq!(info["thumb_unique_id"], "THUMB_UNIQUE");
        assert_eq!(info["unique_id"], "ORIG_UNIQUE");
    }

    #[test]
    fn pick_document_by_unique_id_distinguishes_equal_sizes() {
        // Доставка (новые первыми): p2 (уникальный размер), p1, p0 (равные размеры).
        let docs = vec![
            doc_u(12, 763_977_048, "UNIQ_2"),
            doc_u(11, 2_093_796_556, "UNIQ_1"),
            doc_u(10, 2_093_796_556, "UNIQ_0"),
        ];

        assert_eq!(
            pick_document_by_unique_id(&docs, "UNIQ_0").unwrap()["file_id"],
            10
        );
        assert_eq!(
            pick_document_by_unique_id(&docs, "UNIQ_1").unwrap()["file_id"],
            11
        );
        assert!(pick_document_by_unique_id(&docs, "").is_none());
        assert!(pick_document_by_unique_id(&docs, "MISSING").is_none());
    }

    #[test]
    fn pick_document_by_unique_id_finds_part_beyond_foreign_documents() {
        // Чужие документы (свои upload-сообщения клиента) НЕ мешают: часть ищется
        // по unique_id, а не по позиции в окне.
        let docs = vec![
            doc_u(101, 20_971_520, "FOREIGN_1"),
            doc_u(102, 20_971_520, "FOREIGN_2"),
            doc_u(103, 504_740_378, "FOREIGN_3"),
            doc_u(10, 2_093_796_556, "UNIQ_0"),
        ];

        assert_eq!(
            pick_document_by_unique_id(&docs, "UNIQ_0").unwrap()["file_id"],
            10
        );
    }

    #[test]
    fn doc_matches_part_prefers_unique_id_over_size() {
        // Равные размеры: уникальный ключ части решает (иначе вернули бы чужую).
        let part0 = doc_u(10, 2_093_796_556, "UNIQ_0");
        let part1 = doc_u(11, 2_093_796_556, "UNIQ_1");

        assert!(doc_matches_part(&part0, 2_093_796_556, Some("UNIQ_0")));
        assert!(!doc_matches_part(&part1, 2_093_796_556, Some("UNIQ_0")));
    }

    #[test]
    fn doc_matches_part_falls_back_to_size_without_unique_id() {
        let legacy = doc(10, 100);
        // unique у части неизвестен → решаем по размеру (fail-open).
        assert!(doc_matches_part(&legacy, 100, None));
        assert!(doc_matches_part(&doc(10, 0), 100, None));
        assert!(doc_matches_part(&doc(10, 100), 0, None));
        assert!(!doc_matches_part(&doc(10, 200), 100, None));
        assert!(!doc_matches_part(&doc(0, 100), 100, None));
    }

    #[test]
    fn shifted_message_id_candidates_covers_bot_and_tdlib_ids() {
        // BUG-DOWNLOAD-052: bot-side 577 у клиента = 577 << 20 = 605028352.
        let cands = shifted_message_id_candidates(577);
        assert_eq!(cands[0], 577);
        assert!(cands.contains(&(577i64 << 20)));

        // Уже сдвинутый клиентский id: возвращаем и «реальный» вариант.
        let shifted = shifted_message_id_candidates(577i64 << 20);
        assert!(shifted.contains(&(577i64 << 20)));
        assert!(shifted.contains(&577));

        // Нулевой/отрицательный id — только он сам (getMessage всё равно упадёт).
        assert_eq!(shifted_message_id_candidates(0), vec![0]);
    }

    #[test]
    fn update_file_progress_then_complete_and_move() {
        init();
        // Создаём реальный «скачанный» файл TDLib-кеша и реестр-запись.
        let dir = std::env::temp_dir().join("engine-core-dl-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let cached = dir.join("cached.bin");
        std::fs::write(&cached, b"DOWNLOADED-DATA-123").unwrap();
        let target = dir.join("out.bin");

        {
            let mut reg = global_registry().lock().unwrap();
            reg.insert(
                42,
                DownloadEntry {
                    file_id: 42,
                    target_path: Some(target.to_string_lossy().to_string()),
                    total: 0,
                    downloaded: 0,
                    completed: false,
                    cancelled: false,
                    error: None,
                    file_name: None,
                    remote_id: None,
                    completed_at: None,
                    last_emit: None,
                    last_emit_percent: 0,
                    last_rca: None,
                },
            );
        }

        // updateFile (прогресс)
        let prog = json!({
            "@type": "updateFile",
            "file": {
                "id": 42,
                "size": 18,
                "local": {
                    "is_downloading_active": true,
                    "is_downloading_completed": false,
                    "downloaded_size": 9,
                    "path": cached.to_string_lossy().to_string()
                }
            }
        });
        assert!(on_update_file(&prog), "прогресс обработан");

        // updateFile (завершение) → файл перемещён в target
        let done = json!({
            "@type": "updateFile",
            "file": {
                "id": 42,
                "size": 18,
                "local": {
                    "is_downloading_active": false,
                    "is_downloading_completed": true,
                    "downloaded_size": 18,
                    "path": cached.to_string_lossy().to_string()
                }
            }
        });
        assert!(on_update_file(&done), "завершение обработано");

        let reg = global_registry().lock().unwrap();
        let e = reg.get(&42).expect("entry");
        assert!(e.completed, "entry должен быть completed");
        assert!(e.error.is_none(), "без ошибки: {:?}", e.error);
        drop(reg);
        assert!(target.exists(), "файл должен быть перемещён в target");
        let content = std::fs::read(&target).unwrap();
        assert_eq!(content, b"DOWNLOADED-DATA-123");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_file_update_ignored() {
        init();
        let bogus = json!({"@type": "updateFile", "file": {"id": 999, "local": {}}});
        assert!(!on_update_file(&bogus), "неизвестный file_id игнорируется");
    }

    // ── T0 (owner-backdoor download): резолв delivery-документа в PM ────────
    //
    // Root cause бага «путь выбирается, и на этом ломается»: у бота и клиента
    // в PM РАЗНЫЕ message_id (см. host_ingest.py), поэтому getMessage по
    // bot-side delivery_message_id даёт Not Found. Mainline (Tauri) на промах
    // идёт в историю чата (_resolve_latest_document_in_chat), Electron-порт эту
    // ветку потерял. Ниже — чистая логика, покрываемая тестами до реализации.

    fn _message_with_document(file_id: i64, name: &str, size: i64) -> Value {
        json!({
            "@type": "message",
            "id": 126877696,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "@type": "document",
                    "file_name": name,
                    "document": {
                        "@type": "file",
                        "id": file_id,
                        "size": size,
                        "remote": {"id": "BQACAgIAAxkDAAN4"}
                    }
                }
            }
        })
    }

    #[test]
    fn doc_info_from_document_message_extracts_fields() {
        let msg = _message_with_document(1240, "TCL_55P615.bin", 20971520);
        let info = doc_info_from_message(&msg).expect("документ должен извлечься");
        assert_eq!(info["file_id"], 1240);
        assert_eq!(info["file_name"], "TCL_55P615.bin");
        assert_eq!(info["size"], 20971520);
    }

    #[test]
    fn doc_info_from_error_is_none() {
        // «Message not found» из-за расхождения message_id бот/клиент.
        let err = json!({"@type": "error", "code": 400, "message": "Message not found"});
        assert!(doc_info_from_message(&err).is_none());
    }

    #[test]
    fn doc_info_from_message_without_document_is_none() {
        let msg = json!({
            "@type": "message",
            "id": 1,
            "content": {"@type": "messageText", "text": {"text": "hi"}}
        });
        assert!(doc_info_from_message(&msg).is_none());
    }

    #[test]
    fn should_fallback_true_on_get_message_miss() {
        // error → промах (id-пространство бот/клиент).
        assert!(should_fallback_to_history(
            &json!({"@type": "error", "code": 400, "message": "Message not found"})
        ));
        // message без документа → тоже мимо цели.
        assert!(should_fallback_to_history(
            &json!({"@type": "message", "content": {"@type": "messageText"}})
        ));
    }

    #[test]
    fn should_fallback_false_when_document_present_or_unexpected() {
        // Документ найден — fallback не нужен.
        assert!(!should_fallback_to_history(&_message_with_document(7, "f.bin", 10)));
        // Неожиданный @type — это настоящая ошибка, не повод идти в историю.
        assert!(!should_fallback_to_history(&json!({"@type": "ok"})));
    }

    // ── BUG-DOWNLOAD-052 (live 2026-09-26): точка отсчёта окна истории ───────
    //
    // Симптом: пер-частовый PM-резолв в клиенте падал с «документов в окне=0»,
    // хотя документы доставки в чате есть. Причина (снята живым замером TDLib
    // сессии клиента): `getChatHistory(from_message_id=0)` отдаёт РОВНО ОДНО
    // сообщение (последнее), а не срез от конца ленты. Правильная точка отсчёта —
    // `getChat.last_message.id`.

    /// Сообщение-текст TDLib (в окне истории много служебных текстов).
    fn text_message(id: i64) -> Value {
        json!({
            "@type": "message",
            "id": id,
            "date": 1,
            "content": {"@type": "messageText", "text": {"text": "ok"}}
        })
    }

    /// Сообщение-документ TDLib с `remote.unique_id` (пер-частовый ключ).
    fn document_message(id: i64, file_id: i64, unique: &str, size: i64) -> Value {
        json!({
            "@type": "message",
            "id": id,
            "date": 2,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "@type": "document",
                    "file_name": "part.bin",
                    "document": {
                        "@type": "file",
                        "id": file_id,
                        "size": size,
                        "remote": {"id": "BQACAgIAAxkDAAN4", "unique_id": unique}
                    }
                }
            }
        })
    }

    /// Симулятор живой клиентской TDLib (замер 2026-09-26):
    /// * `getChat` → `last_message.id`;
    /// * `getChatHistory(from=0)` → серверный последний срез (warm-up): в свежей
    ///   сессии он может отдать ОДНО сообщение, пока лента не догружена — поэтому
    ///   параметризуем (`warm_page`);
    /// * `getChatHistory(from=last)` → полноценное окно (новые первыми).
    ///
    /// `calls` собирает пары (метод, from_message_id) для проверки контракта.
    fn live_tdlib_sim<'a>(
        calls: &'a mut Vec<(String, i64)>,
        last_id: i64,
        window_from_last: Vec<Value>,
    ) -> impl FnMut(Value) -> Result<Value, String> + 'a {
        live_tdlib_sim_with_warm(calls, last_id, window_from_last, None)
    }

    /// Как [`live_tdlib_sim`], но с отдельным ответом на `from_message_id=0`
    /// (`warm_page`): модель «свежая доставка видна только серверному срезу».
    fn live_tdlib_sim_with_warm<'a>(
        calls: &'a mut Vec<(String, i64)>,
        last_id: i64,
        window_from_last: Vec<Value>,
        warm_page: Option<Vec<Value>>,
    ) -> impl FnMut(Value) -> Result<Value, String> + 'a {
        move |req: Value| {
            let kind = req["@type"].as_str().unwrap_or("").to_string();
            let from = req["from_message_id"].as_i64().unwrap_or(-1);
            calls.push((kind.clone(), from));
            match kind.as_str() {
                "getChat" => Ok(json!({
                    "@type": "chat",
                    "id": 8898752180i64,
                    "last_message": {"id": last_id}
                })),
                "getChatHistory" => {
                    let messages = if from == 0 {
                        match &warm_page {
                            Some(page) => page.clone(),
                            None => window_from_last.clone(),
                        }
                    } else {
                        window_from_last.clone()
                    };
                    Ok(json!({"@type": "messages", "messages": messages}))
                }
                other => Err(format!("неожиданный запрос: {other}")),
            }
        }
    }


    #[test]
    fn history_window_starts_from_last_message_not_zero() {
        // Окно: сверху текст, ниже — обе части доставки (часть 1 свежее части 0).
        let window = vec![
            text_message(24 << 20),
            document_message(23 << 20, 1238, "AgAD-acAAkAKuEk", 2093796556),
            document_message(22 << 20, 1239, "AgAD8KcAAkAKuEk", 2093796556),
        ];
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = live_tdlib_sim(&mut calls, 24 << 20, window);

        let docs = chat_documents_with(&mut call, 8898752180, 24).expect("окно истории");
        assert_eq!(docs.len(), 2, "документы доставки должны попасть в окно");
        drop(call); // освобождаем заимствование `calls` для проверки контракта

        // Контракт: окно строится от last_message.id (плюс warm-срез от 0).
        let history_calls: Vec<i64> = calls
            .iter()
            .filter(|(k, _)| k == "getChatHistory")
            .map(|(_, from)| *from)
            .collect();
        assert!(history_calls.contains(&(24 << 20)), "срез от last_message.id: {history_calls:?}");
        assert!(history_calls.contains(&0), "warm-срез от 0: {history_calls:?}");
    }

    #[test]
    fn resolve_part_by_unique_id_uses_full_window() {
        // РЕПРО БАГА: при from_message_id=0 окно = 1 текстовое сообщение →
        // документ части не находится («документов в окне=0»);
        // после фикса (from=last_message.id) обе части резолвятся по unique_id
        // даже при РАВНЫХ размерах (files.id=38).
        let window = vec![
            text_message(24 << 20),
            document_message(23 << 20, 1238, "AgAD-acAAkAKuEk", 2093796556),
            document_message(22 << 20, 1239, "AgAD8KcAAkAKuEk", 2093796556),
        ];
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = live_tdlib_sim(&mut calls, 24 << 20, window);

        let part1 = resolve_document_in_chat_with(
            &mut call, 8898752180, Some("AgAD-acAAkAKuEk"), 2093796556, 0,
        )
        .expect("часть 1 должна резолвиться по unique_id");
        assert_eq!(part1["file_id"], 1238);

        let part0 = resolve_document_in_chat_with(
            &mut call, 8898752180, Some("AgAD8KcAAkAKuEk"), 2093796556, 0,
        )
        .expect("часть 0 должна резолвиться по unique_id (равные размеры)");
        assert_eq!(part0["file_id"], 1239);
    }

    #[test]
    fn resolve_part_expands_window_when_part_lies_deeper() {
        // Переиспользованный lease: доставка сделана в начале 24-часового окна,
        // PM-лента выросла → часть глубже базового окна (24). Резолв обязан
        // повторить срез на максимальном окне (100), а не падать.
        let mut calls: Vec<(String, i64)> = Vec::new();
        let deep_doc = document_message(5 << 20, 1241, "DEEP1", 2093796556);
        let mut call = |req: Value| -> Result<Value, String> {
            let kind = req["@type"].as_str().unwrap_or("").to_string();
            let limit = req["limit"].as_i64().unwrap_or(0);
            calls.push((kind.clone(), limit));
            match kind.as_str() {
                "getChat" => Ok(json!({"@type": "chat", "last_message": {"id": 24 << 20}})),
                "getChatHistory" if limit >= 100 => Ok(json!({
                    "@type": "messages",
                    "messages": [text_message(24 << 20), deep_doc]
                })),
                "getChatHistory" => Ok(json!({
                    "@type": "messages",
                    "messages": [text_message(24 << 20)]
                })),
                other => Err(format!("неожиданный запрос: {other}")),
            }
        };

        let doc = resolve_document_in_chat_with(&mut call, 8898752180, Some("DEEP1"), 2093796556, 0)
            .expect("часть должна найтись в расширенном окне");
        assert_eq!(doc["file_id"], 1241);
        drop(call);

        let limits: Vec<i64> = calls
            .iter()
            .filter(|(k, _)| k == "getChatHistory")
            .map(|(_, l)| *l)
            .collect();
        assert!(limits.contains(&100), "должно быть расширенное окно 100: {limits:?}");
    }

    #[test]
    fn window_ladder_expands_only_when_needed() {
        assert_eq!(pm_history_window_ladder(0), vec![24, 100]);
        assert_eq!(pm_history_window_ladder(3), vec![24, 100]);
        // skip + 8 > 24 — базовое окно растёт, максимум не дублируется.
        assert_eq!(pm_history_window_ladder(30), vec![38, 100]);
        // Сверхбольшой skip — только выросшее базовое окно.
        assert_eq!(pm_history_window_ladder(200), vec![208]);
    }

    #[test]
    fn resolve_latest_document_expands_window_when_top_has_no_docs() {
        // После owner-доставки в PM пришли посторонние сообщения: в базовом окне
        // документов нет, документ доставки — глубже. Лестница обязана дойти до 100.
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = |req: Value| -> Result<Value, String> {
            let kind = req["@type"].as_str().unwrap_or("").to_string();
            let limit = req["limit"].as_i64().unwrap_or(0);
            calls.push((kind.clone(), limit));
            match kind.as_str() {
                "getChat" => Ok(json!({"@type": "chat", "last_message": {"id": 30 << 20}})),
                "getChatHistory" if limit >= 100 => Ok(json!({
                    "@type": "messages",
                    "messages": [
                        text_message(30 << 20),
                        document_message(5 << 20, 1301, "OWNER1", 4096)
                    ]
                })),
                "getChatHistory" => Ok(json!({
                    "@type": "messages",
                    "messages": [text_message(30 << 20), text_message(29 << 20)]
                })),
                other => Err(format!("неожиданный запрос: {other}")),
            }
        };

        let doc = resolve_latest_document_in_chat_with(&mut call, 8898752180)
            .expect("документ доставки должен найтись в расширенном окне");
        assert_eq!(doc["file_id"], 1301);
        drop(call);

        let limits: Vec<i64> = calls
            .iter()
            .filter(|(k, _)| k == "getChatHistory")
            .map(|(_, l)| *l)
            .collect();
        assert!(limits.contains(&100), "должно быть расширенное окно 100: {limits:?}");
    }

    #[test]
    fn warm_server_page_brings_fresh_delivery_missing_from_local_tail() {
        // Live 2026-09-26 (owner-multi): доставка создана сервером секунду назад —
        // локальный `last_message` и срез от него её НЕ содержат (в клиентской БД
        // её ещё нет), но серверный срез (`from_message_id=0`) её отдаёт.
        // Объединённое окно обязано найти часть.
        let fresh = vec![
            document_message(40 << 20, 2001, "FRESH1", 1314464227),
            text_message(39 << 20),
        ];
        let local_tail = vec![
            text_message(30 << 20),
            document_message(20 << 20, 1900, "OLD", 10),
        ];
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = live_tdlib_sim_with_warm(&mut calls, 30 << 20, local_tail, Some(fresh));

        let doc = resolve_document_in_chat_with(
            &mut call, 8898752180, Some("FRESH1"), 1314464227, 0,
        )
        .expect("свежая часть должна найтись через серверный warm-срез");
        assert_eq!(doc["file_id"], 2001);
    }

    #[test]
    fn merge_history_pages_dedups_by_id_and_sorts_desc() {
        let merged = merge_history_pages(vec![
            vec![text_message(10), document_message(30, 1, "A", 1)],
            vec![text_message(10), text_message(20)],
        ]);
        assert_eq!(merged.len(), 3, "дубликат id=10 отброшен");
        let ids: Vec<i64> = merged.iter().map(|m| m["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![30, 20, 10], "новые первыми");
    }

    #[test]
    fn resolve_latest_document_uses_full_window() {
        // Owner-backdoor путь: самый свежий документ должен браться из полного
        // окна, а не из единственного сообщения среза from_message_id=0.
        let window = vec![
            text_message(24 << 20),
            document_message(22 << 20, 1241, "AgADYagAAkAKuEk", 20971520),
        ];
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = live_tdlib_sim(&mut calls, 24 << 20, window);

        let doc = resolve_latest_document_in_chat_with(&mut call, 8898752180)
            .expect("самый свежий документ из истории PM");
        assert_eq!(doc["file_id"], 1241);
        assert_eq!(doc["unique_id"], "AgADYagAAkAKuEk");
    }

    #[test]
    fn empty_last_message_slice_falls_back_to_zero_start() {
        // Если срез по last_message.id пуст — пробуем прежний контракт (from=0).
        let mut calls: Vec<(String, i64)> = Vec::new();
        let mut call = |req: Value| -> Result<Value, String> {
            let kind = req["@type"].as_str().unwrap_or("").to_string();
            let from = req["from_message_id"].as_i64().unwrap_or(-1);
            calls.push((kind.clone(), from));
            match kind.as_str() {
                "getChat" => Ok(json!({"@type": "chat", "last_message": {"id": 999}})),
                "getChatHistory" if from == 0 => Ok(json!({
                    "@type": "messages",
                    "messages": [document_message(1, 77, "UNIQ1", 10)]
                })),
                "getChatHistory" => Ok(json!({"@type": "messages", "messages": []})),
                other => Err(format!("неожиданный запрос: {other}")),
            }
        };

        let docs = chat_documents_with(&mut call, 8898752180, 24).expect("fallback на from=0");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["file_id"], 77);
        drop(call);
        // Срезы: warm-страницы от 0 + хвост от last_message.id.
        let froms: Vec<i64> = calls
            .iter()
            .filter(|(k, _)| k == "getChatHistory")
            .map(|(_, from)| *from)
            .collect();
        assert!(froms.contains(&999), "срез по last_message.id: {froms:?}");
        assert!(froms.iter().filter(|f| **f == 0).count() >= 1, "срезы from=0: {froms:?}");
    }

    #[test]
    fn last_message_id_from_chat_parses_and_ignores_garbage() {
        assert_eq!(
            last_message_id_from_chat(&json!({"last_message": {"id": 42}})),
            Some(42)
        );
        assert_eq!(last_message_id_from_chat(&json!({"last_message": {"id": 0}})), None);
        assert_eq!(
            last_message_id_from_chat(&json!({"@type": "error", "code": 400})),
            None
        );
    }

    /// BUG-RCA-SPAM-002: финальный `updateFile` завершённой загрузки (и то же
    /// событие по «зеркальному» file_id с тем же `remote.id`) upload'у не
    /// принадлежит — иначе он оседал в `pending_updates`.
    #[test]
    fn completed_download_ttl_matches_file_id_and_remote() {
        let file_id = 910_001;
        assert!(
            !is_recently_completed_download(file_id),
            "неизвестный file_id не считается нашим"
        );

        register_test_download(file_id);
        assert!(
            !is_recently_completed_download(file_id),
            "активная загрузка — ещё не завершена (иначе погасили бы её прогресс)"
        );

        complete_test_download(file_id, "REMOTE-DL-910001");
        assert!(
            is_recently_completed_download(file_id),
            "финальный updateFile завершённой загрузки — наш (TTL)"
        );
        assert!(
            is_recently_completed_remote("REMOTE-DL-910001"),
            "«зеркальный» file_id того же remote-файла — наш (TTL)"
        );
        assert!(!is_recently_completed_remote("REMOTE-DL-910002"));
        // Пустой remote.id не матчится ни с чем (fail-closed для чужих событий).
        assert!(!is_recently_completed_remote(""));

        unregister_test_download(file_id);
        assert!(!is_recently_completed_download(file_id));
        assert!(
            !is_recently_completed_remote("REMOTE-DL-910001"),
            "запись снята — TTL-метка по remote тоже мертва"
        );
    }
}
