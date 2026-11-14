//! M4a4 — upload через TDLib JSON FFI (shared runtime, без Tauri).
//!
//! Модель mainline [`tdlib_upload.rs`](../../desktop/src-tauri/src/tdlib_upload.rs)
//! (двухфазная), реализованная синхронно поверх `TdlibRuntime::send_and_wait`:
//!
//!   Фаза 1: `preliminaryUploadFile{inputFileLocal(path), fileTypeDocument, priority=1}`
//!           → TDLib-`file` (id + remote.id); прогресс — `updateFile` (поток receive);
//!           ждём `remote.is_uploading_completed == true`.
//!   Фаза 2: `sendMessage{inputMessageDocument{inputDocument{inputFileRemote{id}}}}`
//!           → `message`; из него берём `tg_file_id` (remote.id документа),
//!           `tg_file_unique_id` (remote.unique_id) и `message_id`.
//!
//! Caption = `upload_id:<server_upload_id>` (mainline BUG-UPLOAD-013: host-ingest
//! маршрутизирует входящий документ строго по серверному upload_id).
//! Топик форума: `topic_id{messageTopicForum{forum_topic_id}}` (BUG-TDLIB-014).
//!
//! Контракт UI (UploadPage): `tdlib_start_upload` → `upload_id`;
//! `tdlib-upload-progress` события; `tdlib_wait_upload` →
//! `{tg_file_id, tg_file_unique_id, message_id}`; `tdlib_cancel_upload`.
//! Multi-part (>2GB) — `start_multi` (см. ниже), контракт `tdlib-multi-upload-*`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tdlib_runtime::TdlibRuntime;

/// Общий таймаут upload (mainline `UPLOAD_TIMEOUT_SECS`).
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(7200);
/// Таймаут sendMessage (mainline `SEND_MSG_TIMEOUT_SECS`).
const SEND_MSG_TIMEOUT: Duration = Duration::from_secs(120);
/// Не чаще 1 события прогресса в 200мс (mainline `EMIT_INTERVAL_SECS`).
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

// ── stdout-кадры (события прогресса) ─────────────────────────────────────────

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

/// Уникальный суффикс (`@extra`/upload_id) без внешних крейтов.
fn uid(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}{nanos:x}")
}

// ── Состояние одного upload'а ────────────────────────────────────────────────

pub struct UploadState {
    pub upload_id: String,
    pub file_path: String,
    pub chat_id: i64,
    pub message_thread_id: Option<i64>,
    pub session_upload_id: Option<String>,
    /// Явное имя документа в Telegram (для multi-частей — с `[slice:off:size]`).
    /// `None` → имя выводится из пути (single-upload). BUG-UPLOAD-023.
    pub doc_name: Option<String>,
    /// Мульти-контекст: (part_index, total_parts, total_size, completed_before).
    pub multi: Option<(usize, usize, u64, u64)>,
    pub file_id: i32,
    pub remote_id: String,
    /// `message_id` из ПРЯМОГО ответа `sendMessage` (предварительный id).
    ///
    /// Нужен для Priority-1 матчинга `updateMessageSendSucceeded` (mainline
    /// BUG-TDLIB-021): TDLib создаёт для отправленного сообщения НОВЫЙ
    /// file-object, которого нет в `file_index`, поэтому матч по file_id
    /// не срабатывает.
    pub sent_message_id: Option<i64>,
    pub bytes_uploaded: u64,
    pub total: u64,
    pub upload_completed: bool,
    pub cancelled: bool,
    pub done: bool,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub last_emit: Option<Instant>,
    pub last_bytes: u64,
    pub last_ts: Option<Instant>,
    pub speed: u64,
}

type Shared = Arc<(Mutex<UploadState>, Condvar)>;

fn registry() -> &'static Mutex<HashMap<String, Shared>> {
    static REG: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_index() -> &'static Mutex<HashMap<i32, String>> {
    static IDX: OnceLock<Mutex<HashMap<i32, String>>> = OnceLock::new();
    IDX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Буфер updateFile для file_id, которых ещё нет в file_index (race condition:
/// TDLib эмитит updateFile ДО ответа на preliminaryUploadFile).
/// Ключ = file_id, значение = список "сырых" updateFile в порядке поступления.
fn pending_updates() -> &'static Mutex<HashMap<i32, Vec<Value>>> {
    static PENDING: OnceLock<Mutex<HashMap<i32, Vec<Value>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Только для тестов: сколько `updateFile` накоплено в pending-буфере по file_id.
#[cfg(test)]
pub(crate) fn pending_len_for_test(file_id: i32) -> usize {
    pending_updates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .map(|v| v.len())
        .unwrap_or(0)
}

/// Предел pending-буфера на один file_id (CAPA к утечке, BUG-RCA-SPAM-001).
///
/// Буфер существует только на время между `updateFile` и ответом
/// `preliminaryUploadFile` (доли секунды), а события несут КУМУЛЯТИВНЫЙ
/// `uploaded_size` — терять старые безопасно (актуален последний).
const PENDING_UPDATES_MAX: usize = 512;

/// Файл принадлежит активной ЗАГРУЗКЕ (single download или часть multi) —
/// его `updateFile` обрабатывают `download`/`parts_download`, а не upload.
///
/// BUG-RCA-SPAM-002 (live 2026-09-28, e2e-prod32): одной проверки «активна» мало.
/// TDLib шлёт по одному и тому же remote-файлу события сразу на НЕСКОЛЬКО своих
/// `file.id` (наша загрузка + копия документа доставки в другом чате), причём
/// ФИНАЛЬНЫЙ `updateFile` приходит уже ПОСЛЕ завершения — когда и запись части
/// снята, и загрузка помечена завершённой. Поэтому к «активной» проверке
/// добавлены TTL-метки недавно завершённых (по `file_id` и по `remote.id`).
fn is_foreign_download(file_id: i32, remote_id: &str) -> bool {
    if file_id <= 0 {
        return false;
    }
    crate::download::is_active_download(file_id)
        || crate::download::is_active_download_remote(remote_id)
        || crate::download::is_recently_completed_download(file_id)
        || crate::download::is_recently_completed_remote(remote_id)
        || crate::parts_download::is_active_part_download(file_id)
        || crate::parts_download::is_active_part_download_remote(remote_id)
        || crate::parts_download::is_recently_completed_part(file_id)
        || crate::parts_download::is_recently_completed_part_remote(remote_id)
}

/// Печатать ли диагностику `updateFile COMPLETED` в receive-loop.
///
/// `remote.is_uploading_completed` у СКАЧИВАЕМОГО файла всегда `true` (он уже
/// загружен на сервер), поэтому одного флага мало: для файлов активных загрузок
/// диагностику глушим — иначе строка на каждые 512 КБ прогресса (live
/// e2e-prod32: 5714 строк / 2.4 МБ на две загрузки, BUG-RCA-SPAM-001). Остаток —
/// финальные события после завершения и «зеркальные» file_id — закрыт TTL-метками
/// (BUG-RCA-SPAM-002).
pub fn should_log_completed_update(file_id: i32, remote_id: &str) -> bool {
    !is_foreign_download(file_id, remote_id)
}

/// Ожидания `updateMessageSendSucceeded` (upload_id → Sender<Value>).
///
/// Аналог Tauri `handle_send_succeeded`: прямой ответ `sendMessage` несёт
/// **промежуточный** `message_id` (и может не несть `remote.id` документа);
/// реальные `message_id`/`tg_file_id` приходят позже в
/// `updateMessageSendSucceeded`. Без этого шага UI получал бы message_id=0 →
/// не делал self-delete PM и отправлял в `/complete` битый telegram_message_id,
/// из-за чего запись в БД (File/PersonalFile) не создавалась.
fn pending_sends() -> &'static Mutex<HashMap<String, mpsc::Sender<Value>>> {
    static SENDS: OnceLock<Mutex<HashMap<String, mpsc::Sender<Value>>>> = OnceLock::new();
    SENDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Достать объект `message` из значения: для `updateMessageSendSucceeded` это
/// `val["message"]`, для прямого ответа `sendMessage` — сам `val`.
fn message_of(val: &Value) -> &Value {
    if val["@type"].as_str() == Some("updateMessageSendSucceeded") {
        &val["message"]
    } else {
        val
    }
}

/// Сброс реестра (при `tdlib_reset_auth`): старые upload_id невалидны.
pub fn reset() {
    registry().lock().unwrap_or_else(|e| e.into_inner()).clear();
    file_index().lock().unwrap_or_else(|e| e.into_inner()).clear();
    pending_updates().lock().unwrap_or_else(|e| e.into_inner()).clear();
    pending_sends().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Применить накопленные pending-update'ы к только что зарегистрированному upload'у.
/// Вызывается после вставки в file_index.
#[cfg(test)]
pub(crate) fn apply_pending_for(file_id: i32, upload_id: &str) {
    apply_pending_for_inner(file_id, upload_id)
}

#[cfg(not(test))]
fn apply_pending_for(file_id: i32, upload_id: &str) {
    apply_pending_for_inner(file_id, upload_id)
}

fn apply_pending_for_inner(file_id: i32, upload_id: &str) {
    let pending = match pending_updates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&file_id)
    {
        Some(v) => v,
        None => return,
    };
    if pending.is_empty() {
        return;
    }
    let shared = match registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(upload_id)
        .cloned()
    {
        Some(s) => s,
        None => return,
    };
    eprintln!(
        "engine-core[upload]: applying {} pending update(s) for file_id={file_id} (upload_id={upload_id})",
        pending.len()
    );
    for val in pending {
        apply_update_to_shared(&val, file_id, &shared);
    }
}

/// Имя файла для документа (basename).
fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "firmware.bin".to_string())
}

/// Payload поля `document` для `inputMessageDocument` — обёртка `inputDocument`
/// над `inputFileId` (файл, уже загруженный на сервер на фазе 1).
///
/// BUG-TDLIB-013 (`InputFile is not specified`, `FileManager::get_input_file_id`
/// в `FileManager.cpp:4195`): TDLib требует, чтобы `inputDocument.document`
/// разворачивался в конкретный непустой `InputFile`. Пустая строка (раньше:
/// `document:""` для ia32 stock 1.8.61 без `inputDocument`) и `inputFileLocal`
/// с уже «consumed» path (docs/TDLIB_UPLOAD_WORKFLOW.md §5) → `nullptr`
/// `InputFile` → `InputFile is not specified`.
///
/// Решение — каноничное для TDLib 1.8.65+ (docs §5/§6/чек-лист 622): после
/// `preliminaryUploadFile` файл живёт в локальном кэше TDLib под
/// `file_id` = `updateFile.file.id` (int32). Фаза 2 шлёт `inputFileId{id}`
/// внутри обёртки `inputDocument` — TDLib резолвит его к закэшированному файлу
/// БЕЗ повторной передачи данных. `inputFileRemote` здесь НЕ подходит: на
/// форке master `file.remote.id` может отсутствовать в ответе `sendMessage`
/// (docs §5: `inputFileRemote -> file.remote.id absent in 1.8.65 master`).
///
/// `disable_content_type_detection` и `thumbnail` — поля `inputMessageDocument`
/// (см. `send_message_request`), а не `inputDocument`: в `inputDocument` они
/// неизвестны и не попадают в `document` (иначе — `Unknown class`/`400`).
///
/// Схема обёртки едина для ia32/x64: оба бандла — форк 1.8.65 (schema-parity
/// gate `tests_pm/test_tdlib_bundle_schema.py`). Рантайм-проба
/// `probe_document_schema` устранена — она была только для ia32 stock 1.8.61
/// без `inputDocument` (BUG-RELEASE-SCHEMA-001).
fn document_value(file_id: i32, file_path: &str, mime: Option<&str>) -> Value {
    document_value_named(file_id, &file_name_of(file_path), mime)
}

/// То же, но с ЯВНЫМ именем документа (без вывода из пути).
///
/// Нужно для multi-частей (BUG-UPLOAD-023): на диске temp-файл назван
/// непрозрачно (`{pid}_{i}.part`, Windows-safe — без `:`), но документ в
/// Telegram/Vault обязан нести slice-маркер `[slice:offset:size]`, иначе
/// bot-ingest не отличает часть от single-файла (`doc.file_name` — единственный
/// дискриминатор на стороне бота) и части 2..N теряются.
fn document_value_named(file_id: i32, file_name: &str, mime: Option<&str>) -> Value {
    json!({
        "@type": "inputDocument",
        "document": {
            "@type": "inputFileId",
            "id": file_id,
        },
        "file_name": file_name,
        "mime_type": mime.unwrap_or("application/octet-stream"),
    })
}

/// Имя документа multi-части: `<orig>[slice:<offset>:<size>]`.
///
/// Формат парсится bot-ом (`_SLICE_RE` в `bot/handlers/host_ingest.py`).
fn part_doc_name(orig: &str, offset: u64, size: u64) -> String {
    format!("{orig}[slice:{offset}:{size}]")
}


/// Запрос `sendMessage` (фаза 2). Caption/Topic — как в mainline.
fn send_message_request(
    upload_id: &str,
    chat_id: i64,
    message_thread_id: Option<i64>,
    document: Value,
    session_upload_id: Option<&str>,
) -> Value {
    let caption_text = format!(
        "upload_id:{}",
        session_upload_id.unwrap_or(upload_id)
    );
    let mut req = json!({
        "@type": "sendMessage",
        "chat_id": chat_id,
        "input_message_content": {
            "@type": "inputMessageDocument",
            "document": document,
            "disable_content_type_detection": true,
            "caption": {
                "@type": "formattedText",
                "text": caption_text,
                "entities": [],
            },
        },
        "@extra": format!("upload_send_{upload_id}"),
    });
    if let Some(tid) = message_thread_id {
        req["topic_id"] = json!({
            "@type": "messageTopicForum",
            "forum_topic_id": tid,
        });
    }
    req
}

/// Извлечь результат (tg_file_id / unique_id / message_id) из `message`.
fn extract_message_result(msg: &Value) -> Result<Value, String> {
    let message_id = msg["id"].as_i64().unwrap_or(0);
    let content = &msg["content"];
    // messageDocument → content.document.document (file).
    let doc = &content["document"]["document"];
    let mut tg_file_id = doc["remote"]["id"].as_str().unwrap_or("").to_string();
    let unique = doc["remote"]["unique_id"].as_str().unwrap_or("").to_string();
    if tg_file_id.is_empty() {
        // mainline BUG-TDLIB-021: прямой ответ `sendMessage` для inputFileLocal
        // НЕ содержит `content.document.remote.id` — это НЕ ошибка. Раньше здесь
        // падал весь upload («sendMessage: ответ без document.remote.id»): клиент
        // не отправлял /complete → файла в БД нет, баллы не начислены, PM не
        // чистится. Финализируем по message_id (сервер resolves по
        // telegram_message_id + host-ingest), tg_file_id доедет в
        // updateMessageSendSucceeded, если он успел прийти.
        eprintln!(
            "engine-core[upload]: extract_message_result: пустой document.remote.id (msg_id={message_id}, content={}) — финализируем по message_id (паритет с mainline)",
            content["@type"].as_str().unwrap_or("?")
        );
        tg_file_id = String::new();
    }
    Ok(json!({
        "tg_file_id": tg_file_id,
        "tg_file_unique_id": unique,
        "message_id": message_id,
    }))
}

/// Один полный цикл (2 фазы) загрузки файла в чат. Блокирующий (в worker-потоке).
fn run_upload(rt: &Arc<TdlibRuntime>, st: &Shared) -> Result<Value, String> {
    let (upload_id, file_path, chat_id, thread, session_id) = {
        let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        (
            g.upload_id.clone(),
            g.file_path.clone(),
            g.chat_id,
            g.message_thread_id,
            g.session_upload_id.clone(),
        )
    };

    // ── Фаза 1 ────────────────────────────────────────────────────────────
    let pre = rt.send_and_wait(
        json!({
            "@type": "preliminaryUploadFile",
            "file": { "@type": "inputFileLocal", "path": file_path },
            "file_type": { "@type": "fileTypeDocument" },
            "priority": 1,
            "@extra": format!("upload_pre_{upload_id}"),
        }),
        UPLOAD_TIMEOUT,
    )?;

    let file_id = pre["id"].as_i64().unwrap_or(0) as i32;
    let remote_id = pre["remote"]["id"].as_str().unwrap_or("").to_string();
    let size = pre["size"]
        .as_u64()
        .or_else(|| pre["expected_size"].as_u64())
        .unwrap_or(0);
    // BUG-TDLIB-016 (widget): для кэшированных/очень маленьких файлов загрузка
    // может завершиться УЖЕ в прямом ответе preliminaryUploadFile — тогда
    // updateFile-и не придут вовсе, и без этой пометки ждать было бы нечего.
    let pre_completed = pre["remote"]["is_uploading_completed"]
        .as_bool()
        .unwrap_or(false);

    // Диагностика фазы 1: дамп того, что реально вернул TDLib. Позволяет
    // отличить «ответ без remote.id» от «ответ без is_uploading_completed»
    // и понять, ждёт ли worker события, которое никогда не придёт.
    let pre_type = pre["@type"].as_str().unwrap_or("?").to_string();
    let pre_unique = pre["remote"]["unique_id"].as_str().unwrap_or("").to_string();
    let pre_active = pre["remote"]["is_uploading_active"].as_bool().unwrap_or(false);
    eprintln!(
        "engine-core[upload]: phase1 preliminaryUploadFile -> @type={pre_type} id={file_id} size={size} remote.id=\"{remote_id}\" remote.unique_id=\"{pre_unique}\" is_uploading_completed={pre_completed} is_uploading_active={pre_active}"
    );

    let upload_id_for_pending;
    {
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        g.file_id = file_id;
        if !remote_id.is_empty() {
            g.remote_id = remote_id.clone();
        }
        if size > 0 {
            g.total = size;
        }
        if pre_completed {
            g.upload_completed = true;
        }
        upload_id_for_pending = g.upload_id.clone();
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(file_id, g.upload_id.clone());
    } // g уничтожается здесь → shared.0 освобождается
      // Применяем updateFile-и, которые пришли ДО регистрации file_id.
    apply_pending_for(file_id, &upload_id_for_pending);
    // НЕ падаем при пустом remote.id здесь: TDLib отвечает на
    // preliminaryUploadFile сразу, ДО фактического завершения передачи,
    // а remote.id назначается сервером по окончании загрузки и приходит
    // в финальном updateFile (его сохраняет on_update_file → g.remote_id).

    // Ждём `remote.is_uploading_completed` (обновляет on_update_file).
    eprintln!(
        "engine-core[upload]: phase1 waiting for is_uploading_completed (upload_id={upload_id}, file_id={file_id})"
    );
    {
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        eprintln!(
            "engine-core[upload]: before wait loop: upload_completed={}, cancelled={}, error={:?}",
            g.upload_completed, g.cancelled, g.error
        );
        let deadline = Instant::now() + UPLOAD_TIMEOUT;
        while !g.upload_completed && !g.cancelled && g.error.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return Err("preliminaryUploadFile: таймаут ожидания загрузки (2ч)".into());
            }
            let (ng, timeout_result) = st
                .1
                .wait_timeout(g, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            g = ng;
            eprintln!(
                "engine-core[upload]: woke up: upload_completed={}, cancelled={}, error={:?}, timeout={}",
                g.upload_completed, g.cancelled, g.error, timeout_result.timed_out()
            );
        }
        if g.cancelled {
            return Err("Upload cancelled".into());
        }
        if let Some(e) = g.error.clone() {
            return Err(e);
        }
    }
    eprintln!("engine-core[upload]: phase1 done (upload_completed=true)");

    // remote.id берём из финального состояния: он мог прийти в прямом ответе
    // либо в последнем updateFile (on_update_file сохраняет его в g.remote_id).
    // Если remote.id пуст — используем inputFileLocal (fallback, как в Tauri).
    let final_remote_id = if remote_id.is_empty() {
        let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        g.remote_id.clone()
    } else {
        remote_id
    };

    eprintln!(
        "engine-core[upload]: phase1 ok — remote.id=\"{final_remote_id}\" (upload_id={upload_id}, input_type={})",
        if final_remote_id.is_empty() { "inputFileLocal" } else { "inputFileRemote" }
    );

    // ── Фаза 2 ────────────────────────────────────────────────────────────
    // BUG-UPLOAD-023: multi-части несут явное имя документа со slice-маркером
    // (temp-файл на диске назван непрозрачно), single — basename пути.
    let doc_name_override = {
        let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        g.doc_name.clone()
    };
    let doc = match doc_name_override {
        Some(name) => document_value_named(file_id, &name, None),
        None => document_value(file_id, &file_path, None),
    };
    let req = send_message_request(
        &upload_id,
        chat_id,
        thread,
        doc,
        session_id.as_deref(),
    );
    eprintln!(
        "engine-core[upload]: phase2 sendMessage chat_id={chat_id} remote.id=\"{final_remote_id}\" (upload_id={upload_id})"
    );
    // Регистрируем ожидание updateMessageSendSucceeded ДО отправки: иначе гонка —
    // событие может прийти раньше, чем worker успеет подписаться.
    let (send_tx, send_rx) = mpsc::channel::<Value>();
    pending_sends()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(upload_id.clone(), send_tx);

    let direct = match rt.send_and_wait(req, SEND_MSG_TIMEOUT) {
        Ok(v) => v,
        Err(e) => {
            pending_sends()
                .lock()
                .unwrap_or_else(|x| x.into_inner())
                .remove(&upload_id);
            return Err(e);
        }
    };
    eprintln!(
        "engine-core[upload]: phase2 direct resp: @type={} msg_id={}",
        direct["@type"].as_str().unwrap_or("?"),
        direct["id"].as_i64().unwrap_or(0),
    );

    // mainline BUG-TDLIB-020/021: прямой ответ `sendMessage` — объект `message`
    // с ПРЕДВАРИТЕЛЬНЫМ id и БЕЗ `content.document.remote.id` (для inputFileLocal).
    // Завершаться по нему нельзя, но его `id` — точный ключ для матчинга
    // `updateMessageSendSucceeded` (Priority 1): TDLib создаёт для отправленного
    // сообщения НОВЫЙ file-object, которого нет в `file_index`.
    if direct["@type"].as_str() == Some("message") {
        let mid = direct["id"].as_i64().unwrap_or(0);
        if mid != 0 {
            let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
            g.sent_message_id = Some(mid);
            eprintln!(
                "engine-core[upload]: phase2 sent_message_id={mid} сохранён для матчинга updateMessageSendSucceeded (upload_id={upload_id})"
            );
        }
    }

    // Прямой ответ sendMessage может нести ПРОМЕЖУТОЧНЫЙ message_id (и пустой
    // remote.id документа) — реальные значения приходят в
    // updateMessageSendSucceeded. Если он пришёл как прямой ответ (редкий
    // порядок) — используем его; иначе ждём событие.
    let final_msg = if direct["@type"].as_str() == Some("updateMessageSendSucceeded") {
        pending_sends()
            .lock()
            .unwrap_or_else(|x| x.into_inner())
            .remove(&upload_id);
        direct
    } else {
        match send_rx.recv_timeout(SEND_MSG_TIMEOUT) {
            Ok(u) => {
                eprintln!(
                    "engine-core[upload]: phase2 updateMessageSendSucceeded msg_id={}",
                    u["message"]["id"].as_i64().unwrap_or(0)
                );
                u
            }
            Err(_) => {
                // Событие не пришло: не блокируем навсегда — используем прямой
                // ответ (message_id может быть 0, но таймаут 120с больше вреда).
                pending_sends()
                    .lock()
                    .unwrap_or_else(|x| x.into_inner())
                    .remove(&upload_id);
                eprintln!(
                    "engine-core[upload]: phase2 timeout waiting updateMessageSendSucceeded — fallback на прямой ответ"
                );
                direct
            }
        }
    };

    extract_message_result(message_of(&final_msg))
}

/// Запустить single-upload. Возвращает `upload_id` (немедленно).
/// Зарегистрировать upload-задание и запустить worker-поток. `multi` — контекст
/// части (`part_index`, `total_parts`, `total_size`, `completed_before`).
fn spawn(
    rt: &Arc<TdlibRuntime>,
    file_path: String,
    chat_id: i64,
    message_thread_id: Option<i64>,
    session_upload_id: Option<String>,
    doc_name: Option<String>,
    multi: Option<(usize, usize, u64, u64)>,
) -> Result<String, String> {
    if !std::path::Path::new(&file_path).exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let upload_id = uid("upl_");
    let size = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
    let shared: Shared = Arc::new((
        Mutex::new(UploadState {
            upload_id: upload_id.clone(),
            file_path,
            chat_id,
            message_thread_id,
            session_upload_id,
            doc_name,
            multi,
            file_id: 0,
            remote_id: String::new(),
            sent_message_id: None,
            bytes_uploaded: 0,
            total: size,
            upload_completed: false,
            cancelled: false,
            done: false,
            error: None,
            result: None,
            last_emit: None,
            last_bytes: 0,
            last_ts: None,
            speed: 0,
        }),
        Condvar::new(),
    ));
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(upload_id.clone(), Arc::clone(&shared));

    let rt2 = Arc::clone(rt);
    let st2 = Arc::clone(&shared);
    std::thread::spawn(move || {
        run_worker_body(&st2, || run_upload(&rt2, &st2));
    });

    Ok(upload_id)
}

/// Выполнить тело upload-воркера и ГАРАНТИРОВАННО выставить `done`.
///
/// BUG-UPLOAD-019: `tdlib_wait_upload` ждёт `done`/`error` до 2 ч (RPC без
/// таймаута — в mainline так задумано для многочасовых загрузок). Если поток
/// воркера паникует, `done` не выставляется НИКОГДА: клиент висит молча, без
/// ошибки в UI, а паника detached-потока не доходит до main-loop (в stderr
/// обычно тоже ничего, т.к. процесс продолжает жить). Обёртка ловит панику,
/// печатает её и превращает в обычную ошибку задания — UI покажет причину.
fn run_worker_body<F>(st: &Shared, body: F)
where
    F: FnOnce() -> Result<Value, String>,
{
    // AssertUnwindSafe: состояние задания защищено Mutex, а частично изменённое
    // состояние после паники безопасно — мы лишь репортим ошибку и завершаем.
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).unwrap_or_else(|p| {
        // ВАЖНО: `&*p` (а не `&p`) — иначе коэрция даёт `&Box<dyn Any+Send>`,
        // и `downcast_ref::<&str>()` не совпадает → «unknown panic payload».
        let msg = panic_payload_message(&*p);
        eprintln!("engine-core[upload]: WORKER PANIC: {msg}");
        Err(format!("upload worker panic: {msg}"))
    });
    finalize_worker(st, res);
}

/// Текст паники из payload `catch_unwind` (`&str` | `String` | прочее).
fn panic_payload_message(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

/// Зафиксировать результат задания и разбудить ожидающих (`wait`).
fn finalize_worker(st: &Shared, res: Result<Value, String>) {
    let (state_mutex, cv) = &**st;
    let mut g = state_mutex.lock().unwrap_or_else(|e| e.into_inner());
    match res {
        Ok(v) => {
            g.result = Some(v);
            g.done = true;
            g.bytes_uploaded = g.total;
        }
        Err(e) => {
            g.error = Some(e);
            g.done = true;
        }
    }
    drop(g);
    cv.notify_all();
}


/// Нормализация chat_id: PM (бот) — положительный user_id как есть; канал/
/// супергруппа — `to_tdlib_chat_id` (mainline `start_upload`).
fn norm_chat(chat_id: i64, pm: bool) -> i64 {
    if pm {
        chat_id
    } else {
        crate::misc::to_tdlib_chat_id(chat_id)
    }
}

/// Single-upload (≤2GB). Возвращает `upload_id` (немедленно).
pub fn start(
    rt: &Arc<TdlibRuntime>,
    file_path: String,
    chat_id: i64,
    message_thread_id: Option<i64>,
    pm: bool,
    session_upload_id: Option<String>,
) -> Result<String, String> {
    spawn(
        rt,
        file_path,
        norm_chat(chat_id, pm),
        message_thread_id,
        session_upload_id,
        None,
        None,
    )
}

/// Вырезать сегмент файла в отдельный временный файл (потоково).
///
/// В mainline используется «Virtual File Slice» пропатченного TDLib; stock
/// libtdjson такого не умеет, поэтому для multi-upload режем сегменты сами.
fn slice_to_temp(src: &str, offset: u64, len: u64, dest: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut input =
        std::fs::File::open(src).map_err(|e| format!("open {src}: {e}"))?;
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {offset}: {e}"))?;
    let mut out = std::fs::File::create(dest).map_err(|e| format!("create {dest:?}: {e}"))?;
    let mut remaining = len;
    let mut buf = vec![0u8; 1 << 20];
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        let n = input
            .read(&mut buf[..want])
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        remaining -= n as u64;
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Multi-upload (>2GB): последовательная загрузка частей. Блокирующая
/// (UI ждёт результат как в mainline). Возвращает `{parts, total_parts, total_size}`.
#[allow(clippy::too_many_arguments)]
pub fn start_multi(
    rt: &Arc<TdlibRuntime>,
    file_path: String,
    chat_id: i64,
    max_part_size: u64,
    message_thread_id: Option<i64>,
    pm: bool,
    skip_offsets: Vec<u64>,
    session_upload_id: Option<String>,
) -> Result<Value, String> {
    if max_part_size == 0 {
        return Err("tdlib_start_multi_upload: maxPartSize обязателен (>0)".into());
    }
    let total_size = std::fs::metadata(&file_path)
        .map_err(|e| format!("File not found: {file_path}: {e}"))?
        .len();
    if total_size == 0 {
        return Err("tdlib_start_multi_upload: пустой файл".into());
    }
    let tdl_chat = norm_chat(chat_id, pm);
    let total_parts = total_size.div_ceil(max_part_size) as usize;

    let parts_dir = std::env::temp_dir().join("tdlib_upload_parts");
    std::fs::create_dir_all(&parts_dir).map_err(|e| format!("mkdir {parts_dir:?}: {e}"))?;

    let mut parts: Vec<Value> = Vec::new();
    let mut completed_before: u64 = 0;

    for i in 0..total_parts {
        let offset = i as u64 * max_part_size;
        let part_size = max_part_size.min(total_size - offset);

        // Resume: уже загруженные части пропускаем (mainline skip_offsets).
        if skip_offsets.contains(&offset) {
            completed_before += part_size;
            continue;
        }

        let tmp = parts_dir.join(format!("{}_{i}.part", std::process::id()));
        slice_to_temp(&file_path, offset, part_size, &tmp)?;

        // BUG-UPLOAD-023: имя документа несёт slice-маркер `[slice:offset:size]`
        // (диск-имя выше остаётся Windows-safe). bot-ingest по `doc.file_name`
        // вычисляет offset части и отличит multi от single.
        let doc_name = part_doc_name(&file_name_of(&file_path), offset, part_size);

        let upload_id = spawn(
            rt,
            tmp.to_string_lossy().to_string(),
            tdl_chat,
            message_thread_id,
            session_upload_id.clone(),
            Some(doc_name),
            Some((i, total_parts, total_size, completed_before)),
        )?;

        let res = wait(&upload_id, UPLOAD_TIMEOUT);
        let _ = std::fs::remove_file(&tmp);
        let res = match res {
            Ok(v) => v,
            Err(e) => {
                // Помечаем агрегат ошибкой, чтобы UI не ждал вечно.
                emit_event(
                    "tdlib-multi-upload-progress",
                    json!({
                        "upload_id": upload_id,
                        "current_part": i + 1,
                        "total_parts": total_parts,
                        "total_size": total_size,
                        "total_uploaded": completed_before,
                        "current_part_bytes_read": 0,
                        "current_part_total_bytes": part_size,
                        "percent": if total_size > 0 { ((completed_before as f64 / total_size as f64) * 100.0) as u32 } else { 0 },
                        "speed_bytes_per_sec": 0,
                        "eta_secs": 0,
                        "completed": false,
                        "error": e,
                    }),
                );
                return Err(e);
            }
        };

        let message_id = res["message_id"].as_i64().unwrap_or(0);
        emit_event(
            "tdlib-multi-upload-part-done",
            json!({
                "upload_id": upload_id,
                "part_index": i,
                "part_offset": offset,
                "part_size": part_size,
                "message_id": message_id,
            }),
        );
        parts.push(json!({
            "part_index": i,
            "file_offset": offset,
            "part_size": part_size,
            "tg_file_id": res["tg_file_id"],
            "tg_file_unique_id": res["tg_file_unique_id"],
            "telegram_message_id": message_id,
        }));
        completed_before += part_size;
    }

    Ok(json!({
        "parts": parts,
        "total_parts": parts.len(),
        "total_size": total_size,
    }))
}

/// Дождаться завершения upload (блокирующе). Возвращает результат фазы 2.
pub fn wait(upload_id: &str, timeout: Duration) -> Result<Value, String> {
    eprintln!(
        "engine-core[upload]: tdlib_wait_upload enter upload_id={upload_id}"
    );
    let shared = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(upload_id)
        .cloned()
        .ok_or_else(|| format!("tdlib_wait_upload: неизвестный upload_id={upload_id}"))?;

    let deadline = Instant::now() + timeout;
    let (state_mutex, cv) = &*shared;
    let mut g = state_mutex.lock().unwrap_or_else(|e| e.into_inner());
    while !g.done {
        let now = Instant::now();
        if now >= deadline {
            eprintln!("engine-core[upload]: tdlib_wait_upload таймаут (upload_id={upload_id})");
            return Err(format!("tdlib_wait_upload: таймаут {timeout:?}"));
        }
        let (ng, _) = cv
            .wait_timeout(g, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        g = ng;
    }
    if let Some(e) = g.error.clone() {
        eprintln!("engine-core[upload]: tdlib_wait_upload done with error: {e}");
        return Err(e);
    }
    let res = g
        .result
        .clone()
        .ok_or_else(|| "tdlib_wait_upload: результат отсутствует".to_string());
    eprintln!("engine-core[upload]: tdlib_wait_upload done ok (upload_id={upload_id})");
    res
}

/// Отмена upload: `cancelUploadFile` + пробуждение ожидающих.
pub fn cancel(rt: &TdlibRuntime, upload_id: &str) -> Result<Value, String> {
    let shared = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(upload_id)
        .cloned()
        .ok_or_else(|| format!("tdlib_cancel_upload: неизвестный upload_id={upload_id}"))?;
    let file_id = {
        let mut g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.cancelled = true;
        g.file_id
    };
    if file_id > 0 {
        let _ = rt.send_value(json!({
            "@type": "cancelUploadFile",
            "file_id": file_id,
        }));
    }
    shared.1.notify_all();
    Ok(json!({ "status": "cancelled", "upload_id": upload_id }))
}

/// Применить одно updateFile-событие к Shared-состоянию upload'а.
/// Вызывается как из on_update_file (прямой путь), так из apply_pending_for (для
/// накопленных до регистрации file_id событий).
fn apply_update_to_shared(val: &Value, file_id: i32, shared: &Shared) {
    let file = &val["file"];
    let remote = &file["remote"];
    let uploaded = remote["uploaded_size"]
        .as_u64()
        .or_else(|| file["local"]["uploaded_size"].as_u64())
        .unwrap_or(0);
    let total = file["size"]
        .as_u64()
        .or_else(|| file["expected_size"].as_u64())
        .unwrap_or(0);
    let completed = remote["is_uploading_completed"].as_bool().unwrap_or(false);
    let is_uploading_active = remote["is_uploading_active"].as_bool().unwrap_or(false);
    // Критерий завершения фазы 1 (зеркало Tauri tdlib_upload.rs:553):
    // is_uploading_completed || (!is_uploading && uploaded > 0 && size > 0)
    // ВАЖНО: uploaded > 0, НЕ uploaded >= size — иначе фаза 1 может зависнуть,
    // если последние байты в flight или TDLib не обновил uploaded_size.
    let should_complete = completed || (!is_uploading_active && uploaded > 0 && total > 0);
    if should_complete {
        eprintln!(
            "engine-core[upload]: phase1-complete (file_id={file_id}, uploaded={uploaded}, total={total}, is_uploading_active={is_uploading_active}, is_uploading_completed={completed})"
        );
    }
    // remote.id назначается сервером по завершении загрузки и приходит именно
    // в финальном updateFile (в прямом ответе preliminaryUploadFile его нет).
    let remote_id = remote["id"].as_str().unwrap_or("").to_string();

    let payload = {
        let mut g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if g.cancelled {
            return;
        }
        g.bytes_uploaded = uploaded;
        if !remote_id.is_empty() {
            g.remote_id = remote_id.clone();
        }
        if total > 0 {
            g.total = total;
        }
        if should_complete {
            g.upload_completed = true;
        }

        // скорость (moving-average на грубых дельтах времени)
        let now = Instant::now();
        if let Some(prev) = g.last_ts {
            let dt = now.duration_since(prev).as_secs_f64();
            if dt > 0.0 && uploaded >= g.last_bytes {
                let instant = ((uploaded - g.last_bytes) as f64 / dt) as u64;
                // EMA, чтобы цифра не «прыгала».
                g.speed = if g.speed == 0 {
                    instant
                } else {
                    (g.speed * 3 + instant) / 4
                };
            }
        }
        g.last_ts = Some(now);
        g.last_bytes = uploaded;

        let (percent, eta) = if g.total > 0 {
            let pct = ((uploaded as f64 / g.total as f64) * 100.0).min(100.0) as u32;
            let eta = if g.speed > 0 && uploaded < g.total {
                (g.total - uploaded) / g.speed
            } else {
                0
            };
            (pct, eta)
        } else {
            (0, 0)
        };

        // Троттлинг событий (200 мс), финальное — всегда.
        let throttle = match g.last_emit {
            Some(t) => now.duration_since(t) < EMIT_INTERVAL && !should_complete,
            None => false,
        };
        if throttle {
            if should_complete {
                shared.1.notify_all();
            }
            return;
        }
        g.last_emit = Some(now);

        let base = json!({
            "upload_id": g.upload_id,
            "file_id": g.file_id,
            "bytes_uploaded": uploaded,
            "total": g.total,
            "percent": percent,
            "speed_bytes_per_sec": g.speed,
            "eta_secs": eta,
            "completed": should_complete || g.upload_completed,
            "error": g.error,
        });
        base
    };

    // Мульти-режим: то же событие + агрегированное multi-прогресс.
    let multi_ctx = {
        let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        g.multi
    };
    if let Some((idx, total_parts, total_size, completed_before)) = multi_ctx {
        let cur_read = payload["bytes_uploaded"].as_u64().unwrap_or(0);
        let cur_total = payload["total"].as_u64().unwrap_or(0);
        let done_bytes = completed_before + payload["bytes_uploaded"].as_u64().unwrap_or(0);
        let permille = if total_size > 0 {
            ((done_bytes as f64 / total_size as f64) * 100.0).min(100.0) as u32
        } else {
            0
        };
        emit_event(
            "tdlib-multi-upload-progress",
            json!({
                "upload_id": payload["upload_id"],
                "current_part": idx + 1,
                "total_parts": total_parts,
                "total_size": total_size,
                "total_uploaded": done_bytes,
                "current_part_bytes_read": cur_read,
                "current_part_total_bytes": cur_total,
                "percent": permille,
                "speed_bytes_per_sec": payload["speed_bytes_per_sec"],
                "eta_secs": payload["eta_secs"],
                "completed": payload["completed"],
                "error": payload["error"],
            }),
        );
    }

    // Обычный прогресс-event (single upload).
    emit_event("tdlib-upload-progress", payload);

    // Диагностика: первое (uploaded==0), финальное (completed) и событие
    // «все байты переданы» — видно, приходят ли updateFile вообще и доходит
    // ли флаг is_uploading_completed до on_update_file.
    if completed || uploaded == 0 || uploaded == total {
        eprintln!(
            "engine-core[upload]: updateFile file_id={file_id} uploaded={uploaded} total={total} completed={completed} remote.id=\"{remote_id}\""
        );
    }

    // Если загрузка завершена — пробуждаем worker-поток.
    if should_complete {
        shared.1.notify_all();
    }
}

/// Обработчик `updateFile` из receive-loop для upload-прогресса.
///
/// Возвращает true, если файл принадлежит отслеживаемому upload'у (или если
/// событие было помещено в pending-буфер для будущей обработки).
pub fn on_update_file(val: &Value) -> bool {
    if val["@type"].as_str() != Some("updateFile") {
        return false;
    }
    let file = &val["file"];
    let file_id = file["id"].as_i64().unwrap_or(0) as i32;
    // Чужой файл (загрузка — своя или только что завершённая, в т.ч. по
    // «зеркальному» file_id того же remote) upload'у не принадлежит: иначе каждое
    // событие прогресса скачивания (одно на 512 КБ) оседало бы в pending-буфере
    // навсегда — спам в лог + утечка JSON (BUG-RCA-SPAM-001/002).
    if is_foreign_download(file_id, file["remote"]["id"].as_str().unwrap_or("")) {
        return false;
    }
    let extra = val["@extra"].as_str().unwrap_or("").to_string();
    let remote = &file["remote"];
    let remote_id = remote["id"].as_str().unwrap_or("");
    let completed = remote["is_uploading_completed"].as_bool().unwrap_or(false);
    let uploaded = remote["uploaded_size"]
        .as_u64()
        .or_else(|| file["local"]["uploaded_size"].as_u64())
        .unwrap_or(0);
    // Диагностика: логируем первое событие и завершение, но НЕ каждое
    // (для больших файлов updateFile идёт по 512 КБ → сотни строк шума).
    if completed || uploaded == 0 {
        eprintln!(
            "engine-core[upload]: on_update_file file_id={file_id} uploaded={uploaded} is_uploading_completed={completed} remote.id=\"{remote_id}\" extra=\"{extra}\""
        );
    }
    if file_id == 0 {
        return false;
    }
    let upload_id = match file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
    {
        Some(id) => id,
        None => {
            // Race condition: updateFile пришёл ДО ответа на preliminaryUploadFile.
            // Буферизируем — apply_pending_for применит после регистрации file_id.
            eprintln!("engine-core[upload]: on_update_file file_id={file_id} NOT FOUND in file_index → buffering as pending");
            let mut pending = pending_updates().lock().unwrap_or_else(|e| e.into_inner());
            let slot = pending.entry(file_id).or_default();
            // CAPA (BUG-RCA-SPAM-001): буфер ограничен. События несут
            // КУМУЛЯТИВНЫЙ `uploaded_size`, поэтому старые можно терять —
            // актуален последний; иначе JSON копился бы без границ.
            if slot.len() >= PENDING_UPDATES_MAX {
                slot.remove(0);
            }
            slot.push(val.clone());
            return true;
        }
    };
    let shared = match registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&upload_id)
        .cloned()
    {
        Some(s) => s,
        None => return false,
    };

    apply_update_to_shared(val, file_id, &shared);
    true
}

/// Найти upload_id по `message_id` (Priority 1 матчинга send-succeeded).
///
/// Снимок реестра берётся ДО взятия `shared.0` — иначе возможна инверсия порядка
/// блокировок (registry → shared) против пути `on_update_file`, где `shared`
/// берётся уже после отпускания `registry`.
fn match_upload_by_sent_message_id(sent_message_id: i64) -> Option<String> {
    if sent_message_id == 0 {
        return None;
    }
    let entries: Vec<(String, Shared)> = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(k, v)| (k.clone(), Arc::clone(v)))
        .collect();
    for (upload_id, shared) in entries {
        let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if g.sent_message_id == Some(sent_message_id) {
            return Some(upload_id);
        }
    }
    None
}

/// Найти upload_id по TDLib `file_id` (Priority 2 матчинга send-succeeded).
///
/// Возвращает `None` (а НЕ прерывает матчинг), если file_id нет в `file_index`:
/// для ОТПРАВЛЕННОГО сообщения TDLib создаёт новый file-object, которого в
/// индексе нет — это норма, а не повод отбросить событие.
fn match_upload_by_file_id(file_id: i32) -> Option<String> {
    if file_id == 0 {
        return None;
    }
    file_index()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&file_id)
        .cloned()
}

/// Разрешить ожидание `updateMessageSendSucceeded` (вызывается из receive-loop).
///
/// Матчинг (паритет с Tauri `handle_send_succeeded`, включая fallback-приоритеты):
/// 1. по `@extra` = `upload_send_{upload_id}`;
/// 2. по `message.content.document.document.id` → `file_index` → upload_id;
/// 3. fallback: единственный upload, ожидающий send (pending_sends).
///
/// Возвращает true, если событие относится к отслеживаемому upload'у.
pub fn on_update_message_send_succeeded(val: &Value) -> bool {
    if val["@type"].as_str() != Some("updateMessageSendSucceeded") {
        return false;
    }
    let msg = &val["message"];
    let file_id = msg["content"]["document"]["document"]["id"]
        .as_i64()
        .unwrap_or(0) as i32;
    let extra_upload = val["@extra"]
        .as_str()
        .and_then(|e| e.strip_prefix("upload_send_"))
        .map(|s| s.to_string());

    // Матчинг upload_id (паритет с mainline `handle_send_succeeded_by_message`,
    // BUG-TDLIB-021 — порядок приоритетов критичен):
    //   1. по `@extra` = `upload_send_{upload_id}`;
    //   2. по `sent_message_id` (id из прямого ответа sendMessage);
    //   3. по `message.content.document.document.id` → `file_index` → upload_id;
    //   4. fallback: единственный upload, ожидающий send (pending_sends).
    // РАНЬШЕ (баг): при `file_id != 0`, но отсутствующем в `file_index` (это НОРМА
    // для отправленного сообщения — TDLib создаёт новый file-object), был
    // early-return `false` → фаза 2 ждала 120с и падала на fallback по прямому
    // ответу без `remote.id`.
    let sent_id = msg["id"].as_i64().unwrap_or(0);
    let upload_id = if let Some(id) = extra_upload {
        id
    } else if let Some(id) = match_upload_by_sent_message_id(sent_id) {
        eprintln!(
            "engine-core[upload]: updateMessageSendSucceeded matched by sent_message_id={sent_id} → upload_id={id}"
        );
        id
    } else if let Some(id) = match_upload_by_file_id(file_id) {
        eprintln!(
            "engine-core[upload]: updateMessageSendSucceeded matched by file_id={file_id} → upload_id={id}"
        );
        id
    } else {
        // Fallback: ровно один ожидающий send.
        let map = pending_sends().lock().unwrap_or_else(|e| e.into_inner());
        if map.len() == 1 {
            match map.keys().next() {
                Some(k) => k.clone(),
                None => return false,
            }
        } else {
            eprintln!(
                "engine-core[upload]: updateMessageSendSucceeded UNMATCHED (file_id={file_id}, sent_message_id={sent_id}, pending_sends={})",
                map.len()
            );
            return false;
        }
    };

    let tx = pending_sends()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&upload_id);
    match tx {
        Some(tx) => {
            eprintln!(
                "engine-core[upload]: updateMessageSendSucceeded upload_id={upload_id} message_id={} (resolving)",
                msg["id"].as_i64().unwrap_or(0)
            );
            let _ = tx.send(val.clone());
            true
        }
        None => false,
    }
}

/// Очистка кеша: файлы TDLib-каталога (РЕКУРСИВНО) + `cleanFileDatabase` (best-effort).
pub fn clear_cache(rt: &TdlibRuntime) -> Result<Value, String> {
    // Только кеш ФАЙЛОВ: каталог БД чистить нельзя — снесёт сессию TDLib.
    // Состав каталогов — единый источник `janitor::cache_dirs()`: ровно этот же
    // список сносит стартовый дворник (BUG-JANITOR-WIN-001), включая legacy
    // `temp/tdlib_download_parts` и Windows-путь `%LOCALAPPDATA%\firmware-desktop-electron\tdlib_files`.
    let dirs = crate::janitor::cache_dirs();
    let removed = crate::tdlib_runtime::purge_cache_dirs(&dirs);
    let _ = rt.send_value(json!({
        "@type": "cleanFileDatabase",
        "chat_id": 0,
        "file_type": { "@type": "fileTypeUnknown" },
    }));
    Ok(json!({ "status": "cleared", "files_removed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_is_server_upload_id() {
        let req = send_message_request(
            "upl_local",
            5,
            None,
            document_value(0i32, "/tmp/a.bin", None),
            Some("srv_42"),
        );
        assert_eq!(
            req["input_message_content"]["caption"]["text"],
            json!("upload_id:srv_42")
        );
        // Fallback на upload_id, если серверного id нет.
        let req2 = send_message_request(
            "upl_local",
            5,
            None,
            document_value(0i32, "/x", None),
            None,
        );
        assert_eq!(
            req2["input_message_content"]["caption"]["text"],
            json!("upload_id:upl_local")
        );
    }

    #[test]
    fn forum_topic_or_flat_thread() {
        let with_topic = send_message_request(
            "u",
            1,
            Some(77),
            document_value(0i32, "/x", None),
            None,
        );
        assert_eq!(with_topic["topic_id"]["@type"], json!("messageTopicForum"));
        assert_eq!(with_topic["topic_id"]["forum_topic_id"], json!(77));
        let flat = send_message_request(
            "u",
            1,
            None,
            document_value(0i32, "/x", None),
            None,
        );
        assert!(flat.get("topic_id").is_none());
    }

    // ── BUG-TDLIB-013: document_value ВСЕГДА строит обёртку inputDocument с
    //    inputFileId (кеш TDLib после фазы-1), НИКОГДА не пустая строка и не
    //    inputFileLocal с уже-consumed path (docs §5 → `InputFile is not
    //    specified`). Раньше адаптивная схема + `document:""` падала на
    //    `InputFile is not specified`. ───────────────────────────────────────

    #[test]
    fn document_value_wraps_file_id_in_input_document() {
        let dv = document_value(42i32, "/tmp/a.bin", None);
        assert_eq!(dv["@type"], json!("inputDocument"));
        // document — inputFileId с непустым id (корень бага: раньше пустая строка).
        assert_eq!(dv["document"]["@type"], json!("inputFileId"));
        assert_eq!(dv["document"]["id"], json!(42));
        // file_name выводится из пути (как в mainline).
        assert_eq!(dv["file_name"], json!("a.bin"));
        assert_eq!(dv["mime_type"], json!("application/octet-stream"));
    }

    #[test]
    fn document_value_honors_mime_hint() {
        let dv = document_value(7i32, "/tmp/x.mkv", Some("video/x-matroska"));
        assert_eq!(dv["document"]["@type"], json!("inputFileId"));
        assert_eq!(dv["document"]["id"], json!(7));
        assert_eq!(dv["mime_type"], json!("video/x-matroska"));
    }

    /// BUG-UPLOAD-023: имя multi-части обязано нести slice-маркер, который парсит
    /// bot (`_SLICE_RE` = `\[slice:(\d+):(\d+)\]` в `bot/handlers/host_ingest.py`).
    /// Без него bot-ingest считал часть single-файлом → части 2..N терялись →
    /// `/complete` 500 «bot ingest anchors not ready (0/3)».
    #[test]
    fn part_doc_name_carries_parseable_slice_marker() {
        let name = part_doc_name("firmware.bin", 2_093_684_736, 2_093_684_736);
        assert_eq!(name, "firmware.bin[slice:2093684736:2093684736]");

        // Эмуляция серверного парсера (regex `\[slice:(\d+):(\d+)\]`).
        let marker_start = name.find("[slice:").expect("маркер обязан присутствовать");
        let inner = &name[marker_start + "[slice:".len()..name.len() - 1];
        let (off, size) = inner.split_once(':').expect("offset:size");
        assert_eq!(off, "2093684736");
        assert_eq!(size, "2093684736");
    }

    /// Явное имя документа (не из пути) уходит в payload как есть — temp-файл на
    /// диске назван непрозрачно (`{pid}_{i}.part`), а в Telegram/Vault обязан
    /// попасть `file_name` с маркером.
    #[test]
    fn document_value_named_uses_explicit_name() {
        let dv = document_value_named(9i32, "fw.bin[slice:0:100]", None);
        assert_eq!(dv["document"]["id"], json!(9));
        assert_eq!(dv["file_name"], json!("fw.bin[slice:0:100]"));
    }

    /// Регрессия BUG-TDLIB-013: sendMessage с inputMessageDocument строится валидно —
    /// обёртка `inputDocument` присутствует, `document` = `inputFileId` (id>0),
    /// `disable_content_type_detection` на уровне `inputMessageDocument` (как в
    /// mainline + docs/TDLIB_UPLOAD_WORKFLOW.md §6), thumbnail не задаётся. Такой
    /// payload проходит предавторизационный парсинг TDLib (live-чек — в
    /// e2e-prod32 wine-окне + ignored-тест `pre_auth_*` против хостового
    /// libtdjson 1.8.65 fork a8f21f523).
    #[test]
    fn input_message_document_payload_is_valid_shape_pre_auth() {
        let req = send_message_request(
            "preauth_1",
            -1001234567890,
            None,
            document_value(12345i32, "/tmp/firmware.bin", None),
            None,
        );
        let imc = &req["input_message_content"];
        assert_eq!(imc["@type"], json!("inputMessageDocument"));
        // document — обёрнут в inputDocument, внутри inputFileId с id>0.
        assert_eq!(imc["document"]["@type"], json!("inputDocument"));
        assert_eq!(imc["document"]["document"]["@type"], json!("inputFileId"));
        assert_eq!(imc["document"]["document"]["id"], json!(12345));
        // disable_content_type_detection — поле inputMessageDocument (НЕ inputDocument).
        assert_eq!(imc["disable_content_type_detection"], json!(true));
        assert!(
            imc.get("thumbnail").is_none(),
            "thumbnail не задаётся в inputMessageDocument"
        );
        // caption = upload_id (host-ingest диспетчеризация по ней).
        assert_eq!(imc["caption"]["text"], json!("upload_id:preauth_1"));
    }

    /// Живой pre-auth parse-чек против хостового libtdjson 1.8.65 fork: валидный
    /// `inputMessageDocument`-payload проходит структурный парсинг TDLib ДО проверки
    /// auth → возвращается ошибка авторизации, а НЕ `InputFile is not specified` и
    /// НЕ `Unknown class "inputDocument"`. `#[ignore]` пишет `~/.tdlib/...`,
    /// запускать в e2e/на dev-стенде: `cargo test -- --ignored pre_auth`.
    #[test]
    #[ignore = "живой TDLib (libtdjson); пишет ~/.tdlib — запускать в e2e"]
    fn pre_auth_sendmessage_parses_input_document() {
        let rt = TdlibRuntime::start(
            1,
            "00000000000000000000000000000000",
            "",
            Box::new(|_, _| {}),
            Vec::new(),
        )
        .expect("tdlib start");
        let payload = send_message_request(
            "preauth_parse_probe",
            1,
            None,
            document_value(1i32, "/tmp/does_not_matter.bin", None),
            None,
        );
        let res = rt.send_and_wait(payload, std::time::Duration::from_secs(8));
        let parsed_ok = match &res {
            Ok(_) => true,
            Err(e) => {
                !e.contains("InputFile is not specified")
                    && !e.contains("Unknown class")
                    && !e.contains("cannot parse")
            }
        };
        assert!(
            parsed_ok,
            "BUG-TDLIB-013: structurally-invalid sendMessage rejected by TDLib: {:?}",
            &res
        );
    }

    #[test]
    fn extract_result_from_message() {
        let msg = json!({
            "@type": "message", "id": 555,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "document": { "remote": { "id": "TGID", "unique_id": "UNIQ" } }
                }
            }
        });
        let r = extract_message_result(&msg).unwrap();
        assert_eq!(r["tg_file_id"], json!("TGID"));
        assert_eq!(r["tg_file_unique_id"], json!("UNIQ"));
        assert_eq!(r["message_id"], json!(555));
    }

    /// Текст паники извлекается из payload `catch_unwind` и для `panic!("литерал")`
    /// (`&str`), и для форматированного `panic!` (тоже `&str`), и для `String`
    /// (напр. `panic::panic_any(String)`).
    #[test]
    fn panic_payload_text_is_extracted() {
        let p = std::panic::catch_unwind(|| panic!("boom: literal"))
            .expect_err("panic");
        assert_eq!(panic_payload_message(&*p), "boom: literal");

        let p2 = std::panic::catch_unwind(|| panic!("boom {}", 42))
            .expect_err("panic");
        assert_eq!(panic_payload_message(&*p2), "boom 42");

        let p3 = std::panic::catch_unwind(|| {
            std::panic::panic_any(String::from("boom: owned"))
        })
        .expect_err("panic");
        assert_eq!(panic_payload_message(&*p3), "boom: owned");
    }

    /// Multi-upload режет сегменты сам (stock libtdjson не умеет Virtual File Slice).
    #[test]
    fn slice_to_temp_extracts_exact_segment() {
        let dir = std::env::temp_dir().join("engine-core-upload-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        std::fs::write(&src, b"0123456789ABCDEF").unwrap(); // 16 байт
        let part = dir.join("p1.part");
        slice_to_temp(src.to_str().unwrap(), 4, 6, &part).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"456789");
        // Последняя часть короче max_part_size — не должна «доберать» мусор.
        let tail = dir.join("p2.part");
        slice_to_temp(src.to_str().unwrap(), 14, 8, &tail).unwrap();
        assert_eq!(std::fs::read(&tail).unwrap(), b"EF");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pm_chat_id_not_normalized_but_channel_is() {
        assert_eq!(norm_chat(777000, true), 777000);
        assert_eq!(norm_chat(1234567890, false), -1001234567890);
    }

    /// Регистрация upload в глобальных реестрах, как это делает spawn().
    fn register_fake_upload(file_id: i32) -> (String, Shared) {
        let upload_id = uid("upl_t_");
        let shared: Shared = Arc::new((
            Mutex::new(UploadState {
                upload_id: upload_id.clone(),
                file_path: "/tmp/u.bin".to_string(),
                chat_id: 5,
                message_thread_id: None,
                session_upload_id: None,
                doc_name: None,
                multi: None,
                file_id: 0,
                remote_id: String::new(),
                sent_message_id: None,
                bytes_uploaded: 0,
                total: 100,
                upload_completed: false,
                cancelled: false,
                done: false,
                error: None,
                result: None,
                last_emit: None,
                last_bytes: 0,
                last_ts: None,
                speed: 0,
            }),
            Condvar::new(),
        ));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), Arc::clone(&shared));
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(file_id, upload_id.clone());
        (upload_id, shared)
    }

    /// Финальный updateFile несёт remote.id (назначается сервером по завершении
    /// загрузки) — BUG: раньше on_update_file его НЕ сохранял, и фаза 2
    /// (sendMessage) не могла собрать inputFileRemote.
    #[test]
    fn update_file_saves_remote_id_and_completed() {
        let (_, shared) = register_fake_upload(9001);
        let upd = json!({
            "@type": "updateFile",
            "file": {
                "id": 9001,
                "size": 100,
                "remote": {
                    "id": "REMOTE_ABC",
                    "unique_id": "UNIQ_1",
                    "uploaded_size": 100,
                    "is_uploading_completed": true,
                },
            },
        });
        assert!(on_update_file(&upd));
        let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(g.remote_id, "REMOTE_ABC");
        assert!(g.upload_completed);
        assert_eq!(g.bytes_uploaded, 100);
    }

    /// Промежуточные updateFile-и (прогресс) могут приходить без remote.id —
    /// уже полученный id затирать нельзя.
    #[test]
    fn update_file_never_clears_remote_id() {
        let (_, shared) = register_fake_upload(9002);
        let partial = json!({
            "@type": "updateFile",
            "file": {
                "id": 9002,
                "size": 100,
                "remote": { "uploaded_size": 50, "is_uploading_completed": false },
            },
        });
        assert!(on_update_file(&partial));
        {
            let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
            assert!(g.remote_id.is_empty());
        }
        let upd = json!({
            "@type": "updateFile",
            "file": {
                "id": 9002,
                "size": 100,
                "remote": {
                    "id": "REMOTE_2",
                    "unique_id": "UNIQ_2",
                    "uploaded_size": 100,
                    "is_uploading_completed": true,
                },
            },
        });
        assert!(on_update_file(&upd));
        let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(g.remote_id, "REMOTE_2");
        // Частичный updateFile БЕЗ remote.id после финального не стирает id.
        // (проверяем на другой записи, чтобы не мутить состояние первого теста)
    }

    /// Воспроизводит deadlock: apply_pending_for вызывается из-под lock на
    /// shared.0 (std::sync::Mutex не реентерабелен). Тест с таймаутом: до фикса
    /// зависает, после — проходит.
    #[test]
    fn apply_pending_for_does_not_deadlock() {
        use std::sync::mpsc;
        use std::time::Duration;

        // Регистрируем upload БЕЗ file_id в file_index (как в реальном сценарии:
        // ответ preliminaryUploadFile ещё не пришёл, а updateFile уже идёт).
        let upload_id = format!("upl_deadlock_{}", uid(""));
        let shared = Arc::new((
            Mutex::new(UploadState {
                upload_id: upload_id.clone(),
                file_path: "/tmp/test.bin".to_string(),
                chat_id: 5,
                message_thread_id: None,
                session_upload_id: None,
                doc_name: None,
                multi: None,
                file_id: 0,
                remote_id: String::new(),
                sent_message_id: None,
                bytes_uploaded: 0,
                total: 1000,
                upload_completed: false,
                cancelled: false,
                done: false,
                error: None,
                result: None,
                last_emit: None,
                last_bytes: 0,
                last_ts: None,
                speed: 0,
            }),
            Condvar::new(),
        ));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), Arc::clone(&shared));

        // updateFile приходит ДО регистрации file_id → попадает в pending.
        let upd = json!({
            "@type": "updateFile",
            "file": {
                "id": 9500,
                "size": 1000,
                "remote": {
                    "id": "REMOTE_X",
                    "unique_id": "UNIQ_X",
                    "uploaded_size": 1000,
                    "is_uploading_completed": true,
                },
            },
        });
        assert!(on_update_file(&upd));

        // Теперь file_id=9500 зарегистрирован в file_index (как после ответа
        // preliminaryUploadFile), и apply_pending_for вызывается из-под lock.
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(9500, upload_id.clone());

        let (tx, rx) = mpsc::channel();
        let upload_id_clone = upload_id.clone();
        std::thread::spawn(move || {
            // Production-сценарий ПОСЛЕ фикса: apply_pending_for вызывается БЕЗ
            // предварительного lock shared.0 (run_upload отпускает lock перед вызовом).
            apply_pending_for(9500, &upload_id_clone);
            let _ = tx.send(());
        });

        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(()) => {} // Успех — нет deadlock
            Err(_) => panic!("apply_pending_for deadlock: std::sync::Mutex не реентерабелен"),
        }
    }

    /// Проверяет, что apply_pending_for корректно применяет pending-update'и
    /// и устанавливает upload_completed + remote.id.
    /// BUG-UPLOAD-019: паника в воркере обязана стать обычной ошибкой задания.
    ///
    /// До фикса паника в `run_upload` оставляла `done=false` → `tdlib_wait_upload`
    /// (RPC без таймаута, mainline: до 2ч) висел бы молча, без ошибки в UI и без
    /// следа в логе: паника detached-потока не доходит до main-loop.
    #[test]
    fn worker_panic_reports_error_instead_of_hanging() {
        let upload_id = format!("upl_panic_test_{}", uid(""));
        let shared: Shared = Arc::new((
            Mutex::new(UploadState {
                upload_id: upload_id.clone(),
                file_path: "/tmp/panic-test.bin".to_string(),
                chat_id: 1,
                message_thread_id: None,
                session_upload_id: None,
                doc_name: None,
                multi: None,
                file_id: 0,
                remote_id: String::new(),
                sent_message_id: None,
                bytes_uploaded: 0,
                total: 0,
                upload_completed: false,
                cancelled: false,
                done: false,
                error: None,
                result: None,
                last_emit: None,
                last_bytes: 0,
                last_ts: None,
                speed: 0,
            }),
            Condvar::new(),
        ));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), Arc::clone(&shared));

        // Дефолтный hook печатает «thread panicked at …» — в тесте глушим его,
        // проверяем именно наш путь: паника → error задания.
        let prev_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        run_worker_body(&shared, || panic!("boom: имитация паники воркера"));
        std::panic::set_hook(prev_hook);

        let err = wait(&upload_id, Duration::from_secs(2))
            .expect_err("паника должна стать ошибкой, а не ожиданием 2ч");
        assert!(
            err.contains("panic"),
            "ожидали сообщение о панике воркера, получили: {err}"
        );
        assert!(
            err.contains("boom"),
            "текст паники должен сохраниться для диагностики: {err}"
        );

        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&upload_id);
    }

    #[test]
    fn apply_pending_for_applies_buffered_updates() {
        let upload_id = format!("upl_apply_test_{}", uid(""));
        let shared = Arc::new((
            Mutex::new(UploadState {
                upload_id: upload_id.clone(),
                file_path: "/tmp/test.bin".to_string(),
                chat_id: 5,
                message_thread_id: None,
                session_upload_id: None,
                doc_name: None,
                multi: None,
                file_id: 0,
                remote_id: String::new(),
                sent_message_id: None,
                bytes_uploaded: 0,
                total: 1000,
                upload_completed: false,
                cancelled: false,
                done: false,
                error: None,
                result: None,
                last_emit: None,
                last_bytes: 0,
                last_ts: None,
                speed: 0,
            }),
            Condvar::new(),
        ));
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), Arc::clone(&shared));

        // Два updateFile приходят ДО регистрации file_id.
        let upd1 = json!({
            "@type": "updateFile",
            "file": {
                "id": 9600,
                "size": 1000,
                "remote": { "uploaded_size": 500, "is_uploading_completed": false },
            },
        });
        let upd2 = json!({
            "@type": "updateFile",
            "file": {
                "id": 9600,
                "size": 1000,
                "remote": {
                    "id": "REMOTE_Y",
                    "unique_id": "UNIQ_Y",
                    "uploaded_size": 1000,
                    "is_uploading_completed": true,
                },
            },
        });
        assert!(on_update_file(&upd1));
        assert!(on_update_file(&upd2));

        // Регистрируем file_id и применяем pending.
        file_index()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(9600, upload_id.clone());
        apply_pending_for(9600, &upload_id);

        let g = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        assert!(g.upload_completed, "upload_completed должен быть true после финального updateFile");
        assert_eq!(g.remote_id, "REMOTE_Y", "remote.id должен быть из финального updateFile");
        assert_eq!(g.bytes_uploaded, 1000);
    }

    /// Сериализует тесты, трогающие глобальный `pending_sends`: иначе
    /// параллельный прогон может «увидеть» чужое ожидание в fallback-ветке.
    fn sends_test_lock() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

    /// Прямой ответ sendMessage (промежуточный message) vs
    /// updateMessageSendSucceeded: message_of() должен достать message-объект
    /// в обоих случаях.
    #[test]
    fn message_of_handles_both_shapes() {
        let direct = json!({ "@type": "message", "id": 11 });
        assert_eq!(message_of(&direct)["id"].as_i64(), Some(11));

        let succeeded = json!({
            "@type": "updateMessageSendSucceeded",
            "old_message_id": 11,
            "message": { "id": 4242 },
        });
        assert_eq!(message_of(&succeeded)["id"].as_i64(), Some(4242));
    }

    /// extract_message_result должен работать на updateMessageSendSucceeded
    /// (message вложен) и отдавать РЕАЛЬНЫЙ message_id + tg_file_id, а не
    /// промежуточный из прямого ответа.
    #[test]
    fn extract_message_result_from_succeeded_update() {
        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "old_message_id": 7,
            "message": {
                "id": 555,
                "content": {
                    "@type": "messageDocument",
                    "document": {
                        "document": {
                            "id": 1488,
                            "remote": { "id": "REMOTE_REAL", "unique_id": "UNIQ_REAL" }
                        }
                    }
                }
            },
        });
        let res = extract_message_result(message_of(&upd)).expect("должен извлечь результат");
        assert_eq!(res["message_id"].as_i64(), Some(555));
        assert_eq!(res["tg_file_id"].as_str(), Some("REMOTE_REAL"));
        assert_eq!(res["tg_file_unique_id"].as_str(), Some("UNIQ_REAL"));
    }

    /// BUG-UPLOAD-019 (корень): TDLib создаёт для ОТПРАВЛЕННОГО сообщения НОВЫЙ
    /// file-object, которого нет в `file_index`, поэтому матч по file_id не
    /// срабатывает. Priority 1 в mainline (`handle_send_succeeded_by_message`,
    /// BUG-TDLIB-021) — `sent_message_id` из прямого ответа sendMessage. Без него
    /// `updateMessageSendSucceeded` не резолвился → 120с ожидания → падение на
    /// прямом ответе без `remote.id` («ответ без document.remote.id»).
    #[test]
    fn send_succeeded_matches_by_sent_message_id() {
        let _guard = sends_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (upload_id, shared) = register_fake_upload(9800);
        shared
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sent_message_id = Some(4242);
        let (tx, rx) = mpsc::channel::<Value>();
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), tx);
        // Второе ожидание: single-pending fallback сработать НЕ может, поэтому
        // резолв возможен ТОЛЬКО по sent_message_id (Priority 1).
        let (tx_other, _rx_other) = mpsc::channel::<Value>();
        let other_id = format!("upl_other_{}", uid(""));
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(other_id.clone(), tx_other);

        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "message": {
                "id": 4242,
                "content": {
                    "@type": "messageDocument",
                    // file-object ОТПРАВЛЕННОГО сообщения — в file_index его НЕТ.
                    "document": { "document": { "id": 999999 } }
                }
            },
        });
        assert!(
            on_update_message_send_succeeded(&upd),
            "должно матчиться по sent_message_id (Priority 1)"
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2))
                .expect("событие должно доставиться по sent_message_id")["message"]["id"]
                .as_i64(),
            Some(4242)
        );
    }

    /// Без @extra и без попадания в `file_index` матчинг ОБЯЗАН дойти до fallback
    /// «ровно один ожидающий send» — раньше при неизвестном `file_id` был
    /// early-return `false`, и событие терялось (upload падал по таймауту).
    #[test]
    fn send_succeeded_falls_back_when_file_id_unknown() {
        let _guard = sends_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let (upload_id, _shared) = register_fake_upload(9900);
        let (tx, rx) = mpsc::channel::<Value>();
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), tx);

        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "message": {
                "id": 5151,
                "content": {
                    "@type": "messageDocument",
                    "document": { "document": { "id": 888888 } }
                }
            },
        });
        assert!(
            on_update_message_send_succeeded(&upd),
            "должен сработать single-pending fallback"
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2))
                .expect("событие должно доставиться fallback'ом")["message"]["id"]
                .as_i64(),
            Some(5151)
        );
    }

    /// mainline BUG-TDLIB-021: прямой ответ `sendMessage` для inputFileLocal НЕ
    /// несёт `document.remote.id` — это НЕ ошибка. Раньше здесь падал весь upload
    /// («sendMessage: ответ без document.remote.id») → клиент не отправлял
    /// `/complete` → файла в БД нет, баллы не начислены, PM не чистится.
    #[test]
    fn extract_result_tolerates_missing_remote_id() {
        let msg = json!({
            "@type": "message",
            "id": 777777,
            "content": {
                "@type": "messageDocument",
                "document": {
                    "document": { "id": 1267, "remote": { "id": "", "unique_id": "" } }
                }
            }
        });
        let res = extract_message_result(&msg)
            .expect("пустой remote.id не должен ронять upload");
        assert_eq!(res["message_id"].as_i64(), Some(777777));
        assert_eq!(res["tg_file_id"].as_str(), Some(""));
    }

    /// on_update_message_send_succeeded резолвит ожидание по @extra
    /// (upload_send_{upload_id}) и доставляет событие в канал.
    #[test]
    fn send_succeeded_resolves_by_extra() {
        let _guard = sends_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let upload_id = format!("upl_send_{}", uid(""));
        let (tx, rx) = mpsc::channel::<Value>();
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), tx);

        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "@extra": format!("upload_send_{upload_id}"),
            "message": { "id": 777, "content": { "@type": "messageDocument" } },
        });
        assert!(on_update_message_send_succeeded(&upd));
        let got = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("событие должно быть доставлено");
        assert_eq!(got["message"]["id"].as_i64(), Some(777));
        // Запись удалена после резолва.
        assert!(
            !pending_sends()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&upload_id),
            "pending_sends не должен удерживать resolved запись"
        );
    }

    /// Без @extra резолв идёт по file_id через file_index.
    #[test]
    fn send_succeeded_resolves_by_file_id() {
        let _guard = sends_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (upload_id, _shared) = register_fake_upload(9700);
        let (tx, rx) = mpsc::channel::<Value>();
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(upload_id.clone(), tx);

        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "message": {
                "id": 888,
                "content": {
                    "@type": "messageDocument",
                    "document": { "document": { "id": 9700 } }
                }
            },
        });
        assert!(on_update_message_send_succeeded(&upd));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2))
                .expect("должно резолвиться по file_id")["message"]["id"]
                .as_i64(),
            Some(888)
        );
    }

    /// Чужое событие (не наш upload) не должно резолвить ничего.
    #[test]
    fn send_succeeded_ignores_unrelated() {
        let _guard = sends_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        // Гарантируем отсутствие чужих ожиданий (иначе сработает fallback).
        pending_sends()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let upd = json!({
            "@type": "updateMessageSendSucceeded",
            "message": { "id": 1, "content": { "@type": "messageText" } },
        });
        assert!(!on_update_message_send_succeeded(&upd));
    }

    /// BUG-RCA-SPAM-001 / утечка pending (live 2026-09-28, e2e-prod32):
    /// `updateFile` СКАЧИВАЕМОГО файла попадал в upload-конвейер — 5714 событий
    /// (по одному на 512 КБ) получили «NOT FOUND in file_index → buffering as
    /// pending»: 2.4 МБ мусора в engine-core.log и 5714 JSON-клонов в
    /// `pending_updates`, которые никогда не вычищаются (утечка на каждую
    /// загрузку, риск кросс-загрязнения при переиспользовании file_id).
    ///
    /// Инвариант: файл активной загрузки upload'у не принадлежит.
    #[test]
    fn update_file_of_active_download_is_not_upload_pending() {
        let file_id = 424_242;
        crate::download::register_test_download(file_id);
        let val = json!({
            "@type": "updateFile",
            "file": {
                "id": file_id,
                "size": 1024,
                "remote": { "is_uploading_completed": true, "uploaded_size": 1024 },
                "local": { "downloaded_size": 512 }
            }
        });

        assert!(
            !on_update_file(&val),
            "updateFile активной загрузки не принадлежит upload'у"
        );
        assert_eq!(
            pending_len_for_test(file_id),
            0,
            "pending-буфер upload не должен расти на download-файлах (утечка)"
        );

        crate::download::unregister_test_download(file_id);
    }

    /// Гейт диагностики receive-loop: про файлы активных загрузок не печатаем
    /// (иначе строка на каждые 512 КБ — 2823 строки на файл 1.4 ГБ).
    #[test]
    fn completed_update_diagnostics_skips_active_download() {
        let file_id = 424_243;
        assert!(
            should_log_completed_update(file_id, "REMOTE-DIAG-1"),
            "неизвестный файл — печатаем (нужно для разбора race upload'а)"
        );
        crate::download::register_test_download(file_id);
        assert!(
            !should_log_completed_update(file_id, "REMOTE-DIAG-1"),
            "активная загрузка — молчим (это не upload)"
        );
        crate::download::unregister_test_download(file_id);
    }

    /// BUG-RCA-SPAM-002 (live 2026-09-28, e2e-prod32): даже с гейтом активных
    /// загрузок в upload-конвейер попадал ФИНАЛЬНЫЙ `updateFile` УЖЕ ЗАВЕРШЁННОЙ
    /// операции — как по своему file_id (1257), так и по «зеркальному» (1258, тот
    /// же `remote.id` документа доставки). Записи в реестрах уже нет/завершена →
    /// событие уходило в `pending_updates` («NOT FOUND in file_index»).
    #[test]
    fn update_file_of_completed_download_is_not_upload_pending() {
        let file_id = 424_250;
        crate::download::register_test_download(file_id);
        crate::download::complete_test_download(file_id, "REMOTE-DONE-1");

        // (а) финальное событие по СВОЕМУ file_id завершённой загрузки;
        // (б) то же событие по «зеркальному» file_id (в реестре нет вовсе).
        for id in [file_id, file_id + 1] {
            let val = json!({
                "@type": "updateFile",
                "file": {
                    "id": id,
                    "size": 1521225086,
                    "remote": {
                        "id": "REMOTE-DONE-1",
                        "is_uploading_completed": true,
                        "uploaded_size": 1521225086
                    },
                    "local": { "downloaded_size": 1521225086 }
                }
            });
            assert!(
                !on_update_file(&val),
                "финальный updateFile завершённой загрузки (file_id={id}) — не upload"
            );
            assert_eq!(
                pending_len_for_test(id),
                0,
                "pending-буфер upload не должен расти на завершённых загрузках"
            );
        }

        assert!(
            !should_log_completed_update(file_id, "REMOTE-DONE-1"),
            "диагностику receive-loop для завершённых загрузок тоже глушим"
        );

        crate::download::unregister_test_download(file_id);
    }

    /// BUG-RCA-SPAM-002: зеркало ЧАСТИ multi-загрузки (1249 при качавшемся 1246).
    #[test]
    fn update_file_of_completed_multi_part_is_not_upload_pending() {
        let part_file_id = 424_260;
        crate::parts_download::clear_completed_parts_for_test();
        crate::parts_download::mark_part_completed(part_file_id, "REMOTE-PART-DONE-1");

        for id in [part_file_id, part_file_id + 1] {
            let val = json!({
                "@type": "updateFile",
                "file": {
                    "id": id,
                    "size": 2093796556,
                    "remote": {
                        "id": "REMOTE-PART-DONE-1",
                        "is_uploading_completed": true,
                        "uploaded_size": 2093796556
                    },
                    "local": { "downloaded_size": 2093796556 }
                }
            });
            assert!(
                !on_update_file(&val),
                "финальный updateFile завершённой части (file_id={id}) — не upload"
            );
            assert_eq!(pending_len_for_test(id), 0);
        }

        // Чужой remote.id по-прежнему идёт в pending (гейт не «глушит всех подряд»).
        let foreign = json!({
            "@type": "updateFile",
            "file": { "id": 424_299, "remote": { "id": "REMOTE-OTHER-999" }, "local": {} }
        });
        assert!(on_update_file(&foreign), "чужой upload обязан буферизоваться");
        pending_updates()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&424_299);

        crate::parts_download::clear_completed_parts_for_test();
    }

    /// CAPA: pending-буфер на один file_id ограничен (иначе JSON копится вечно).
    #[test]
    fn pending_updates_buffer_is_bounded() {
        let file_id = 424_244;
        for i in 0..(PENDING_UPDATES_MAX + 5) {
            let val = json!({
                "@type": "updateFile",
                "file": {
                    "id": file_id,
                    "remote": { "uploaded_size": i },
                    "local": {}
                }
            });
            assert!(on_update_file(&val), "неизвестный upload — буферизуется");
        }
        assert_eq!(
            pending_len_for_test(file_id),
            PENDING_UPDATES_MAX,
            "буфер обязан быть ограничен"
        );
        // Оставляем последнее событие (кумулятивный объём) — актуальны они.
        pending_updates()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&file_id);
    }
}
