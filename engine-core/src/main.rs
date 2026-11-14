//! engine-core — автономный Rust-sidecar для Electron Win7/8 порта FW CLOUD.
//!
//! Без Tauri/WebView. Electron main запускает нас как дочерний процесс и
//! общается по framed stdio JSON-RPC:
//!
//!   кадр = [u32 BE длина][payload UTF-8 JSON]
//!   request : {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
//!   response: {"jsonrpc":"2.0","id":N,"result":{...}}
//!   error   : {"jsonrpc":"2.0","id":N,"error":{"code":..,"message":".."}}
//!
//! stdout — ТОЛЬКО кадры. Вся диагностика — в stderr (не трогает framing).
//!
//! M0 команды:
//!   - ping      → pong + health (заодно доказывает, что firmware-core слинкован);
//!   - hash_file → sha256 файла.
//!
//! ⚠️ hash_file и firmware-core: mainline [`hash.rs`] имеет `println!` в stdout
//! (DEBUG-строка), что ломает кадры. Поэтому рантайм-функция здесь — тихая
//! копия того же алгоритма (`quiet_sha256_file`), а совпадение с
//! `firmware_core::hash::sha256_file` и сама линковка доказываются:
//!   1) юнит-тестом (ниже), который зовёт firmware-core напрямую;
//!   2) вызовом чистой функции firmware-core (`get_path_info`) в ping/health.
//! Вынос/доработка firmware-core без println — задача M1 (не трогаем mainline в M0).

use std::io::{self, BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use sha2::{Digest, Sha256};

/// M2: fs/scan/hash/archive команды (без Tauri).
mod m2;
mod paths;
/// Дворник temp-мусора/кеша (BUG-CANCEL-FINAL-001, BUG-JANITOR-WIN-001).
mod janitor;
/// M4a1: TDLib JSON runtime (без Tauri) — FFI libtdjson + receive-loop.
mod tdlib_runtime;
/// M4a3: single-file download через TDLib (без Tauri).
mod download;
/// M4a3-шаг2: сервисные TDLib-команды (join/delete/send_bot_start).
mod misc;
/// M4a4: upload (single + multi) через TDLib.
mod upload;
/// M4a3-шаг2: multi/vault/composite download (склейка частей).
mod parts_download;

use tdlib_runtime::TdlibRuntime;

/// Глобальный TDLib runtime (один на процесс). Option = не запущен.
static TDLIB: OnceLock<Mutex<Option<Arc<TdlibRuntime>>>> = OnceLock::new();

fn tdlib_global() -> &'static Mutex<Option<Arc<TdlibRuntime>>> {
    TDLIB.get_or_init(|| Mutex::new(None))
}

/// Длина префикса кадра (u32 BE).
const FRAME_HDR_LEN: usize = 4;
/// Верхняя граница кадра (защита от мусора на входе).
const MAX_FRAME: u32 = 64 * 1024 * 1024;

/// Версия engine-core (синхронизировать с Cargo.toml/package при релизе).
const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

// ─────────────────────────────────────────────────────────────────────────────
// Framing (чтение/запись)
// ─────────────────────────────────────────────────────────────────────────────

/// Записать JSON-кадр в stdout (перехватываем панику записи → в stderr).
fn write_frame(writer: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)?;
    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

/// Читатель кадров: аккумулятор байт + извлечение кадров по префиксу длины.
struct FrameReader<R: Read> {
    reader: BufReader<R>,
    buf: Vec<u8>,
}

impl<R: Read> FrameReader<R> {
    fn new(reader: R) -> Self {
        Self { reader: BufReader::new(reader), buf: Vec::new() }
    }

    /// Прочитать один кадр (payload как строка). None — EOF.
    fn next_frame(&mut self) -> io::Result<Option<String>> {
        loop {
            // Нужно минимум 4 байта префикса.
            if self.buf.len() < FRAME_HDR_LEN {
                if !self.read_more()? {
                    return Ok(None);
                }
                continue;
            }
            let len = u32::from_be_bytes([
                self.buf[0],
                self.buf[1],
                self.buf[2],
                self.buf[3],
            ]) as usize;
            if len == 0 || len > MAX_FRAME as usize {
                // Рассинхрон: сбрасываем 1 байт (устойчивость к мусору в dev).
                eprintln!("engine-core: bad frame length={len}, resyncing");
                self.buf.drain(..1);
                continue;
            }
            // Ждём полный payload.
            while self.buf.len() < FRAME_HDR_LEN + len {
                if !self.read_more()? {
                    return Ok(None);
                }
            }
            // Удаляем ВЕСЬ кадр (4-байтовый header + payload), а не только
            // payload: иначе при нескольких кадрах в одном чанке header первого
            // кадра останется в буфере и собьёт парсинг следующего.
            let payload: Vec<u8> = self.buf.drain(..FRAME_HDR_LEN + len).collect();
            let text = String::from_utf8(payload[FRAME_HDR_LEN..].to_vec())
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            return Ok(Some(text));
        }
    }

    /// Дочитать очередной чанк. Ok(false) — EOF (read вернул 0).
    fn read_more(&mut self) -> io::Result<bool> {
        let mut chunk = [0u8; 8192];
        let n = self.reader.read(&mut chunk)?;
        if n == 0 {
            return Ok(false);
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(true)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Тихая sha256 (потоковая, без stdout-вывода — аналог firmware-core, но clean)
// ─────────────────────────────────────────────────────────────────────────────

fn quiet_sha256_file(path: &Path) -> anyhow::Result<String> {
    let file = std::fs::File::open(path)
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
    Ok(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработчики команд
// ─────────────────────────────────────────────────────────────────────────────

/// ping → pong + health. Заодно доказывает линковку firmware-core: вызываем
/// его чистую функцию `get_path_info` на собственном исполняемом файле.
fn handle_ping() -> Result<serde_json::Value, String> {
    let firmware_linked = (|| {
        let exe = std::env::current_exe().ok()?;
        let info = firmware_core::scanner::get_path_info(&exe.to_string_lossy()).ok()?;
        Some(info.name)
    })();
    Ok(serde_json::json!({
        "status": "ok",
        "engine": "engine-core",
        "version": ENGINE_VERSION,
        "firmware_core_linked": firmware_linked.is_some(),
        "firmware_core_exe": firmware_linked.unwrap_or_default(),
        "pid": std::process::id(),
    }))
}

/// hash_file → sha256. Params: {"path": "..."}
fn handle_hash_file(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let p = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "hash_file: 'path' (string) required".to_string())?;
    if p.is_empty() {
        return Err("hash_file: 'path' must not be empty".to_string());
    }
    let sha = quiet_sha256_file(Path::new(p))
        .map_err(|e| format!("hash_file: {e}"))?;
    Ok(serde_json::json!({
        "path": p,
        "sha256": sha,
        "engine": "engine-core",
        "hash_impl": "sha2-streaming (firmware-core algorithm, quiet)",
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// main loop
// ─────────────────────────────────────────────────────────────────────────────

/// Потокобезопасная запись кадра в stdout (короткий lock на каждый кадр).
/// Используется и main-loop (ответы), и receive-thread (события).
fn write_stdout(value: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = write_frame(&mut out, value) {
        eprintln!("engine-core: write error: {e}");
    }
}

/// Эмиссия события из любого потока: {"jsonrpc":"2.0","event":name,"params":...}.
fn emit_event(name: &str, payload: serde_json::Value) {
    write_stdout(&serde_json::json!({
        "jsonrpc": "2.0",
        "event": name,
        "params": payload,
    }));
}

/// Создать и запустить TDLib runtime (общий путь start/reset): события
/// auth/connection-state уходят в stdout-кадры.
fn spawn_tdlib_runtime(
    api_id: i32,
    api_hash: &str,
    bot_token: &str,
    auth_tokens: Vec<String>,
) -> Result<Arc<TdlibRuntime>, String> {
    let cb: tdlib_runtime::EventCb = Box::new(|name: &str, payload: serde_json::Value| {
        emit_event(name, payload);
    });
    TdlibRuntime::start(api_id, api_hash, bot_token, cb, auth_tokens)
}

/// Страховка свежего runtime после логаута (BUG-AUTH-LOGOUT-QR-001, фаза 2).
///
/// Если БД всё же осталась в `authorizationStateLoggingOut` (ожидание Closed
/// не дождалось, см. `handle_tdlib_logout`), свежий клиент продолжит логаут,
/// уничтожит БД и отдаст `authorizationStateClosed` вместо `WaitPhoneNumber`.
/// Тогда пересоздаём клиент ОДИН раз: после дестроя каталог чист, второй
/// старт даёт `WaitPhoneNumber` и QR работает (так же «лечится» полный
/// перезапуск приложения).
fn spawn_tdlib_runtime_after_logout(
    api_id: i32,
    api_hash: &str,
    bot_token: &str,
    auth_tokens: Vec<String>,
) -> Result<Arc<TdlibRuntime>, String> {
    let rt = spawn_tdlib_runtime(api_id, api_hash, bot_token, auth_tokens.clone())?;
    if rt.wait_not_closed_after_start(std::time::Duration::from_secs(4)) {
        return Ok(rt);
    }
    eprintln!(
        "engine-core[tdlib]: логаут: свежий клиент увидел authorizationStateClosed (в БД хвост логаута) — пересоздаю клиент, каталог уже чист"
    );
    rt.shutdown();
    spawn_tdlib_runtime(api_id, api_hash, bot_token, auth_tokens)
}

/// M4a1: запуск TDLib runtime (события auth-state → stdout).
fn handle_tdlib_start(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let api_id = params.get("apiId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let api_hash = params.get("apiHash").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let bot_token = params.get("botToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if api_id == 0 || api_hash.is_empty() {
        return Err("tdlib_start_runtime: apiId/apiHash required".into());
    }

    let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Err("tdlib_start_runtime: already running (сначала shutdown)".into());
    }

    let rt = spawn_tdlib_runtime(api_id, &api_hash, &bot_token, Vec::new())?;
    *guard = Some(rt);
    Ok(serde_json::json!({ "status": "started", "engine": "engine-core" }))
}

/// M4a2: полный сброс авторизации — паритет с mainline `tdlib_reset_auth`
/// (tdlib_auth.rs:548): shutdown старого клиента → удаление state-каталога →
/// создание нового runtime (снова `authorizationStateWaitPhoneNumber`).
///
/// Нужно UI-кнопкам «Скинути» и смене аккаунта: без этого после неудачного
/// входа пользователь остаётся заперт в прежнем TDLib-состоянии.
fn handle_tdlib_reset_auth() -> Result<serde_json::Value, String> {
    let (api_id, api_hash, bot_token) = {
        let guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or_else(|| "tdlib_reset_auth: TDLib runtime not initialized".to_string())?
            .config()
    };

    // 1) Остановить старый receive-loop и уничтожить клиент (Drop → destroy).
    {
        let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rt) = guard.take() {
            rt.shutdown();
        }
    }

    // 2) Удалить state-каталог (как mainline cleanup_tdlib_state).
    let state_removed = tdlib_runtime::cleanup_state_dir(api_id);

    // 3) Поднять runtime заново: TDLib снова спросит номер/QR.
    download::reset();
    upload::reset();
    parts_download::reset();
    let rt = spawn_tdlib_runtime(api_id, &api_hash, &bot_token, Vec::new())?;
    {
        let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("tdlib_reset_auth: runtime restarted concurrently".into());
        }
        *guard = Some(rt);
    }
    Ok(serde_json::json!({ "status": "ok", "state_removed": state_removed }))
}

/// «Выйти из аккаунта» (BUG-AUTH-CODE-006, future-auth-token, 2026-10-20).
///
/// ОТЛИЧИЕ от `tdlib_reset_auth`: каталог состояния TDLib СОХРАНЯЕТСЯ.
/// Доки Telegram (core.telegram.org/api/auth → «Future auth tokens»):
/// `auth.logOut` отзывает сессию и TDLib сохраняет `future_auth_token` В
/// КАТАЛОГЕ СОСТОЯНИЯ; следующий `auth.sendCode` из того же каталога
/// отправит его в `codeSettings.logout_tokens` → Telegram вернёт
/// `SentCodeSuccess` — вход БЕЗ доставки кода (мгновенно). Снос каталога
/// (как в reset_auth) теряет токены → свежий код → редкие «окна» доставки
/// → «код не приходит». Поэтому: logOut (сеть) → shutdown → RESTART той же
/// БД, каталог НЕ трогаем. Для «сбросить застрявший вход» остаётся
/// `tdlib_reset_auth` (там каталог можно сносить: токенов нет).
fn handle_tdlib_logout() -> Result<serde_json::Value, String> {
    let (api_id, api_hash, bot_token, logged_out, auth_tokens) = {
        let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
        let rt = guard
            .take()
            .ok_or_else(|| "tdlib_logout: TDLib runtime not initialized".to_string())?;
        let was_ready = rt.is_ready();
        // 1) Сетевой logout — только из авторизованного состояния: отзывает
        //    сессию на стороне Telegram, TDLib при этом сохраняет future-токен.
        if was_ready {
            match rt.send_and_wait(
                serde_json::json!({ "@type": "logOut", "@extra": "tdlib_logout_req" }),
                std::time::Duration::from_secs(20),
            ) {
                Ok(v) => eprintln!(
                    "engine-core[tdlib]: logOut → {}",
                    v.get("@type").and_then(|t| t.as_str()).unwrap_or("?")
                ),
                Err(e) => eprintln!("engine-core[tdlib]: logOut wait failed: {e}"),
            }
            // BUG-AUTH-LOGOUT-QR-001 (фаза 2): ответ `ok` — только отзыв
            // сессии НА СЕРВЕРЕ. Локально TDLib ДОЛЖЕН ещё уничтожить ключи и
            // БД и только потом прислать authorizationStateClosed (официальный
            // контракт logOut: «After the logout completes … Closed will be
            // sent»). Ждём его ДО закрытия: иначе БД остаётся в
            // authorizationStateLoggingOut, свежий клиент продолжает логаут
            // («Destroy all databases») и отдаёт Closed вместо
            // WaitPhoneNumber — QR мёртв (живой tdlib.log 2026-11-10
            // 22:18:57→58, сторона убита через 104 мс после ok). Ждём и при
            // потере ответа: запрос мог дойти до TDLib даже без ответа.
            let closed = rt.wait_authorization_closed(std::time::Duration::from_secs(5));
            eprintln!("engine-core[tdlib]: логаут завершён локально (Closed={closed})");
        } else {
            eprintln!(
                "engine-core[tdlib]: logout: runtime не авторизован (was_ready=false) — только restart"
            );
        }
        // 2) Future-токены входа (BUG-AUTH-CODE-008): TDLib отдаёт их через
        //    updateOption — сохраняем ДО shutdown, чтобы новая сессия (новый
        //    каталог) унаследовала «вход без кода».
        let tokens = rt.auth_tokens();
        // 3) Graceful shutdown (close → join receive-loop → destroy).
        rt.shutdown();
        let (api_id, api_hash, bot_token) = rt.config();
        (api_id, api_hash, bot_token, was_ready, tokens)
    };

    // 3) Сброс реестров загрузок: file_id старой сессии невалидны.
    download::reset();
    upload::reset();
    parts_download::reset();

    // 4) Поднять runtime заново В НОВОМ каталоге сессии (BUG-AUTH-LOGOUT-QR-001).
    //
    //    Почему не в том же: после `auth.logOut` общий TDLib-инстанс этого
    //    процесса держит для каталога сессии состояние «closed» → клиент на нём
    //    же сразу отдаёт `authorizationStateClosed`, и QR не генерится (живой
    //    репорт владельца 2026-11-10: «QR не генерируется, приходится закрывать
    //    клиент и перезапускать»). У TDLib состояние общего инстанса ведётся
    //    НА КАТАЛОГ, поэтому свежая сессия в отдельном каталоге стартует
    //    чисто (WaitPhoneNumber), а метка `relogin_session` говорит следующему
    //    запуску приложения открыть именно этот каталог.
    //
    //    Future-токены входа переносим вручную: в новом каталоге TDLib их не
    //    переигрывает, а без них вход по номеру перестал бы быть мгновенным
    //    (BUG-AUTH-CODE-006).
    let tokens_count = auth_tokens.len();
    let rt = spawn_tdlib_runtime_after_logout(api_id, &api_hash, &bot_token, auth_tokens)?;
    {
        let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("tdlib_logout: runtime restarted concurrently".into());
        }
        *guard = Some(rt);
    }
    Ok(serde_json::json!({
        "status": "ok",
        "logged_out": logged_out,
        // Сессия пересоздана в отдельном каталоге (релогин), future-токены
        // перенесены — вход по номеру остаётся мгновенным.
        "state_kept": true,
        "relogin_session": true,
        "auth_tokens_carried": tokens_count,
    }))
}

/// M4a1: статус TDLib runtime.
/// Контракт mainline `RuntimeStatus`: UI читает `ready` и `download_manager`
/// (см. `TdlibFfiRuntimeStatus` в DownloadPage и UploadPage.ts:2001), плюс
/// `authorization_state`. Поля `running`/`started` сохранены для совместимости.
fn handle_tdlib_status() -> Result<serde_json::Value, String> {
    let guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(rt) => Ok(serde_json::json!({
            "ready": rt.is_ready(),
            "authorization_state": rt.last_state(),
            "download_manager": true,
            "running": rt.is_running(),
            "started": true,
        })),
        None => Ok(serde_json::json!({
            "ready": false,
            "authorization_state": "",
            "download_manager": false,
            "running": false,
            "started": false,
        })),
    }
}

/// M4a1: is_ready — ПАРИТЕТ с mainline `tdlib_is_ready() -> bool`
/// (tdlib_event_loop.rs:656) = «TDLib авторизован», а НЕ «runtime запущен».
///
/// Возвращаем ГОЛЫЙ boolean: UI вызывает `invoke<boolean>("tdlib_is_ready")`
/// ([`TdlibAuthPage._isTdlibReady`]). Ранее здесь отдавался объект
/// `{"ready": true}` — он всегда truthy (объект), поэтому QR-поллинг считал
/// вход завершённым сразу после генерации QR и запускал API-pairing (401).
fn handle_tdlib_is_ready() -> Result<serde_json::Value, String> {
    let guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(rt) => Ok(serde_json::json!(rt.is_ready())),
        None => Ok(serde_json::json!(false)),
    }
}

/// M4a1: остановка TDLib runtime.
fn handle_tdlib_shutdown() -> Result<serde_json::Value, String> {
    let mut guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(rt) = guard.take() {
        rt.shutdown();
        Ok(serde_json::json!({ "status": "stopped" }))
    } else {
        Ok(serde_json::json!({ "status": "not_running" }))
    }
}

// ── M4a2: auth-команды ────────────────────────────────────────────────────────
// Все fire-and-forget: отправляют TDLib-запрос, результат (успех/ошибка) приходит
// событиями (tdlib-auth-state / tdlib-auth-error / tdlib-my-id). Возвращаем "sent"
// как mainline, чтобы UI разблокировал кнопки.

fn tdlib_lock() -> Result<std::sync::MutexGuard<'static, Option<Arc<TdlibRuntime>>>, String> {
    tdlib_global().lock().map_err(|e| e.to_string())
}

fn handle_tdlib_auth_send(
    f: impl FnOnce(&TdlibRuntime) -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    let guard = tdlib_lock()?;
    let rt = guard
        .as_ref()
        .ok_or_else(|| "TDLib runtime not initialized (tdlib_start_runtime)".to_string())?;
    f(rt)?;
    Ok(serde_json::json!({ "status": "sent" }))
}

fn handle_tdlib_qr_login() -> Result<serde_json::Value, String> {
    handle_tdlib_auth_send(|rt| rt.request_qr_login())
}

fn handle_tdlib_set_phone(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let phone = params
        .get("phone")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tdlib_set_phone: phone required".to_string())?
        .to_string();
    handle_tdlib_auth_send(move |rt| rt.set_phone(&phone))
}

fn handle_tdlib_check_code(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let code = params
        .get("code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tdlib_check_code: code required".to_string())?
        .to_string();
    handle_tdlib_auth_send(move |rt| rt.check_code(&code))
}

fn handle_tdlib_set_email(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let email = params
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tdlib_set_email: email required".to_string())?
        .to_string();
    handle_tdlib_auth_send(move |rt| rt.set_email_address(&email))
}

fn handle_tdlib_check_email_code(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let code = params
        .get("code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tdlib_check_email_code: code required".to_string())?
        .to_string();
    handle_tdlib_auth_send(move |rt| rt.check_email_code(&code))
}

fn handle_tdlib_check_password(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let password = params
        .get("password")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tdlib_check_password: password required".to_string())?
        .to_string();
    handle_tdlib_auth_send(move |rt| rt.check_password(&password))
}

fn handle_tdlib_resend_code() -> Result<serde_json::Value, String> {
    handle_tdlib_auth_send(|rt| rt.resend_code())
}

fn handle_tdlib_get_my_id() -> Result<serde_json::Value, String> {
    handle_tdlib_auth_send(|rt| rt.get_my_id())
}

fn handle_tdlib_check_auth() -> Result<serde_json::Value, String> {
    handle_tdlib_auth_send(|rt| rt.request_auth_state())
}

// ── M4a3: download ────────────────────────────────────────────────────────────

fn with_runtime<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&TdlibRuntime) -> Result<R, String>,
{
    let guard = tdlib_lock()?;
    let rt = guard
        .as_ref()
        .ok_or_else(|| "TDLib runtime not initialized (tdlib_start_runtime)".to_string())?;
    f(rt)
}

fn handle_dl_get_remote_file(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let remote_file_id = params
        .get("remoteFileId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("remote_file_id").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_get_remote_file: remoteFileId required".to_string())?
        .to_string();
    let chat_id = params.get("chatId").and_then(|v| v.as_i64());
    with_runtime(|rt| download::get_remote_file(rt, &remote_file_id, chat_id))
}

fn handle_dl_get_message_file(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let chat_id = params
        .get("chatId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
        .ok_or_else(|| "tdlib_get_message_file: chatId required".to_string())?;
    let message_id = params
        .get("messageId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("message_id").and_then(|v| v.as_i64()))
        .ok_or_else(|| "tdlib_get_message_file: messageId required".to_string())?;
    // BUG-DOWNLOAD-052: single pm_lease обязан резолвиться ТОЧНО — по стабильному
    // ключу части (`uniqueId` = tg_file_unique_id) и/или размеру. Без них
    // (owner-backdoor/legacy) сохраняем прежнее поведение (getMessage + fallback
    // «самый свежий документ чата»).
    let unique_id = params
        .get("uniqueId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("unique_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let expected_size = params
        .get("expectedSize")
        .and_then(|v| v.as_u64())
        .or_else(|| params.get("expected_size").and_then(|v| v.as_u64()));
    let strict = unique_id.is_some() || expected_size.is_some();
    with_runtime(|rt| {
        if strict {
            download::resolve_pm_part_document(
                rt,
                chat_id,
                Some(message_id),
                unique_id.as_deref(),
                expected_size.unwrap_or(0),
                0,
            )
        } else {
            download::get_message_file(rt, chat_id, message_id)
        }
    })
}

fn handle_dl_start_download(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let file_id = params
        .get("fileId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("file_id").and_then(|v| v.as_i64()))
        .unwrap_or(0) as i32;
    let priority = params.get("priority").and_then(|v| v.as_i64()).unwrap_or(32) as i32;
    let offset = params.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);
    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(0);
    let save_path = params
        .get("savePath")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("save_path").and_then(|v| v.as_str()))
        .map(|s| paths::runtime_path(s));
    let chat_id = params.get("chatId").and_then(|v| v.as_i64());
    let message_id = params.get("messageId").and_then(|v| v.as_i64());
    let started = with_runtime(|rt| {
        download::start_download(
            rt,
            file_id,
            priority,
            offset,
            limit,
            false, // synchronous=false (async updateFile прогресс)
            save_path,
            chat_id,
            message_id,
        )
    })?;
    Ok(serde_json::json!({ "status": "started", "message": started }))
}

/// Клон `Arc<TdlibRuntime>` (нужен фоновому worker-потоку upload).
fn runtime_arc() -> Result<Arc<TdlibRuntime>, String> {
    let guard = tdlib_global().lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| "TDLib runtime not initialized (tdlib_start_runtime)".to_string())
}

// ── M4a4: upload ─────────────────────────────────────────────────────────────

fn handle_upload_start(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let file_path = params
        .get("filePath")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("file_path").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_start_upload: filePath required".to_string())?
        .to_string();
    let file_path = paths::runtime_path(&file_path);
    let chat_id = params
        .get("chatId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
        .ok_or_else(|| "tdlib_start_upload: chatId required".to_string())?;
    let message_thread_id = params
        .get("messageThreadId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("message_thread_id").and_then(|v| v.as_i64()));
    let session_upload_id = params
        .get("sessionUploadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("session_upload_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let pm = params.get("pm").and_then(|v| v.as_bool()).unwrap_or(false);

    let rt = runtime_arc()?;
    let upload_id = upload::start(
        &rt,
        file_path,
        chat_id,
        message_thread_id,
        pm,
        session_upload_id,
    )?;
    Ok(serde_json::json!(upload_id))
}

/// M4a4: multi-part upload (>2GB) — блокирующий, возвращает parts[].
fn handle_upload_start_multi(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let file_path = params
        .get("filePath")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("file_path").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_start_multi_upload: filePath required".to_string())?
        .to_string();
    let file_path = paths::runtime_path(&file_path);
    let chat_id = params
        .get("chatId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
        .ok_or_else(|| "tdlib_start_multi_upload: chatId required".to_string())?;
    let max_part_size = params
        .get("maxPartSize")
        .and_then(|v| v.as_u64())
        .or_else(|| params.get("max_part_size").and_then(|v| v.as_u64()))
        .ok_or_else(|| "tdlib_start_multi_upload: maxPartSize required".to_string())?;
    let message_thread_id = params
        .get("messageThreadId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("message_thread_id").and_then(|v| v.as_i64()));
    let pm = params.get("pm").and_then(|v| v.as_bool()).unwrap_or(false);
    let skip_offsets: Vec<u64> = params
        .get("skipOffsets")
        .or_else(|| params.get("skip_offsets"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
        .unwrap_or_default();
    let session_upload_id = params
        .get("sessionUploadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("session_upload_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let rt = runtime_arc()?;
    upload::start_multi(
        &rt,
        file_path,
        chat_id,
        max_part_size,
        message_thread_id,
        pm,
        skip_offsets,
        session_upload_id,
    )
}

fn handle_upload_wait(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let upload_id = params
        .get("uploadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("upload_id").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_wait_upload: uploadId required".to_string())?
        .to_string();
    // Блокирующее ожидание (mainline: до 2ч).
    upload::wait(&upload_id, std::time::Duration::from_secs(7200))
}

fn handle_upload_cancel(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let upload_id = params
        .get("uploadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("upload_id").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_cancel_upload: uploadId required".to_string())?
        .to_string();
    with_runtime(|rt| upload::cancel(rt, &upload_id))
}

fn handle_clear_cache() -> Result<serde_json::Value, String> {
    with_runtime(|rt| upload::clear_cache(rt))
}

/// M4a3-шаг2: отмена parts-загрузки (multi/vault/composite) по `downloadId`.
///
/// BUG-CANCEL-RESUME-002: mainline-UI шлёт `tdlib_cancel_multi_download`;
/// id в этой ветке уникален на попытку, поэтому отменяется ровно та загрузка,
/// которую видит пользователь.
fn handle_parts_cancel(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let download_id = params
        .get("downloadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("download_id").and_then(|v| v.as_str()))
        .ok_or_else(|| "tdlib_cancel_multi_download: downloadId required".to_string())?
        .to_string();
    with_runtime(|rt| parts_download::cancel(rt, &download_id))
}

/// M4a3-шаг2: старт parts-загрузки (multi/vault/composite).
/// Возвращает строку-подтверждение (как mainline), прогресс — событиями.
fn handle_parts_download(params: &serde_json::Value, mode: &str) -> Result<serde_json::Value, String> {
    let download_id = params
        .get("downloadId")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("download_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("dl_{}", std::process::id()));
    let parts = parts_download::parse_parts(params).map_err(|e| format!("{mode}: {e}"))?;
    let output_path: String = params
        .get("outputPath")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("output_path").and_then(|v| v.as_str()))
        .map(|s| paths::runtime_path(s))
        .ok_or_else(|| format!("{mode}: outputPath required"))?;
    let file_name = params
        .get("fileName")
        .and_then(|v| v.as_str())
        .or_else(|| params.get("file_name").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    let rt = runtime_arc()?;
    let msg = parts_download::start(
        &rt,
        download_id,
        parts,
        output_path,
        file_name,
        parts_download::mode_from_str(mode),
    )?;
    Ok(serde_json::json!(msg))
}

fn handle_dl_cancel_download(params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let file_id = params
        .get("fileId")
        .and_then(|v| v.as_i64())
        .or_else(|| params.get("file_id").and_then(|v| v.as_i64()))
        .unwrap_or(0) as i32;
    with_runtime(|rt| {
        // Parts-загрузка (multi/vault/composite) держит file_id текущей части —
        // UI зовёт отмену именно по file_id, поэтому сначала ищем там.
        if parts_download::cancel_for_file(rt, file_id) {
            return Ok(serde_json::json!({ "status": "cancelled", "file_id": file_id }));
        }
        download::cancel_download(rt, file_id)
    })
}

fn main() {
    download::init();

    // ВАЖНО: stdout — только кадры (никаких println). Каждый кадр — свой lock.
    let stdin = io::stdin();
    let mut reader = FrameReader::new(stdin.lock());

    // Сразу шлём hello-событие (без id — это событие, не ответ). Парсер main
    // на стороне Electron игнорирует сообщения без ожидающего id.
    emit_event("engine.ready", serde_json::json!({ "version": ENGINE_VERSION }));

    while let Some(text) = match reader.next_frame() {
        Ok(Some(t)) => Some(t),
        Ok(None) => None,
        Err(e) => {
            eprintln!("engine-core: read error: {e}");
            None
        }
    } {
        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("engine-core: non-JSON frame ignored: {e}");
                continue;
            }
        };
        let id = parsed.get("id").cloned();
        let method = parsed
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let params = parsed.get("params").cloned().unwrap_or(serde_json::json!({}));

        let result: Result<serde_json::Value, String> = match method.as_str() {
            "ping" => handle_ping(),
            "hash_file" => handle_hash_file(&params),
            // M2: fs/scan/hash/archive (имена совпадают с tauri-командами mainline)
            "get_path_info"
            | "scan_and_hash"
            | "sha256_file"
            | "peek_file_header"
            | "read_file_bytes"
            | "write_file_bytes"
            | "write_file_chunk"
            | "rename_file"
            | "delete_file"
            | "create_archive"
            | "extract_archive"
            // Фаза 3: контейнерные команды (zip | tar.zst) + tar.zst-фасады
            | "pack_archive"
            | "unpack_archive"
            | "create_tar_zst"
            | "extract_tar_zst"
            | "remove_archive"
            | "cleanup_stale_archives" => m2::dispatch(method.as_str(), &params),
            // SP-15 срез 5 (D-071): каталог медиа-кеша карточек — галерея тянет
            // превью/оригинал СВОИМ TDLib и показывает `file://`, значит путь
            // обязан быть известен UI (создаём заранее, чтобы downloadFile не падал).
            "media_cache_dir" => {
                let dir = crate::janitor::media_cache_dir();
                let _ = std::fs::create_dir_all(&dir);
                Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
            }
            // M4a1: TDLib runtime (методы совпадают с tauri-командами mainline)
            "tdlib_start_runtime" => handle_tdlib_start(&params),
            // M4a2: полный сброс авторизации (mainline tdlib_reset_auth)
            "tdlib_reset_auth" => handle_tdlib_reset_auth(),
            // BUG-AUTH-CODE-006: «Выйти» с сохранением каталога (future tokens)
            "tdlib_logout" => handle_tdlib_logout(),
            "tdlib_runtime_status" => handle_tdlib_status(),
            "tdlib_is_ready" => handle_tdlib_is_ready(),
            "tdlib_shutdown" => handle_tdlib_shutdown(),
            // M4a2: auth-команды
            "tdlib_qr_login" => handle_tdlib_qr_login(),
            "tdlib_set_phone" => handle_tdlib_set_phone(&params),
            "tdlib_check_code" => handle_tdlib_check_code(&params),
            "tdlib_set_email" => handle_tdlib_set_email(&params),
            "tdlib_check_email_code" => handle_tdlib_check_email_code(&params),
            "tdlib_check_password" => handle_tdlib_check_password(&params),
            "tdlib_resend_code" => handle_tdlib_resend_code(),
            "tdlib_get_my_id" => handle_tdlib_get_my_id(),
            "tdlib_check_auth" => handle_tdlib_check_auth(),
            // M4a3: download
            "tdlib_get_remote_file" => handle_dl_get_remote_file(&params),
            "tdlib_get_message_file" => handle_dl_get_message_file(&params),
            // M4a3-шаг2: сервисные команды (join/delete/send_bot_start/resolve_private_chat/quiet)
            "tdlib_join_chat"
            | "tdlib_join_chat_by_invite_link"
            | "tdlib_delete_messages"
            | "tdlib_resolve_private_chat"
            | "tdlib_send_bot_start"
            | "tdlib_get_bot_description"
            | "tdlib_quiet_bot_chat" => {
                with_runtime(|rt| misc::dispatch(method.as_str(), rt, &params))
            }
            "tdlib_start_download" => handle_dl_start_download(&params),
            "tdlib_cancel_download" => handle_dl_cancel_download(&params),
            "tdlib_get_downloads" => Ok(download::get_downloads()),
            // M4a3-шаг2: parts-загрузки (multi/vault/composite)
            "tdlib_start_multi_download" => handle_parts_download(&params, "multi"),
            "tdlib_start_vault_self_download" => handle_parts_download(&params, "vault"),
            "tdlib_start_composite_download" => handle_parts_download(&params, "composite"),
            // BUG-CANCEL-RESUME-002: отмена parts-загрузки по downloadId
            "tdlib_cancel_multi_download" => handle_parts_cancel(&params),
            // M4a4: upload
            "tdlib_start_upload" => handle_upload_start(&params),
            "tdlib_start_multi_upload" => handle_upload_start_multi(&params),
            "tdlib_wait_upload" => handle_upload_wait(&params),
            "tdlib_cancel_upload" => handle_upload_cancel(&params),
            "tdlib_clear_cache" => handle_clear_cache(),
            other => Err(format!("unknown method: {other}")),
        };

        // Ответ шлём только на запросы с id (корреляция по id).
        if let Some(id) = id {
            let frame = match result {
                Ok(value) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": value }),
                Err(message) => serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32000, "message": message }
                }),
            };
            write_stdout(&frame);
        } else if let Err(e) = result {
            eprintln!("engine-core: event-handler error for {method}: {e}");
        }
    }
    eprintln!("engine-core: stdin closed, exiting");
}

// ─────────────────────────────────────────────────────────────────────────────
// Тест: доказывает, что firmware-core реально слинкован и что quiet-реализация
// даёт тот же sha256, что firmware_core::hash::sha256_file.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_hash_matches_firmware_core() {
        // Временный файл с известным содержимым.
        let dir = std::env::temp_dir().join("engine-core-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("sample.bin");
        std::fs::write(&file_path, b"FW CLOUD sidecar M0 sample\n").unwrap();

        // 1) firmware-core (mainline-крейт, реально слинкован и вызывается):
        let fc_hash = firmware_core::hash::sha256_file(&file_path).unwrap();

        // 2) наша тихая реализация:
        let quiet_hash = quiet_sha256_file(&file_path).unwrap();

        assert_eq!(fc_hash, quiet_hash, "quiet sha256 должен совпадать с firmware-core");

        let _ = std::fs::remove_file(&file_path);
    }

    #[test]
    fn ping_returns_health() {
        let v = handle_ping().unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["engine"], "engine-core");
        // get_path_info на собственном exe сработал → firmware-core слинкован.
        assert_eq!(v["firmware_core_linked"], true);
    }

    /// Регрессия QR-flow: `tdlib_is_ready` обязан отдавать ГОЛЫЙ boolean
    /// (mainline-сигнатура `-> bool`). Объект `{"ready":..}` всегда truthy и
    /// ломает QR-поллинг (преждевременный pairing → 401).
    #[test]
    fn tdlib_is_ready_returns_bare_boolean() {
        let v = handle_tdlib_is_ready().unwrap();
        assert!(v.is_boolean(), "tdlib_is_ready должен вернуть boolean, получено: {v}");
        // Runtime не запущен — false.
        assert_eq!(v, serde_json::json!(false));
        assert_eq!(handle_tdlib_status().unwrap()["running"], serde_json::json!(false));
    }

    /// BUG-AUTH-CODE-006 (future-auth-token): `tdlib_logout` обязан быть
    /// доступен UI и вести себя как reset_auth по контракту ошибок — при
    /// неинициализированном runtime — Err (не паника).
    #[test]
    fn tdlib_logout_requires_runtime() {
        // Runtime не запущен (тестовый процесс) — logout обязан вернуть Err.
        let err = handle_tdlib_logout().unwrap_err();
        assert!(
            err.contains("not initialized"),
            "ожидалась ошибка «runtime not initialized», получено: {err}"
        );
    }

    #[test]
    fn frame_reader_multiple_frames_one_chunk() {
        // Два кадра подряд в одном чанке — читатель не должен терять второй.
        fn frame(method: &str, id: u32) -> Vec<u8> {
            let payload = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{{}}}}"#);
            let mut v = (payload.len() as u32).to_be_bytes().to_vec();
            v.extend_from_slice(payload.as_bytes());
            v
        }
        let mut all = frame("ping", 1);
        all.extend(frame("ping", 2));

        let cursor = io::Cursor::new(all);
        let mut fr = FrameReader::new(cursor);
        let f1 = fr.next_frame().unwrap().expect("first frame");
        let f2 = fr.next_frame().unwrap().expect("second frame");
        assert!(f1.contains("\"id\":1"), "first frame: {f1}");
        assert!(f2.contains("\"id\":2"), "second frame: {f2}");
        assert!(fr.next_frame().unwrap().is_none(), "EOF после двух кадров");
    }
}
