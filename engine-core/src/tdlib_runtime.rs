//! M4a1 — TDLib JSON runtime в sidecar (без Tauri/WebView).
//!
//! Минимальный жизненный цикл TDLib из mainline tdlib_json.rs/tdlib_event_loop.rs:
//! FFI-клиент (create/send/receive/destroy), честная инициализация
//! (setLogVerbosityLevel, setTdlibParameters), фоновый receive-loop в отдельном
//! std::thread, проброс состояния авторизации как потоковых событий
//! `tdlib-auth-state` / `tdlib-connection-state` (кадры без id в stdout).
//!
//! Здесь НЕ перенесены: auth-команды (qr/phone/code/2FA) — M4a2, download —
//! M4a3, upload — M4a4. M4a1 доказывает: libtdjson работает из sidecar и
//! события доходят до renderer.
//!
//! Потокобезопасность TDLib: send можно звать из любого потока, receive — из
//! одного. Мы не держим Mutex во время receive (1с таймаут): копируем указатель
//! под коротким lock, затем receive без lock. Mutex защищает лишь от destroy
//! под send/receive.

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// ── FFI libtdjson ─────────────────────────────────────────────────────────────

#[repr(C)]
struct TdJsonClient {
    _private: [u8; 0],
}

extern "C" {
    fn td_json_client_create() -> *mut TdJsonClient;
    fn td_json_client_send(client: *mut TdJsonClient, request: *const c_char);
    fn td_json_client_receive(client: *mut TdJsonClient, timeout: f64) -> *const c_char;
    fn td_json_client_destroy(client: *mut TdJsonClient);
    // Логирование TDLib — ГЛОБАЛЬНЫЕ функции, вызывать ДО td_json_client_create.
    // BUG-AUTH-CODE-001: без файлового лога «код по телефону не приходит» ничем не
    // отличается от «Telegram ответил ошибкой» — точный ответ виден только здесь.
    fn td_set_log_file_path(file_path: *const c_char) -> c_int;
    fn td_set_log_max_file_size(max_file_size: i64);
    fn td_set_log_verbosity_level(verbosity_level: c_int);
}

/// Нормализовать путь лога для TDLib.
///
/// Под wine (Windows-таргет sidecar на Linux-хосте, стенд `e2e-prod32.sh`)
/// POSIX-путь `/home/...` для Windows-бинарника невалиден: wine монтирует корень
/// ФС в `Z:` → `/home/...` превращаем в `Z:\home\...`. На реальной Windows путь
/// с ведущим `/` невалиден и так, поэтому правило безопасно.
fn normalize_log_path_for(path: &str, windows: bool) -> String {
    let p = path.trim();
    if windows && p.starts_with('/') {
        let tail = p.trim_start_matches('/').replace('/', "\\");
        return format!("Z:\\{tail}");
    }
    p.to_string()
}

/// Настройки файлового лога TDLib: `(path, verbosity)`.
///
/// `FW_TDLIB_LOG_PATH` — путь к логу (задаёт Electron main: `<userData>/logs/tdlib.log`);
/// `FW_TDLIB_LOG_LEVEL` — 0..5 (по умолчанию 3 = info: видны ответы Telegram и ошибки).
/// Без пути логирование в файл выключено (поведение как раньше — stderr).
fn tdlib_log_settings(
    log_path: Option<String>,
    log_level: Option<String>,
) -> Option<(String, i32)> {
    let path = log_path?.trim().to_string();
    if path.is_empty() {
        return None;
    }
    let level = log_level
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|l| (0..=5).contains(l))
        .unwrap_or(3);
    Some((path, level))
}

/// Включить файловый лог TDLib по env-настройкам (см. `tdlib_log_settings`).
///
/// Возвращает уровень, на котором лог включён (`Some(level)`), либо `None`,
/// если файлового лога нет (не задан `FW_TDLIB_LOG_PATH`). Уровень нужен
/// вызывающему: RPC `setLogVerbosityLevel` не имеет права опускаться ниже него
/// (BUG-AUTH-CODE-003, см. `rpc_verbosity_level`).
fn configure_tdlib_logging() -> Option<i32> {
    let Some((raw_path, level)) = tdlib_log_settings(
        std::env::var("FW_TDLIB_LOG_PATH").ok(),
        std::env::var("FW_TDLIB_LOG_LEVEL").ok(),
    ) else {
        return None;
    };
    let path = normalize_log_path_for(&raw_path, cfg!(target_os = "windows"));
    match CString::new(path.clone()) {
        Ok(c_path) => unsafe {
            td_set_log_max_file_size(5 * 1024 * 1024);
            td_set_log_verbosity_level(level);
            td_set_log_file_path(c_path.as_ptr());
            eprintln!("engine-core[tdlib]: tdlib log file enabled → {path} (verbosity={level})");
        },
        Err(_) => {
            eprintln!(
                "engine-core[tdlib]: FW_TDLIB_LOG_PATH содержит NUL — файловый лог выключен"
            );
            return None;
        }
    }
    Some(level)
}

/// Уровень для RPC `setLogVerbosityLevel` сразу после создания клиента.
///
/// ВАЖНО (BUG-AUTH-CODE-003): этот RPC понижает verbosity ВСЕМ логгерам TDLib —
/// включая файловый диагностический (проверено на живом логе: после RPC в
/// `tdlib.log` оставалась только «шапка» инициализации клиента, ни одного
/// состояния авторизации). Поэтому при включённом файловом логе держим уровень
/// равным уровню лога (`FW_TDLIB_LOG_LEVEL`, по умолчанию 3 = info): только тогда
/// в лог попадает ответ Telegram — `sentCodeType`, `PHONE_CODE_*`,
/// `connectionState`, ошибки RPC. Без файлового лога оставляем ERROR (1), чтобы
/// DEBUG/INFO не заливали stderr. Объём файла ограничен
/// `td_set_log_max_file_size` (5 МБ) + штатная ротация TDLib.
fn rpc_verbosity_level(file_log_level: Option<i32>) -> i32 {
    file_log_level.unwrap_or(1)
}

/// Колбэк события из receive-loop (вызывается в фоновом потоке receive).
/// Пишет кадр события в stdout (общий writer сериализует через stdout lock).
pub type EventCb = Box<dyn Fn(&str, Value) + Send>;

// ── Пути состояния (R-4: отдельно от mainline `~/.tdlib/{api_id}`) ───────────

/// Корневой каталог состояния TDLib этого клиента.
///
/// Осознанно ОТДЕЛЬНЫЙ от mainline (`~/.tdlib/{api_id}`), чтобы Electron- и
/// Tauri-версии не делили БД и не конфликтовали сессиями.
pub fn state_root_dir(api_id: i32) -> PathBuf {
    #[cfg(target_os = "windows")]
    let home = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());

    PathBuf::from(home)
        .join(".tdlib")
        .join("firmware-desktop-electron")
        .join(api_id.to_string())
}

/// Каталог TDLib-файлов (кеш скачанного/загружаемого) — публичный доступ для
/// `tdlib_clear_cache`. ВАЖНО: это НЕ каталог БД (её чистить нельзя — снесёт сессию).
pub fn files_dir() -> String {
    TdlibRuntime::tdlib_files_dir()
}

/// Рекурсивно удалить файлы кеша в `dirs` (best-effort).
///
/// BUG-UX-001: TDLib раскладывает скачанные сегменты по ВЛОЖЕННЫМ подкаталогам
/// (`documents/4220_0.part`, `temp/_b8631f`), а старая `clear_cache` чистила только
/// корень `files_dir()` (`is_file()` в `read_dir`) → подкаталоги переживали очистку
/// и диск утекал (стенд: 8.8 ГБ). Возвращает число удалённых файлов.
/// Каталоги и БД не трогаем (только файлы; сессия TDLib в `state_root_dir` — табу).
pub fn purge_cache_dirs(dirs: &[String]) -> usize {
    let mut removed = 0usize;
    for dir in dirs {
        let root = std::path::Path::new(dir);
        let Ok(rd) = std::fs::read_dir(root) else {
            continue;
        };
        let mut stack: Vec<std::path::PathBuf> =
            rd.flatten().map(|e| e.path()).collect();
        while let Some(path) = stack.pop() {
            if path.is_dir() {
                if let Ok(rd) = std::fs::read_dir(&path) {
                    stack.extend(rd.flatten().map(|e| e.path()));
                }
                continue;
            }
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Post-download чистка кеша (глобальный выбор пользователя).
///
/// Вызывается ПОСЛЕ КАЖДОГО УСПЕШНОГО задания: чистит `files_dir()` рекурсивно
/// (включая вложенные `documents/*.part` и `temp/*`). Вызов — в точке, где итог
/// уже собран (склейка/перемещение завершены), поэтому страшного сноса «ещё не
/// влитых частей» нет: воркер к этому моменту из кеш-файлов уже ничего не читает.
/// Возвращает число удалённых файлов.
///
/// ⚠️ Только файловая чистка, БЕЗ `cleanFileDatabase`/`send_and_wait`: вызывается
/// из воркера и receive-потока, где блокирующий `send_and_wait` даст дедлок
/// (единственный потребитель `td_json_client_receive` — receive-loop).
pub fn post_download_purge() -> usize {
    let removed = purge_cache_dirs(&[files_dir()]);
    if removed > 0 {
        eprintln!("engine-core[tdlib]: post-download purge removed {removed} cache files");
    }
    removed
}

/// Удалить состояние TDLib (зеркало mainline `cleanup_tdlib_state`).
/// true — каталог существовал и удалён.
pub fn cleanup_state_dir(api_id: i32) -> bool {
    let dir = state_root_dir(api_id);
    if !dir.exists() {
        return false;
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("engine-core[tdlib]: cleanup_state_dir {dir:?} failed: {e}");
            false
        }
    }
}

// ── Состояние runtime ─────────────────────────────────────────────────────────

pub struct TdlibRuntime {
    client: Arc<Mutex<*mut TdJsonClient>>,
    /// Креды, с которыми поднят runtime (нужны для `tdlib_reset_auth`).
    api_id: i32,
    api_hash: String,
    bot_token: String,
    running: Arc<AtomicBool>,
    /// TDLib вышел в «рабочее» состояние авторизации (не WaitTdlibParameters /
    /// WaitEncryptionKey). Нужно, чтобы не отдавать управление фронтенду раньше
    /// времени: TDLib МОЛЧА игнорирует `requestQrCodeAuthentication` вне
    /// `authorizationStateWaitPhoneNumber` (проверено на 1.8.65 — ни события,
    /// ни ошибки), из-за чего клик по QR «пропадает».
    ui_state_ready: Arc<AtomicBool>,
    /// Последнее сырое TDLib-состояние авторизации (напр.
    /// `authorizationStateWaitPhoneNumber`) — для `tdlib_runtime_status
    /// .authorization_state` (контракт mainline RuntimeStatus).
    last_state: Mutex<String>,
    /// Handle фонового receive-loop: join при shutdown, чтобы `Drop` не вызвал
    /// `td_json_client_destroy` во время активного `td_json_client_receive`
    /// (иначе use-after-free).
    receiver: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Авторизация TDLib завершена (`authorizationStateReady`) — НЕ «runtime жив».
    /// Критично для паритета с mainline: команда `tdlib_is_ready() -> bool`
    /// означает «авторизован» ([`tdlib_event_loop.rs:656`] = `r.ready`), а не
    /// «receive-loop запущен». UI использует это в QR-поллинге
    /// ([`TdlibAuthPage.startQrPoll`]): при `true` он немедленно запускает
    /// API-pairing (`tdlib_get_my_id`), который до реальной авторизации падает
    /// с 401 Unauthorized и ломает вход по QR-коду.
    auth_ready: Arc<AtomicBool>,
    /// future-токены входа (BUG-AUTH-CODE-008): TDLib сохраняет их в option
    /// `authentication_token` после каждого успешного входа и после auth.logOut
    /// (core.telegram.org/api/auth#future-auth-tokens), переигрывает наружу как
    /// updateOption при старте, но САМ в setAuthenticationPhoneNumber не
    /// подставляет — клиент обязан вернуть их в `authentication_tokens`.
    /// Новейшие первыми, максимум 20 (лимит сервера). Значения НЕ логируем.
    auth_tokens: Mutex<Vec<String>>,
    /// Корреляция ответов по @extra: extra → канал ответа (M4a3+ download/upload).
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
}

// TDLib JSON client потокобезопасен для send() из любого потока (внутренний
// lock), а receive() вызывается только из одного выделенного потока. Указатель
// защищён Mutex'ом от destroy под send/receive. Как в mainline tdlib_json.rs
// (unsafe impl Send for TdlibJsonClientInner).
unsafe impl Send for TdlibRuntime {}
unsafe impl Sync for TdlibRuntime {}

impl Drop for TdlibRuntime {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        let mut guard = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let c = *guard;
        if !c.is_null() {
            unsafe { td_json_client_destroy(c) };
            *guard = std::ptr::null_mut();
        }
    }
}

// ── Версия TDLib → формат setTdlibParameters ─────────────────────────────────

/// Разобрать «1.8.65» → (1, 8, 65). Хвост (суффиксы вида `-rc1`, `+vendor`)
/// отбрасывается; меньше трёх чисел — добиваем нулями («1.8» → (1, 8, 0)).
fn parse_version3(s: &str) -> Option<(u32, u32, u32)> {
    let numeric: String = s
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut it = numeric.split('.').filter(|p| !p.is_empty());
    let major = it.next()?.parse::<u32>().ok()?;
    let minor = it.next().map(|p| p.parse::<u32>().unwrap_or(0)).unwrap_or(0);
    let patch = it.next().map(|p| p.parse::<u32>().unwrap_or(0)).unwrap_or(0);
    Some((major, minor, patch))
}

/// true → `setTdlibParameters` шлём FLAT (поля напрямую), false → через
/// вложенный `parameters` (@type tdlibParameters).
///
/// Граница — TDLib 1.8.65: в нём поля подняты на верхний уровень, поля
/// `enable_storage_optimizer`/`ignore_file_names` удалены. Неизвестная версия
/// трактуется как 1.8.65+ (текущая линия; так же ведёт себя mainline-клиент).
pub fn params_are_flat(version: Option<&str>) -> bool {
    match version.and_then(parse_version3) {
        Some(v) => v >= (1, 8, 65),
        None => true,
    }
}

/// Собрать payload `setAuthenticationPhoneNumber` с desktop CodeSettings:
/// SIM-specific optional delivery flags выключены, поскольку приложение работает
/// на компьютере. Telegram самостоятельно выбирает фактический канал доставки.
///
/// `auth_tokens` — сохранённые future-токены (BUG-AUTH-CODE-008): официальная
/// альтернатива коду. TDLib сам НЕ подставляет их (cli.cpp держит список из
/// updateOption и передаёт сам) — если они есть и не протухли, сервер возвращает
/// вход БЕЗ кода (sentCodeSuccess / SESSION_PASSWORD_NEEDED при 2FA).
fn build_phone_auth_settings(phone: &str, auth_tokens: &[String]) -> Value {
    json!({
        "@type": "setAuthenticationPhoneNumber",
        "@extra": "set_phone",
        "phone_number": phone,
        "settings": {
            "@type": "phoneNumberAuthenticationSettings",
            "allow_flash_call": false,
            "allow_missed_call": false,
            "is_current_phone_number": false,
            "has_unknown_phone_number": false,
            "allow_sms_retriever_api": false,
            "authentication_tokens": auth_tokens
        }
    })
}

/// Сколько ждать «рабочее» состояние авторизации перед auth-командой.
///
/// Холодный старт TDLib идёт `setTdlibParameters` → `waitEncryptionKey` →
/// `waitPhoneNumber`, и на слабой машине это заметно дольше одного тика.
/// Ранняя отправка `setAuthenticationPhoneNumber` даёт
/// `400 Call to setAuthenticationPhoneNumber unexpected` (живой репорт
/// владельца 2026-10-31), поэтому ждём так же, как QR.
const AUTH_STATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Техническая инициализация TDLib: состояние сменится САМО, поэтому его имеет
/// смысл ждать. Любое другое состояние (`waitCode`, `ready`, `closed`, …) уже
/// определилось — отказ нужно отдавать сразу, а не через таймаут.
fn is_bootstrap_state(state: &str) -> bool {
    matches!(
        state,
        "" | "authorizationStateWaitTdlibParameters" | "authorizationStateWaitEncryptionKey"
    )
}

/// Состояния авторизации, в которых TDLib ЖДЁТ ввод номера телефона.
/// `setAuthenticationPhoneNumber` принимается ТОЛЬКО здесь; в любом другом
/// состоянии ответ — `400 Call to setAuthenticationPhoneNumber unexpected`.
fn is_phone_login_state(state: &str) -> bool {
    state == "authorizationStateWaitPhoneNumber"
}

/// Типизированный отказ вместо сырого 400 от TDLib.
///
/// `None` — состояние подходит, запрос можно отправлять. Иначе — машинный код,
/// который UI переводит в человеческий текст и приводит экран к фактическому
/// шагу входа:
///   `PHONE_AUTH_NOT_READY`           — TDLib ещё в технической инициализации;
///   `PHONE_AUTH_IN_PROGRESS:<state>` — уже идёт шаг входа (код/2FA/QR/email);
///   `PHONE_AUTH_ALREADY_AUTHORIZED`  — TDLib уже Ready.
fn phone_auth_state_error(state: &str) -> Option<String> {
    if is_phone_login_state(state) {
        return None;
    }
    let code = match state {
        "authorizationStateReady" => "PHONE_AUTH_ALREADY_AUTHORIZED".to_string(),
        "authorizationStateWaitCode" => "PHONE_AUTH_IN_PROGRESS:wait_code".to_string(),
        "authorizationStateWaitPassword" => "PHONE_AUTH_IN_PROGRESS:wait_password".to_string(),
        "authorizationStateWaitEmailAddress" => {
            "PHONE_AUTH_IN_PROGRESS:wait_email_address".to_string()
        }
        "authorizationStateWaitEmailCode" => "PHONE_AUTH_IN_PROGRESS:wait_email_code".to_string(),
        // QR-ожидание приходит и как WaitOtherDeviceConfirmation, и как WaitQrCode
        // (последний — в прямом ответе getAuthorizationState).
        "authorizationStateWaitOtherDeviceConfirmation" | "authorizationStateWaitQrCode" => {
            "PHONE_AUTH_IN_PROGRESS:wait_other_device".to_string()
        }
        "authorizationStateWaitRegistration" => {
            "PHONE_AUTH_IN_PROGRESS:wait_registration".to_string()
        }
        _ => "PHONE_AUTH_NOT_READY".to_string(),
    };
    Some(code)
}

/// То же для email-ветки: `setAuthenticationEmailAddress` валиден только в
/// `authorizationStateWaitEmailAddress` (иначе тот же `400 ... unexpected`).
fn email_auth_state_error(state: &str) -> Option<String> {
    match state {
        "authorizationStateWaitEmailAddress" => None,
        "authorizationStateReady" => Some("EMAIL_AUTH_ALREADY_AUTHORIZED".to_string()),
        _ => Some("EMAIL_AUTH_NOT_READY".to_string()),
    }
}

/// Захват future-токена из `updateOption { name: "authentication_token" }`
/// (BUG-AUTH-CODE-008).
///
/// Откуда берётся токен: TDLib сохраняет `future_auth_token` после КАЖДОГО
/// успешного входа (auth.authorization) и после auth.logOut — официальная
/// механика core.telegram.org/api/auth#future-auth-tokens. Опция НЕ внутренняя
/// (OptionManager переигрывает её наружу при старте runtime из персистентной
/// config-DB), поэтому достаточно слушать updateOption в receive-loop.
///
/// Возвращает true, если данное обновление — наш токен (независимо от того,
/// изменился ли список). Невалидные варианты (чужие updateOption, пустая строка,
/// optionValueEmpty, не-строка) игнорируются. Новые токены — в начало списка
/// (новейшие первыми, как в эталоне tdcli cli.cpp), максимум 20 (лимит сервера).
fn capture_authentication_token(tokens: &mut Vec<String>, val: &Value) -> bool {
    if val["@type"].as_str() != Some("updateOption")
        || val["name"].as_str() != Some("authentication_token")
    {
        return false;
    }
    let v = &val["value"];
    if v["@type"].as_str() != Some("optionValueString") {
        return false;
    }
    let tok = v["value"].as_str().unwrap_or("");
    if tok.is_empty() {
        return false;
    }
    let tok = tok.to_string();
    // Дедуп: TDLib хранит ОДНУ option (каждый вход/логаут перезаписывает),
    // но повтор одного и того же токена не должен расти в списке.
    tokens.retain(|t| t != &tok);
    tokens.insert(0, tok);
    tokens.truncate(20);
    true
}

/// Собрать JSON `setTdlibParameters` в формате конкретной версии TDLib.
///
/// `flat = true` (≥1.8.65): поля на верхнем уровне, `session_count` (×8
/// множитель ResourceManager → до 16 МБ на download-конвейер).
/// `flat = false` (≤1.8.64): вложенный `parameters` (`@type tdlibParameters`),
/// `enable_storage_optimizer`, без `session_count`.
///
/// Общее для обоих форматов: `system_version` пустая → TDLib сам подставляет
/// реальную ОС (анти-фингерпринт, см. mainline BUG-AUTH-010), `device_model`
/// заполнен всегда (пустой → ошибка 400).
fn build_tdlib_parameters(
    flat: bool,
    api_id: i32,
    api_hash: &str,
    database_directory: &str,
    device_model: &str,
) -> Value {
    let files_directory = TdlibRuntime::tdlib_files_dir();
    if flat {
        json!({
            "@type": "setTdlibParameters",
            "@extra": "set_tdlib_params",
            "use_test_dc": false,
            "database_directory": database_directory,
            "files_directory": files_directory,
            "database_encryption_key": "",
            "use_file_database": false,
            "use_chat_info_database": false,
            "use_message_database": true,
            "use_secret_chats": false,
            "session_count": 2,
            "api_id": api_id,
            "api_hash": api_hash,
            "system_language_code": "en",
            "device_model": device_model,
            "system_version": "",
            "application_version": "4.16.2"
        })
    } else {
        json!({
            "@type": "setTdlibParameters",
            "@extra": "set_tdlib_params",
            "parameters": {
                "@type": "tdlibParameters",
                "use_test_dc": false,
                "database_directory": database_directory,
                "files_directory": files_directory,
                "database_encryption_key": "",
                "use_file_database": false,
                "use_chat_info_database": false,
                "use_message_database": true,
                "use_secret_chats": false,
                "api_id": api_id,
                "api_hash": api_hash,
                "system_language_code": "en",
                "device_model": device_model,
                "system_version": "",
                "application_version": "4.16.2",
                // BUG-STORAGE-OPT-001: `false` — согласованно с `setOption
                // use_storage_optimizer=false` из `build_max_bandwidth_requests`
                // (pre-auth). Раньше было `true`: для i686 (TDLib 1.8.61, nested)
                // setTdlibParameters перезаписывал pre-auth `false` → фоновый GC
                // файлового кеша включался вопреки намерению (x64/1.8.65 flat не
                // имел поля вовсе, поэтому рассинхрон был только на i686).
                "enable_storage_optimizer": false,
                "ignore_file_names": false
            }
        })
    }
}

impl TdlibRuntime {
    /// Создать клиент, настроить и запустить receive-loop.
    pub fn start(
        api_id: i32,
        api_hash: &str,
        bot_token: &str,
        on_event: EventCb,
        initial_auth_tokens: Vec<String>,
    ) -> Result<Arc<Self>, String> {
        // Файловый лог TDLib (BUG-AUTH-CODE-001) — строго ДО создания клиента.
        // Уровень лога возвращается, чтобы RPC ниже его не понизил.
        let file_log_level = configure_tdlib_logging();

        let client = unsafe { td_json_client_create() };
        if client.is_null() {
            return Err("td_json_client_create() failed (libtdjson?)".into());
        }

        let rt = Arc::new(TdlibRuntime {
            client: Arc::new(Mutex::new(client)),
            api_id,
            api_hash: api_hash.to_string(),
            bot_token: bot_token.to_string(),
            running: Arc::new(AtomicBool::new(true)),
            ui_state_ready: Arc::new(AtomicBool::new(false)),
            last_state: Mutex::new(String::new()),
            receiver: Mutex::new(None),
            auth_ready: Arc::new(AtomicBool::new(false)),
            auth_tokens: Mutex::new(initial_auth_tokens),
            pending: Arc::new(Mutex::new(HashMap::new())),
        });

        // setLogVerbosityLevel: без файлового лога — ERROR (1), без DEBUG/INFO flood;
        // с файловым логом — его уровень, иначе RPC глушит саму диагностику
        // (BUG-AUTH-CODE-003: в логе оставалась только «шапка» клиента).
        rt.send_value(json!({
            "@type": "setLogVerbosityLevel",
            "new_verbosity_level": rpc_verbosity_level(file_log_level)
        }))?;

        // ── MAX BANDWIDTH (перенос из mainline tdlib_json.rs::set_max_bandwidth) ──
        // RCA 2026-09-18 (UPLOAD-SPEED-4X): в electron-порту вызов отсутствовал —
        // TDLib не знал тип сети (auto-set NetType::Other через ~1с), не включал
        // quick-ACK пайплайнинг и тратил время на PFS/IPv6-timeout/статистику.
        // Объективно на проде: 983 МБ за 282с (3.5 МБ/с) vs 10-12.6 МБ/с в
        // mainline-эпоху (09-11/09-16) — регрессия ~3-4x. Порядок и состав
        // запросов — 1-в-1 из mainline (pre-auth, до setTdlibParameters).
        for req in build_max_bandwidth_requests() {
            rt.send_value(req)?;
        }
        eprintln!("engine-core[tdlib]: set_max_bandwidth sent (setNetworkType=WiFi + use_pfs/prefer_ipv6/use_quick_ack/disable_network_statistics/use_storage_optimizer)");


        // ── Формат setTdlibParameters зависит от версии TDLib ─────────────
        // 1.8.65+ принимает поля НАПРЯМУЮ (FLAT), ≤1.8.64 — через вложенный
        // объект "parameters" (@type tdlibParameters). Ошибка формата НЕ даёт
        // ошибки: TDLib молча подставляет пустые значения (api_id=0,
        // database_directory="") и авторизация не идёт вовсе.
        // В бандлах проекта версии РАЗНЫЕ: windows-x64 = 1.8.65,
        // windows-x86 = 1.8.61 (см. engine-core/tdlib/*/VERSION), поэтому
        // версия определяется в рантайме (getOption "version"), а build-time
        // значение из бандла — только fallback, если опрос не удался.
        let tdlib_version = rt.detect_tdlib_version();
        let flat_params = params_are_flat(tdlib_version.as_deref());
        eprintln!(
            "engine-core[tdlib]: tdlib_version={} setTdlibParameters={}",
            tdlib_version.as_deref().unwrap_or("unknown"),
            if flat_params { "FLAT (1.8.65+)" } else { "nested (<=1.8.64)" }
        );

        // setTdlibParameters — честные параметры реальной системы.
        let db_path = Self::tdlib_db_path(api_id, bot_token);
        let device_model = format!("PC {}", std::env::consts::ARCH);
        let params = build_tdlib_parameters(flat_params, api_id, api_hash, &db_path, &device_model);
        rt.send_value(params)?;

        // setOption language_pack (анти-Silent-Drop, как mainline).
        // ПАРИТЕТ с mainline tdlib_json.rs::new — ДВА setOption. Без
        // `localization_target` MtprotoHeader уходит с пустым `lang_pack` в
        // initConnection → антифрод молча отбрасывает запрос кода (Silent Drop,
        // «код не приходит»): гейт language_pack_preinit_sends_localization_target_first.
        rt.send_value(json!({
            "@type": "setOption", "name": "localization_target",
            "value": {"@type": "optionValueString", "value": "tdesktop"}
        }))?;
        rt.send_value(json!({
            "@type": "setOption", "name": "language_pack_id",
            "value": {"@type": "optionValueString", "value": "en"}
        }))?;
        eprintln!("engine-core[tdlib]: language_pack pre-init sent (localization_target=tdesktop + language_pack_id=en)");

        // Запрос начального состояния авторизации.
        rt.send_value(json!({"@type": "getAuthorizationState", "@extra": "get_auth_state"}))?;

        // Фоновый receive-loop (единственный поток receive).
        let handle = {
            let rt2 = Arc::clone(&rt);
            std::thread::spawn(move || {
                rt2.receive_loop(on_event);
            })
        };
        *rt.receiver.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);

        // Паритет с mainline (`tdlib_auth.rs` — «waiting for first auth state
        // signal»): не отдаём управление фронтенду, пока TDLib не вышел в
        // рабочее состояние. Иначе ранние команды (в первую очередь QR) TDLib
        // молча игнорирует, и UI навсегда висит на «Генерація QR-коду...».
        if !rt.wait_ui_state(Duration::from_secs(30)) {
            eprintln!(
                "engine-core[tdlib]: рабочий auth-state не получен за 30с (нет сети?) — продолжаем"
            );
        }

        Ok(rt)
    }

    /// Отправить JSON в TDLib (короткий lock только на send).
    pub fn send_value(&self, value: Value) -> Result<(), String> {
        let json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        let c_str = CString::new(json).map_err(|e| e.to_string())?;
        let guard = self.client.lock().unwrap_or_else(|e| e.into_inner());
        let c = *guard;
        if c.is_null() {
            return Err("TDLib client is null (destroyed)".into());
        }
        unsafe { td_json_client_send(c, c_str.as_ptr()) };
        Ok(())
    }

    /// Прочитать одно сообщение TDLib синхронно (timeout в секундах).
    ///
    /// ВАЖНО: единственный потребитель `td_json_client_receive` — этот вызов
    /// допустим ТОЛЬКО до старта receive-loop (в нём receive уходит в отдельный
    /// поток; TDLib не поддерживает двух потребителей).
    fn receive_raw(&self, timeout: f64) -> Option<String> {
        let c = *self.client.lock().unwrap_or_else(|e| e.into_inner());
        if c.is_null() {
            return None;
        }
        let ptr = unsafe { td_json_client_receive(c, timeout) };
        if ptr.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().to_string())
    }

    /// Версия TDLib в рантайме: `getOption("version")`.
    ///
    /// TDLib отвечает на этот опрос локально (без сети), поэтому обычно версия
    /// доступна сразу после create(). Ответ приходит в `value.value`. Все прочие
    /// сообщения (в т.ч. ранние update'ы) игнорируются и НЕ теряются для UI —
    /// receive-loop стартует позже и получит остальную очередь сам.
    fn detect_tdlib_version(&self) -> Option<String> {
        const EXTRA: &str = "engine_core_tdlib_version";
        let req = json!({"@type": "getOption", "name": "version", "@extra": EXTRA});
        if self.send_value(req).is_err() {
            return None;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let Some(raw) = self.receive_raw(0.5) else {
                continue;
            };
            let Ok(val) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if val["@extra"].as_str() != Some(EXTRA) {
                continue;
            }
            return val["value"]["value"].as_str().map(str::to_string);
        }
        // Fallback: версия бандла, зафиксированная на сборке (build.rs →
        // engine-core/tdlib/<arch>/VERSION). Именно она уезжает в релиз.
        let bundle = env!("TDLIB_BUNDLE_VERSION");
        eprintln!(
            "engine-core[tdlib]: getOption(\"version\") did not answer within 10s; \
             falling back to bundled TDLib version {bundle}"
        );
        if bundle == "unknown" {
            None
        } else {
            Some(bundle.to_string())
        }
    }

    // ── M4a3: корреляция ответов по @extra (download/upload) ──────────────

    /// Зарегистрировать ожидание ответа по @extra. Возвращает Receiver.
    fn register_wait(&self, extra: &str) -> Result<mpsc::Receiver<Value>, String> {
        let (tx, rx) = mpsc::channel::<Value>();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(extra.to_string(), tx);
        Ok(rx)
    }

    /// Снять ожидание по `@extra`.
    ///
    /// Ответы приходят через `dispatch_to_pending` (запись удаляется там), но
    /// при таймауте/обрыве запись оставалась «зомби»: поздний ответ «съедался»
    /// мёртвым каналом, а карта `pending` росла. Вызываем всегда — idempotent.
    fn forget_wait(&self, extra: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(extra);
    }

    /// Отправить запрос и вернуть «сырой» ответ по @extra, НЕ превращая
    /// `@type=error` в Err.
    ///
    /// Нужен там, где ошибка TDLib — ожидаемая ветка: owner-backdoor download
    /// резолвит delivery-сообщение по bot-side message_id, а у клиента в PM
    /// другой id-диапазон → getMessage отвечает Not Found, и это не сбой, а
    /// сигнал идти в историю чата (паритет с mainline
    /// `_resolve_latest_document_in_chat`).
    pub fn send_and_wait_raw(&self, value: Value, timeout: Duration) -> Result<Value, String> {
        let extra = value["@extra"]
            .as_str()
            .ok_or_else(|| "send_and_wait_raw: @extra required".to_string())?
            .to_string();
        let rx = self.register_wait(&extra)?;
        self.send_value(value)?;
        let out = rx.recv_timeout(timeout);
        // При таймауте запись в `pending` осталась бы «зомби» (поздний ответ
        // чужой попытки перехватывался бы мёртвым каналом). При успехе запись
        // уже снята `dispatch_to_pending` — вызов просто идемпотентен.
        self.forget_wait(&extra);
        out.map_err(|e| format!("TDLib timeout waiting @extra={extra}: {e}"))
    }

    /// Отправить запрос и дождаться ответа по @extra (корреляция).
    ///
    /// Блокирует текущий поток до ответа/таймаута. Для команд, которые UI
    /// ожидает синхронно (getRemoteFile, getMessageFile и т.п.).
    /// Ошибка TDLib (`@type=error`) нормализуется в `Err`.
    pub fn send_and_wait(&self, value: Value, timeout: Duration) -> Result<Value, String> {
        let v = self.send_and_wait_raw(value, timeout)?;
        if v["@type"].as_str() == Some("error") {
            let msg = v["message"].as_str().unwrap_or("TDLib error").to_string();
            let code = v["code"].as_i64().unwrap_or(0);
            Err(format!("TDLib error {code}: {msg}"))
        } else {
            Ok(v)
        }
    }

    /// Как `send_and_wait`, но пока ждём ответ, раз в `poll_interval` зовёт
    /// `poll()`; `Some(reason)` → немедленный `Err(reason)` (ответ при этом уже
    /// не ждём, запись из `pending` снимается).
    ///
    /// Зачем: `downloadFile{synchronous:true}` после обрыва сети может не
    /// ответить и не слать `updateFile` — без опроса поток «висит» до таймаута
    /// (у download-частей это `PART_TIMEOUT` = 6ч). Watchdog BUG-DOWNLOAD-049
    /// использует это, чтобы прервать запрос и пере-качать часть.
    pub fn send_and_wait_polling<F>(
        &self,
        value: Value,
        timeout: Duration,
        poll_interval: Duration,
        mut poll: F,
    ) -> Result<Value, String>
    where
        F: FnMut() -> Option<String>,
    {
        let extra = value["@extra"]
            .as_str()
            .ok_or_else(|| "send_and_wait_polling: @extra required".to_string())?
            .to_string();
        let rx = self.register_wait(&extra)?;
        self.send_value(value)?;

        let deadline = Instant::now() + timeout;
        let raw = loop {
            if let Some(reason) = poll() {
                break Err(reason);
            }
            let now = Instant::now();
            if now >= deadline {
                break Err(format!("TDLib timeout waiting @extra={extra}"));
            }
            // Спим не дольше остатка дедлайна и не дольше интервала опроса.
            let slice = poll_interval.min(deadline - now);
            match rx.recv_timeout(slice) {
                Ok(v) => break Ok(v),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(format!("TDLib wait @extra={extra}: channel closed"))
                }
            }
        };
        // Ответ приходит через `dispatch_to_pending` (запись снимается там);
        // при выходе по `poll`/таймауту подчищаем сами (утечка + «зомби»).
        self.forget_wait(&extra);

        let v = raw?;
        if v["@type"].as_str() == Some("error") {
            let msg = v["message"].as_str().unwrap_or("TDLib error").to_string();
            let code = v["code"].as_i64().unwrap_or(0);
            Err(format!("TDLib error {code}: {msg}"))
        } else {
            Ok(v)
        }
    }

    /// Раздать полученное сообщение ожидающему по @extra (из receive-loop).
    /// Возвращает true, если сообщение было ответом (потреблено).
    fn dispatch_to_pending(&self, val: &Value) -> bool {
        let extra = val["@extra"].as_str().unwrap_or("").to_string();
        if extra.is_empty() {
            return false;
        }
        // Ответы: auth-extra обрабатываются событиями в dispatch_update, а НЕ
        // pending-каналом, чтобы сохранить единый путь событий для auth.
        // Здесь отвечаем только на «запросные» extra (созданные send_and_wait).
        let type_name = val["@type"].as_str().unwrap_or("").to_string();
        // Диагностика: логируем потребление updateFile/updateMessageSendSucceeded
        // с @extra. Для send сюда попадает ответ sendMessage и/или сам
        // updateMessageSendSucceeded — без этой строки не видно, кто «съел»
        // кадр и почему upload::on_update_message_send_succeeded не вызвался
        // (BUG-UPLOAD-019: молчаливый висяк upload).
        if type_name == "updateFile" {
            eprintln!(
                "engine-core[dispatch]: updateFile consumed by pending extra=\"{extra}\" file_id={}",
                val["file"]["id"].as_i64().unwrap_or(0)
            );
        } else if type_name == "updateMessageSendSucceeded" {
            eprintln!(
                "engine-core[dispatch]: updateMessageSendSucceeded consumed by pending extra=\"{extra}\" msg_id={}",
                val["message"]["id"].as_i64().unwrap_or(0)
            );
        }
        let tx = {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            match map.remove(&extra) {
                Some(tx) => tx,
                None => return false,
            }
        };
        let _ = tx.send(val.clone());
        true
    }

    // ── M4a2: auth-команды (fire-and-forget; результат — через события) ──────

    /// Запрос login token для QR-входа и внутреннего MTP handoff.
    /// TDLib принимает запрос только в `authorizationStateWaitPhoneNumber`;
    /// остальные рабочие состояния (например, WaitCode/Ready) недостаточны.
    pub fn request_qr_login(&self) -> Result<(), String> {
        let state = self.wait_for_state(Self::is_qr_login_state, AUTH_STATE_TIMEOUT);
        if !Self::is_qr_login_state(&state) {
            return Err(format!(
                "QR: TDLib login token requires authorizationStateWaitPhoneNumber (current: {state})"
            ));
        }
        self.send_value(json!({
            "@type": "requestQrCodeAuthentication",
            "@extra": "qr_login",
            "other_user_ids": []
        }))
    }

    /// Дождаться состояния авторизации, в котором TDLib примет команду.
    ///
    /// Возвращает ФАКТИЧЕСКОЕ состояние — принятое предикатом, уже определившееся
    /// (ждать нечего) либо последнее увиденное по таймауту. Решение об отказе
    /// принимает вызывающий: только он знает машинный код для UI.
    fn wait_for_state(&self, accept: fn(&str) -> bool, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        loop {
            let state = self.last_state();
            if accept(&state) || !is_bootstrap_state(&state) || Instant::now() >= deadline {
                return state;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Дождаться «рабочего» состояния авторизации (см. `ui_state_ready`).
    pub fn wait_ui_state(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.ui_state_ready.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.ui_state_ready.load(Ordering::SeqCst)
    }

    /// Состояние, из которого UI может слать команды (не техническая инициализация).
    fn is_ui_ready_state(state: &str) -> bool {
        !matches!(
            state,
            "" | "authorizationStateWaitTdlibParameters" | "authorizationStateWaitEncryptionKey"
        )
    }

    fn is_qr_login_state(state: &str) -> bool {
        state == "authorizationStateWaitPhoneNumber"
    }

    /// Телефон: setAuthenticationPhoneNumber. Payload собирает
    /// `build_phone_auth_settings()` — desktop CodeSettings без SIM-specific
    /// missed-call/unknown-number delivery options.
    ///
    /// Состояние проверяется ДО отправки. Живой репорт владельца (2026-10-31):
    /// экран «🔑 Авторизация Telegram» показывал
    /// `Ошибка (set_phone): Call to setAuthenticationPhoneNumber unexpected (код 400)`
    /// — TDLib принимает запрос ТОЛЬКО в `authorizationStateWaitPhoneNumber`, а
    /// клиент слал его в любом состоянии (например, после отмены QR или после
    /// запроса кода). Теперь ждём рабочее состояние (как QR), а при чужом шаге
    /// отдаём машинный код — UI переводит его в человеческий текст и сам
    /// приводит экран к фактическому шагу.
    ///
    /// Сюда же уходят сохранённые future-токены (BUG-AUTH-CODE-008): если сервер
    /// их принимает — вход завершается БЕЗ кода (sentCodeSuccess; при 2FA сразу
    /// SESSION_PASSWORD_NEEDED). Невалидные/протухшие токены fail-open: сервер
    /// просто выбирает обычный канал кода.
    pub fn set_phone(&self, phone: &str) -> Result<(), String> {
        let state = self.wait_for_state(is_phone_login_state, AUTH_STATE_TIMEOUT);
        if let Some(err) = phone_auth_state_error(&state) {
            eprintln!(
                "engine-core[auth]: set_phone отклонён локально — TDLib в состоянии \"{state}\" ({err}); 400 unexpected не отправляем"
            );
            return Err(err);
        }
        let auth_tokens = self
            .auth_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !auth_tokens.is_empty() {
            // Значения токенов не логируем — только количество.
            eprintln!(
                "engine-core[auth]: set_phone с {} future-токеном(ами) — возможен вход без кода",
                auth_tokens.len()
            );
        }
        self.send_value(build_phone_auth_settings(phone, &auth_tokens))
    }

    /// Код: checkAuthenticationCode.
    pub fn check_code(&self, code: &str) -> Result<(), String> {
        self.send_value(json!({
            "@type": "checkAuthenticationCode",
            "@extra": "check_code",
            "code": code
        }))
    }

    /// Email auth: TDLib sends a code to the address supplied for this attempt.
    ///
    /// `setAuthenticationEmailAddress` валиден только в
    /// `authorizationStateWaitEmailAddress`; в другом состоянии TDLib отвечает
    /// `400 ... unexpected`, и мастер видит техотчёт вместо шага входа.
    pub fn set_email_address(&self, email: &str) -> Result<(), String> {
        let state = self.wait_for_state(
            |s| s == "authorizationStateWaitEmailAddress",
            AUTH_STATE_TIMEOUT,
        );
        if let Some(err) = email_auth_state_error(&state) {
            eprintln!(
                "engine-core[auth]: set_email_address отклонён локально — TDLib в состоянии \"{state}\" ({err})"
            );
            return Err(err);
        }
        self.send_value(json!({
            "@type": "setAuthenticationEmailAddress",
            "@extra": "set_email_address",
            "email_address": email
        }))
    }

    /// Email auth code. The code is sent only to TDLib and is never logged here.
    pub fn check_email_code(&self, code: &str) -> Result<(), String> {
        self.send_value(json!({
            "@type": "checkAuthenticationEmailCode",
            "@extra": "check_email_code",
            "code": {
                "@type": "emailAddressAuthenticationCode",
                "code": code
            }
        }))
    }

    /// 2FA-пароль: checkAuthenticationPassword.
    pub fn check_password(&self, password: &str) -> Result<(), String> {
        self.send_value(json!({
            "@type": "checkAuthenticationPassword",
            "@extra": "check_password",
            "password": password
        }))
    }

    /// Переслать код: resendAuthenticationCode.
    pub fn resend_code(&self) -> Result<(), String> {
        self.send_value(json!({
            "@type": "resendAuthenticationCode",
            "@extra": "resend_code"
        }))
    }

    /// Получить текущего юзера (getMe) → событие tdlib-my-id.
    pub fn get_my_id(&self) -> Result<(), String> {
        self.send_value(json!({
            "@type": "getMe",
            "@extra": "tdlib_get_my_id"
        }))
    }

    /// Запросить текущий auth state (check_auth) → событие tdlib-auth-state.
    pub fn request_auth_state(&self) -> Result<(), String> {
        self.send_value(json!({
            "@type": "getAuthorizationState",
            "@extra": "get_auth_state"
        }))
    }

    /// Фоновый receive-loop.
    fn receive_loop(&self, on_event: EventCb) {
        while self.running.load(Ordering::SeqCst) {
            // Копируем указатель под коротким lock, receive — без lock.
            let c = *self.client.lock().unwrap_or_else(|e| e.into_inner());
            if c.is_null() {
                break;
            }
            let ptr = unsafe { td_json_client_receive(c, 1.0) };
            if ptr.is_null() {
                continue;
            }
            let s = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().to_string();
            let val: Value = match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Диагностика: updateFile логируется только при завершении ЗАГРУЗКИ
            // (каждое событие приходит по 512 КБ → шум в stderr). Одного флага
            // `is_uploading_completed` мало: у СКАЧИВАЕМОГО файла он всегда true
            // (файл уже лежит на сервере), поэтому для файлов активных загрузок
            // диагностику глушим по file_id (BUG-RCA-SPAM-001: живой прогон дал
            // 5714 строк / 2.4 МБ на две загрузки).
            if val["@type"].as_str() == Some("updateFile")
                && val["file"]["remote"]["is_uploading_completed"]
                    .as_bool()
                    .unwrap_or(false)
                && crate::upload::should_log_completed_update(
                    val["file"]["id"].as_i64().unwrap_or(0) as i32,
                    val["file"]["remote"]["id"].as_str().unwrap_or(""),
                )
            {
                eprintln!(
                    "engine-core[recv]: updateFile COMPLETED file_id={} remote.id=\"{}\"",
                    val["file"]["id"].as_i64().unwrap_or(0),
                    val["file"]["remote"]["id"].as_str().unwrap_or("")
                );
            }
            // Если это ответ на send_and_wait (есть ожидающий по @extra) —
            // потребляем и НЕ эмитим как событие.
            if self.dispatch_to_pending(&val) {
                continue;
            }
            self.dispatch_update(&val, &on_event);
            // M4a3: updateFile → прогресс/завершение download.
            // M4a4: тот же updateFile несёт прогресс upload.
            if val["@type"].as_str() == Some("updateFile") {
                crate::download::on_update_file(&val);
                crate::upload::on_update_file(&val);
                crate::parts_download::on_update_file(&val);
            }
            // Паритет с Tauri handle_send_succeeded: реальный message_id и
            // tg_file_id приходят в updateMessageSendSucceeded (прямой ответ
            // sendMessage несёт промежуточный id).
            if val["@type"].as_str() == Some("updateMessageSendSucceeded") {
                crate::upload::on_update_message_send_succeeded(&val);
            }
        }
    }

    /// Разобрать обновление/ответ и сэмитить события (зеркало mainline receive-loop).
    ///
    /// Заодно ведёт `auth_ready` (единственный источник правды для `tdlib_is_ready`).
    fn dispatch_update(&self, val: &Value, on_event: &EventCb) {
        let type_name = val["@type"].as_str().unwrap_or("").to_string();
        let extra = val["@extra"].as_str().unwrap_or("").to_string();

        // Ошибка TDLib → tdlib-auth-error {extra, message, code} (как mainline).
        if type_name == "error" {
            let raw_msg = val["message"].as_str().unwrap_or("TDLib error");
            // Error text for email auth may echo user input. Keep the stable
            // TDLib error code, but never forward that text into app/sidecar logs.
            let msg = if matches!(extra.as_str(), "set_email_address" | "check_email_code") {
                "EMAIL_AUTH_ERROR".to_string()
            } else {
                raw_msg.to_string()
            };
            let code = val["code"].as_i64().unwrap_or(0);
            let payload = json!({ "extra": extra, "message": msg, "code": code });
            on_event("tdlib-auth-error", payload);
            return;
        }

        // Ответ getMe (@extra=tdlib_get_my_id, @type=user) → tdlib-my-id.
        if extra == "tdlib_get_my_id" && type_name == "user" {
            let tg_id = val["id"].as_i64().unwrap_or(0);
            let first_name = val["first_name"].as_str().unwrap_or("").to_string();
            let last_name = val["last_name"].as_str().unwrap_or("").to_string();
            let username = val["username"].as_str().unwrap_or("").to_string();
            on_event("tdlib-my-id", json!({
                "tg_id": tg_id,
                "first_name": first_name,
                "last_name": last_name,
                "username": username,
            }));
            return;
        }

        // Обновление состояния авторизации.
        if type_name == "updateAuthorizationState" {
            let auth = &val["authorization_state"];
            let st = auth["@type"].as_str().unwrap_or("").to_string();
            // Любой переход авторизации обновляет готовность: `true` только Ready.
            self.auth_ready
                .store(st == "authorizationStateReady", Ordering::SeqCst);
            *self.last_state.lock().unwrap_or_else(|e| e.into_inner()) = st.clone();
            // Вышли из технической инициализации — UI можно работать (в т.ч. QR).
            if Self::is_ui_ready_state(&st) {
                self.ui_state_ready.store(true, Ordering::SeqCst);
            }
            let payload = match st.as_str() {
                "authorizationStateReady" => json!({ "status": "ready" }),
                "authorizationStateWaitPhoneNumber" => json!({ "status": "wait_phone" }),
                "authorizationStateWaitCode" => {
                    // Восстанавливаем code_type из authorization_state (как mainline).
                    let code_type = auth["code_info"]["type"]["@type"]
                        .as_str()
                        .unwrap_or("authenticationCodeTypeTelegramMessage")
                        .to_string();
                    let next_code_type = auth["code_info"]["next_type"]["@type"].as_str();
                    let timeout = auth["code_info"]["timeout"].as_i64().unwrap_or(0);
                    json!({
                        "status": "wait_code",
                        "code_type": code_type,
                        "next_code_type": next_code_type,
                        "timeout": timeout
                    })
                }
                "authorizationStateWaitEmailAddress" => json!({
                    "status": "wait_email_address",
                    "allow_apple_id": auth["allow_apple_id"].as_bool().unwrap_or(false),
                    "allow_google_id": auth["allow_google_id"].as_bool().unwrap_or(false)
                }),
                "authorizationStateWaitEmailCode" => json!({
                    "status": "wait_email_code",
                    "email_address_pattern": auth["code_info"]["email_address_pattern"].as_str().unwrap_or(""),
                    "code_length": auth["code_info"]["length"].as_i64().unwrap_or(0),
                    "allow_apple_id": auth["allow_apple_id"].as_bool().unwrap_or(false),
                    "allow_google_id": auth["allow_google_id"].as_bool().unwrap_or(false)
                }),
                "authorizationStateWaitPassword" => {
                    let hint = auth["password_hint"].as_str().unwrap_or("").to_string();
                    json!({ "status": "wait_password", "hint": hint })
                }
                "authorizationStateWaitOtherDeviceConfirmation" | "authorizationStateWaitQrCode" => {
                    let link = auth["link"].as_str().unwrap_or("").to_string();
                    json!({ "status": "qr_link", "link": link })
                }
                "authorizationStateClosed" => json!({ "status": "closed" }),
                other => json!({ "status": other }),
            };
            on_event("tdlib-auth-state", payload);
            return;
        }

        // Прямой ответ getAuthorizationState (@extra=get_auth_state) — маппинг в
        // canonical-статусы фронтенда (зеркало mainline tdlib_event_loop.rs).
        if extra == "get_auth_state" {
            // Прямой ответ getAuthorizationState тоже несёт факт авторизации.
            self.auth_ready
                .store(type_name == "authorizationStateReady", Ordering::SeqCst);
            *self.last_state.lock().unwrap_or_else(|e| e.into_inner()) = type_name.clone();
            if Self::is_ui_ready_state(&type_name) {
                self.ui_state_ready.store(true, Ordering::SeqCst);
            }
            let payload = match type_name.as_str() {
                "authorizationStateReady" => json!({ "status": "ready" }),
                "authorizationStateWaitPhoneNumber" => json!({ "status": "wait_phone" }),
                "authorizationStateWaitCode" => json!({
                    "status": "wait_code",
                    "code_type": val["code_info"]["type"]["@type"].as_str(),
                    "next_code_type": val["code_info"]["next_type"]["@type"].as_str(),
                    "timeout": val["code_info"]["timeout"].as_i64().unwrap_or(0)
                }),
                "authorizationStateWaitEmailAddress" => json!({
                    "status": "wait_email_address",
                    "allow_apple_id": val["allow_apple_id"].as_bool().unwrap_or(false),
                    "allow_google_id": val["allow_google_id"].as_bool().unwrap_or(false)
                }),
                "authorizationStateWaitEmailCode" => json!({
                    "status": "wait_email_code",
                    "email_address_pattern": val["code_info"]["email_address_pattern"].as_str().unwrap_or(""),
                    "code_length": val["code_info"]["length"].as_i64().unwrap_or(0),
                    "allow_apple_id": val["allow_apple_id"].as_bool().unwrap_or(false),
                    "allow_google_id": val["allow_google_id"].as_bool().unwrap_or(false)
                }),
                "authorizationStateWaitPassword" => json!({ "status": "wait_password" }),
                "authorizationStateWaitOtherDeviceConfirmation" | "authorizationStateWaitQrCode" => {
                    let link = val["link"].as_str().unwrap_or("").to_string();
                    json!({ "status": "qr_link", "link": link })
                }
                "authorizationStateClosed" => json!({ "status": "closed" }),
                _ => {
                    let state = type_name
                        .strip_prefix("authorizationState")
                        .unwrap_or(&type_name)
                        .to_lowercase();
                    json!({ "status": state })
                }
            };
            on_event("tdlib-auth-state", payload);
            return;
        }

        if type_name == "updateConnectionState" {
            let cs = val["state"]["@type"].as_str().unwrap_or("connectionStateConnecting").to_string();
            on_event("tdlib-connection-state", json!({ "state": cs }));
            return;
        }

        // BUG-AUTH-CODE-008: future-токены входа. TDLib сохраняет их в option
        // `authentication_token` (после каждого успешного входа и после
        // auth.logOut) и переигрывает этот updateOption наружу при старте —
        // клиент обязан вернуть токены в setAuthenticationPhoneNumber, иначе
        // официальный вход БЕЗ кода (core.telegram.org/api/auth#future-auth-tokens)
        // не включается. Значения не логируем (секретоподобные base64url).
        if type_name == "updateOption" {
            let mut toks = self
                .auth_tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if capture_authentication_token(&mut toks, val) {
                eprintln!(
                    "engine-core[auth]: future-токен сохранён (всего {}) — следующий вход по номеру может пройти без кода",
                    toks.len()
                );
            }
            return;
        }

        // Прочие обновления — не интересны фронтенду.
        if type_name.starts_with("update") {
            // не логируем каждое (шумно): только некоторые диагностические
            if type_name == "updateAuthorizationState" || type_name.starts_with("updateChat") {
                eprintln!("engine-core[tdlib]: {type_name} (unhandled)");
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Последнее сырое состояние авторизации (для контракта RuntimeStatus).
    pub fn last_state(&self) -> String {
        self.last_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Дождаться ЛОКАЛЬНОГО завершения логаута (BUG-AUTH-LOGOUT-QR-001).
    ///
    /// Официальный контракт TDLib (td_api.tl → logOut): «Closes the TDLib
    /// instance after a proper logout. All local data will be destroyed.
    /// After the logout completes, updateAuthorizationState with
    /// authorizationStateClosed will be sent». Ответ `ok` на logOut — это
    /// только отзыв сессии НА СЕРВЕРЕ; дальше TDLib асинхронно уничтожает
    /// ключи и локальную БД. Убить runtime до `authorizationStateClosed` —
    /// оставить БД в `authorizationStateLoggingOut`: следующий клиент
    /// продолжит логаут («Destroy all databases» в живом tdlib.log,
    /// 2026-11-10 22:18:58) и отдаст `Closed` вместо `WaitPhoneNumber` —
    /// QR на экране входа мёртв. Возвращает true, если Closed дождались.
    pub fn wait_authorization_closed(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.last_state() == "authorizationStateClosed" {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.last_state() == "authorizationStateClosed"
    }

    /// Свежий runtime дошёл до «рабочего» состояния (не bootstrap, не Closed).
    ///
    /// Страховка после логаута: если БД всё же осталась в
    /// `authorizationStateLoggingOut`, свежий клиент продолжит логаут
    /// (уничтожит БД) и отдаст `authorizationStateClosed`. Тогда вызывающий
    /// обязан пересоздать клиент — каталог после дестроя чист и следующий
    /// старт даёт `WaitPhoneNumber`. Таймаут НЕ считается закрытием
    /// (fail-open: медленный старт ≠ мёртвый клиент). false только при
    /// явном `authorizationStateClosed`.
    pub fn wait_not_closed_after_start(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let state = self.last_state();
            if state == "authorizationStateClosed" {
                return false;
            }
            if !is_bootstrap_state(&state) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        true
    }

    /// Авторизован ли TDLib (`authorizationStateReady`).
    ///
    /// Паритет с mainline `tdlib_is_ready() -> bool` (tdlib_event_loop.rs:656).
    /// НЕ путать с `is_running()` (жив ли receive-loop).
    pub fn is_ready(&self) -> bool {
        self.auth_ready.load(Ordering::SeqCst)
    }

    pub fn shutdown(&self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.send_value(json!({"@type": "close"}));
        // Дожидаемся выхода receive-loop (receive-таймаут 1с) ДО destroy клиента.
        // Важно: join НЕ в Drop — если receive-loop сам держит последний Arc,
        // join из Drop (на этом же потоке) дал бы самодедлок.
        if let Some(h) = self.receiver.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = h.join();
        }
    }

    /// Future-токены входа, накопленные этим runtime (BUG-AUTH-CODE-008).
    ///
    /// Нужны при пересоздании сессии после выхода: TDLib отдаёт токен через
    /// updateOption, а в новой сессии (новый каталог) он не переигрывается —
    /// переносим вручную, чтобы вход по номеру остался мгновенным.
    pub fn auth_tokens(&self) -> Vec<String> {
        self.auth_tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Креды runtime — нужны `tdlib_reset_auth`, чтобы поднять клиент заново.
    pub fn config(&self) -> (i32, String, String) {
        (self.api_id, self.api_hash.clone(), self.bot_token.clone())
    }

    // ── Пути (как в mainline tdlib_json.rs, но userData отдельный — R-4) ─────

    fn tdlib_db_path(api_id: i32, bot_token: &str) -> String {
        let suffix = if bot_token.is_empty() {
            "user".to_string()
        } else {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bot_token.hash(&mut h);
            format!("bot_{:x}", h.finish())
        };
        // BUG-AUTH-LOGOUT-QR-001 (2026-11-10): каталог сессии НЕ МЕНЯЕМ —
        // future-auth-token лежит именно здесь, и после выхода он даёт вход
        // по номеру без кода. Проблема выхода решается на уровне ПРОЦЕССА
        // (пересоздание sidecar в electron/main.ts): общий TDLib-инстанс
        // закрытого клиента в этом процессе держит состояние «closed».
        let path = state_root_dir(api_id).join(suffix);
        let _ = std::fs::create_dir_all(&path);
        path.to_string_lossy().to_string()
    }

    fn tdlib_files_dir() -> String {
        #[cfg(target_os = "windows")]
        {
            let base = std::env::var("LOCALAPPDATA")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            let path = PathBuf::from(base).join("firmware-desktop-electron").join("tdlib_files");
            let _ = std::fs::create_dir_all(&path);
            return path.to_string_lossy().to_string();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let path = PathBuf::from("/tmp/tdlib_files_electron");
            let _ = std::fs::create_dir_all(&path);
            path.to_string_lossy().to_string()
        }
    }
}

// ── MAX BANDWIDTH (перенос из mainline tdlib_json.rs::set_max_bandwidth) ─────
//
// Набор pre-auth запросов для режима максимальной пропускной способности.
// Порядок и состав — 1-в-1 из mainline (TDLib 1.8.x source analysis):
// 1. setNetworkType=WiFi — немедленная маркировка сети доступной
//    (Session::network_flag_); без него TDLib ждёт ~1с (StateManager
//    on_network_soft) и auto-set'ит NetType::Other.
// 2. use_pfs=false — быстрее MTProto handshake (NetQueryDispatcher.cpp:368).
// 3. prefer_ipv6=false — перезаписывает persisted true (иначе зависание на
//    битом IPv6, 8-16с на попытку).
// 4. use_quick_ack=true — MTProto-пайплайнинг: сервер шлёт quick ACK (id
//    сообщения) без полного ответа → следующий чанк уходит сразу
//    (MessagesManager.cpp:1241, Session.cpp:1154).
// 5. disable_network_statistics=true — не создаёт NetStatsManager (меньше
//    CPU; опция проверяется до его создания → обязана быть pre-auth).
// 6. use_storage_optimizer=false — отключает фоновый GC файлового кэша.
//
// RCA 2026-09-18 (UPLOAD-SPEED-4X): в electron-порту этот блок отсутствовал,
// что дало объективную деградацию upload ~3-4x (983 МБ за 282с = 3.5 МБ/с
// против 10-12.6 МБ/с в mainline-эпоху — desktop_upload_jobs).
pub fn build_max_bandwidth_requests() -> Vec<Value> {
    vec![
        json!({
            "@type": "setNetworkType",
            "type": { "@type": "networkTypeWiFi" }
        }),
        json!({
            "@type": "setOption", "name": "use_pfs",
            "value": { "@type": "optionValueBoolean", "value": false }
        }),
        json!({
            "@type": "setOption", "name": "prefer_ipv6",
            "value": { "@type": "optionValueBoolean", "value": false }
        }),
        json!({
            "@type": "setOption", "name": "use_quick_ack",
            "value": { "@type": "optionValueBoolean", "value": true }
        }),
        json!({
            "@type": "setOption", "name": "disable_network_statistics",
            "value": { "@type": "optionValueBoolean", "value": true }
        }),
        json!({
            "@type": "setOption", "name": "use_storage_optimizer",
            "value": { "@type": "optionValueBoolean", "value": false }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BUG-AUTH-CODE-001: под wine POSIX-путь лога должен стать `Z:\...`,
    /// иначе Windows-сайдкар не откроет файл (стенд e2e-prod32.sh).
    #[test]
    fn normalize_log_path_for_wine_and_windows() {
        assert_eq!(
            normalize_log_path_for("/home/mega/x/tdlib.log", true),
            "Z:\\home\\mega\\x\\tdlib.log"
        );
        assert_eq!(
            normalize_log_path_for(r"C:\Users\x\tdlib.log", true),
            r"C:\Users\x\tdlib.log"
        );
        // Linux-хост: путь не трогаем
        assert_eq!(
            normalize_log_path_for("/home/mega/x/tdlib.log", false),
            "/home/mega/x/tdlib.log"
        );
        assert_eq!(normalize_log_path_for("  /a/b.log  ", false), "/a/b.log");
    }

    /// BUG-UX-001: auto-purge срабатывает ПОСЛЕ КАЖДОГО успешного задания — из
    /// точки, где итог уже собран (склейка/перемещение завершены), поэтому
    /// чистить безопасно: воркер из кеш-файлов уже ничего не читает.
    /// Глобальный выбор пользователя (оба вызова чистят — без no-op).
    #[test]
    fn purge_runs_after_every_successful_job() {
        // Контракт: чистка НЕ одноразовая — после каждого успеха чистим снова
        // (глобальный выбор пользователя; второй вызов обязан тоже забрать файл).
        for tag in ["job-a", "job-b"] {
            let root = std::env::temp_dir().join(format!("engine-core-purge-{tag}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("documents")).unwrap();
            std::fs::write(root.join("documents").join("4220_0.part"), b"PART").unwrap();
            let removed =
                purge_cache_dirs(&[root.to_string_lossy().to_string()]);
            assert_eq!(removed, 1, "{tag}: чистка обязана сработать, а не быть no-op");
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// BUG-UX-001: рекурсивная очистка гнезда кеша.
    /// Вложенный `documents/4220_0.part` (1–2 ГБ каждый, скачанные части multi)
    /// переживал `clear_cache` → диск утекал (стенд: 8.8 ГБ).
    #[test]
    fn clear_cache_removes_nested_documents_recursively() {
        let root = std::env::temp_dir().join("engine-core-cache-red");
        let _ = std::fs::remove_dir_all(&root);
        let docs = root.join("documents");
        let temp = root.join("temp");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(docs.join("4220_0.part"), b"PART0").unwrap();
        std::fs::write(temp.join("_b8631f"), b"TMP").unwrap();
        std::fs::write(root.join("stray.bin"), b"X").unwrap();

        let removed = purge_cache_dirs(&[root.to_string_lossy().to_string()]);

        assert_eq!(
            removed, 3,
            "очистка обязана забирать вложенные documents/*.part и temp/* (сейчас: 1)"
        );
        assert!(
            std::fs::read_dir(&docs).unwrap().next().is_none(),
            "documents/ обязан остаться пустым"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// BUG-AUTH-CODE-001: без пути файловый лог выключен; уровень ограничен 0..5
    /// (default 3 = info), мусор не включает verbose случайно.
    #[test]
    fn tdlib_log_settings_contract() {
        assert_eq!(tdlib_log_settings(None, None), None);
        assert_eq!(tdlib_log_settings(Some("   ".into()), None), None);
        assert_eq!(
            tdlib_log_settings(Some("/tmp/tdlib.log".into()), None),
            Some(("/tmp/tdlib.log".to_string(), 3))
        );
        assert_eq!(
            tdlib_log_settings(Some("/tmp/tdlib.log".into()), Some(" 5 ".into())),
            Some(("/tmp/tdlib.log".to_string(), 5))
        );
        assert_eq!(
            tdlib_log_settings(Some("/tmp/tdlib.log".into()), Some("9".into())),
            Some(("/tmp/tdlib.log".to_string(), 3))
        );
        assert_eq!(
            tdlib_log_settings(Some("/tmp/tdlib.log".into()), Some("abc".into())),
            Some(("/tmp/tdlib.log".to_string(), 3))
        );
    }

    /// Гейт BUG-AUTH-CODE-003: RPC `setLogVerbosityLevel` понижает уровень ВСЕМ
    /// логгерам TDLib (включая файловый диагностический), поэтому он НЕ имеет
    /// права быть захардкоженным на ERROR (1): иначе в `tdlib.log` остаётся
    /// только «шапка» инициализации клиента, а ответ Telegram (`sentCodeType`,
    /// `PHONE_CODE_*`, `connectionState`) не пишется НИКОГДА — живой инцидент
    /// «код не приходит» снова окажется без улик по построению.
    #[test]
    fn rpc_verbosity_does_not_silence_file_log() {
        const SRC: &str = include_str!("tdlib_runtime.rs");
        assert!(
            !SRC.contains("\"new_verbosity_level\": 1"),
            "уровень RPC setLogVerbosityLevel захардкожен на ERROR — файловый лог \
             ослепнет; уровень обязан браться из rpc_verbosity_level(...)"
        );
        assert!(
            SRC.contains("rpc_verbosity_level("),
            "RPC setLogVerbosityLevel обязан звать rpc_verbosity_level(...), \
             чтобы файловый лог диагностики сохранял уровень"
        );
    }

    /// Контракт уровня RPC: файловый лог задаёт уровень (иначе он ослепнет),
    /// без файлового лога — ERROR (1), как раньше.
    #[test]
    fn rpc_verbosity_level_contract() {
        assert_eq!(rpc_verbosity_level(None), 1, "без файлового лога — ERROR");
        assert_eq!(rpc_verbosity_level(Some(3)), 3, "default FW_TDLIB_LOG_LEVEL=info");
        assert_eq!(rpc_verbosity_level(Some(5)), 5, "оператор может поднять до verbose");
        assert_eq!(rpc_verbosity_level(Some(0)), 0, "явный fatal тоже допустим");
    }

    /// Гейт BUG-AUTH-CODE-005: метод `report*CodeMissing` нельзя звать из
    /// стороннего приложения. Официальная схема TDLib: «Reports that
    /// authentication code wasn't delivered via SMS; **for official mobile
    /// applications only**», параметр — `mobile_network_code` (BUG-AUTH-CODE-004
    /// слал `phone_number`, то есть кнопка «пусть придёт SMS» не могла работать
    /// вовсе). Канал доставки выбирает Telegram, а не клиент.
    #[test]
    fn report_authentication_code_missing_is_not_used() {
        const SRC: &str = include_str!("tdlib_runtime.rs");
        let forbidden = ["reportAuthentication", "CodeMissing"].concat();
        assert!(
            !SRC.contains(&forbidden),
            "{} — «for official mobile applications only»; сторонний клиент не выбирает канал",
            forbidden
        );
    }

    /// Гейт регрессии UPLOAD-SPEED-4X: блок max-bandwidth обязан содержать все
    /// 6 запросов в порядке mainline (setNetworkType первым). Без него TDLib
    /// не знает тип сети и режет пропускную способность upload в разы.
    #[test]
    fn max_bandwidth_requests_match_mainline() {
        let reqs = build_max_bandwidth_requests();
        assert_eq!(reqs.len(), 6, "состав блока изменился — сверь с mainline tdlib_json.rs::set_max_bandwidth");
        assert_eq!(reqs[0]["@type"], "setNetworkType");
        assert_eq!(reqs[0]["type"]["@type"], "networkTypeWiFi");
        let opts: Vec<&str> = reqs[1..]
            .iter()
            .map(|r| r["name"].as_str().expect("setOption name"))
            .collect();
        assert_eq!(
            opts,
            ["use_pfs", "prefer_ipv6", "use_quick_ack", "disable_network_statistics", "use_storage_optimizer"]
        );
        assert_eq!(reqs[3]["value"]["value"], true, "use_quick_ack обязан быть true (пайплайнинг)");
        assert_eq!(reqs[1]["value"]["value"], false);
    }

    /// Гейт Silent Drop (mainline BUG-AUTH-009, этап AUTH 2.0): pre-init сосед
    /// `localization_target="tdesktop"` ОБЯЗАН ставиться вместе с
    /// `language_pack_id="en"`. Без него MtprotoHeader уходит в set_phone /
    /// help.getConfig с пустым language_pack — initConnection отдаёт
    /// `lang_pack=""`, и антифрод молча отбрасывает запрос кода.
    /// (Паритет с mainline tdlib_json.rs::new — там оба setOption.)
    #[test]
    fn language_pack_preinit_sends_localization_target_first() {
        const SRC: &str = include_str!("tdlib_runtime.rs");
        let loc_idx = SRC.find("localization_target").unwrap_or(usize::MAX);
        let lang_idx = SRC.find("language_pack_id").unwrap_or(usize::MAX);
        assert!(
            loc_idx != usize::MAX,
            "pre-init setOption localization_target=tdesktop отсутствует — Silent Drop \
             (mainline BUG-AUTH-009: без него lang_pack пустой)"
        );
        assert!(
            lang_idx != usize::MAX,
            "setOption language_pack_id пропал — регрессия анти-Silent-Drop линии"
        );
        assert!(
            loc_idx < lang_idx,
            "localization_target обязан отправляться РАНЬШЕ language_pack_id (порядок mainline)"
        );
        assert!(
            SRC.contains("\"value\": \"tdesktop\"") || SRC.contains("\"value\":\"tdesktop\""),
            "localization_target обязан маскироваться под Telegram Desktop (\"tdesktop\")"
        );
    }

    /// Гейт desktop CodeSettings: все optional delivery flags выключены.
    /// Future auth tokens остаются отдельным штатным механизмом TDLib.
    #[test]
    fn phone_auth_settings_desktop_parity() {
        let s = build_phone_auth_settings("+380001234567", &[]);
        assert_eq!(s["@type"], "setAuthenticationPhoneNumber");
        assert_eq!(s["phone_number"], "+380001234567", "номер обязан дойти до TDLib");
        let s = &s["settings"];
        assert_eq!(s["@type"], "phoneNumberAuthenticationSettings");
        assert_eq!(
            s["is_current_phone_number"],
            false,
            "десктоп не имеет SIM: is_current_phone_number обязано быть false \
             (mainline tdlib_auth_fsm.rs:is_current_phone_number=false)"
        );
        assert_eq!(
            s["has_unknown_phone_number"],
            false,
            "на Desktop нет SIM — has_unknown_phone_number=false"
        );
        assert_eq!(s["allow_missed_call"], false, "Desktop не запрашивает missed-call");
        assert_eq!(s["allow_flash_call"], false, "allow_flash_call=false (паритет Desktop)");
        assert_eq!(s["allow_sms_retriever_api"], false, "allow_sms_retriever_api=false");
        assert!(
            s["authentication_tokens"].as_array().map(|a| a.is_empty()).unwrap_or(false),
            "без захваченных токенов массив обязан быть пустым (семантика first-run)"
        );
    }

    /// BUG-AUTH-CODE-008: сохранённый future-токен обязан уходить в set_phone —
    /// это официальный вход БЕЗ кода (core.telegram.org/api/auth#future-auth-tokens).
    #[test]
    fn phone_auth_settings_signals_captured_tokens_to_send_code() {
        let toks = vec!["AAAabasurl".to_string()];
        let s = build_phone_auth_settings("+380001234567", &toks);
        let arr = s["settings"]["authentication_tokens"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(arr.len(), 1, "захваченный токен обязан дойти до codeSettings");
        assert_eq!(arr[0], "AAAabasurl");
    }

    /// Захват future-токена: новейшие первыми, дедуп, лимит 20 (лимит сервера).
    #[test]
    fn auth_token_capture_newest_first_dedup_cap20() {
        let ev = |v: &str| {
            json!({
                "@type": "updateOption",
                "name": "authentication_token",
                "value": { "@type": "optionValueString", "value": v }
            })
        };
        let mut toks: Vec<String> = Vec::new();
        assert!(capture_authentication_token(&mut toks, &ev("tok1")));
        assert!(capture_authentication_token(&mut toks, &ev("tok2")));
        assert_eq!(toks, vec!["tok2", "tok1"], "новый токен обязан стать первым");

        for i in 0..25 {
            capture_authentication_token(&mut toks, &ev(&format!("tok{i}")));
        }
        assert_eq!(toks.len(), 20, "лимит сервера — максимум 20 токенов");

        // Дедуп: повтор того же токена не дублируется, а поднимается наверх.
        assert!(capture_authentication_token(&mut toks, &ev("tok2")));
        assert_eq!(toks.first(), Some(&"tok2".to_string()));
        assert_eq!(toks.len(), 20, "дедуп не должен менять длину списка");
    }

    /// Чужие обновления и пустые значения не должны попадать в список токенов.
    #[test]
    fn auth_token_capture_ignores_foreign_and_empty_options() {
        let mut toks: Vec<String> = Vec::new();
        let other = json!({
            "@type": "updateOption",
            "name": "version",
            "value": { "@type": "optionValueString", "value": "hi" }
        });
        assert!(!capture_authentication_token(&mut toks, &other));

        let empty = json!({
            "@type": "updateOption",
            "name": "authentication_token",
            "value": { "@type": "optionValueString", "value": "" }
        });
        assert!(!capture_authentication_token(&mut toks, &empty));

        let emptied = json!({
            "@type": "updateOption",
            "name": "authentication_token",
            "value": { "@type": "optionValueEmpty" }
        });
        assert!(!capture_authentication_token(&mut toks, &emptied));

        assert!(toks.is_empty(), "пустые/чужие option не создают токенов");
    }

    /// Гейт проводки: capture ОБЯЗАН вызываться из dispatch_update (иначе
    /// updateOption теряется), а set_phone обязан передавать накопленные токены.
    /// Без этой связки фича «вход без кода» мертва (BUG-AUTH-CODE-008).
    #[test]
    fn auth_token_capture_is_wired_into_dispatch_and_set_phone() {
        const SRC: &str = include_str!("tdlib_runtime.rs");
        let disp_start = SRC.find("fn dispatch_update").expect("dispatch_update пропал");
        let disp_end = SRC.find("pub fn is_running").expect("is_running пропал");
        let disp = &SRC[disp_start..disp_end];
        assert!(
            disp.contains("capture_authentication_token"),
            "updateOption не доходит до capture_authentication_token — токен теряется \
             (BUG-AUTH-CODE-008)"
        );
        let setp_start = SRC.find("pub fn set_phone").expect("set_phone пропал");
        let setp_end = SRC.find("pub fn check_code").expect("check_code пропал");
        let setp = &SRC[setp_start..setp_end];
        assert!(
            setp.contains("auth_tokens"),
            "set_phone обязан передавать сохранённые future-токены — иначе сервер не \
             получит logout_tokens и вход без кода не включится"
        );
    }


    /// Регрессия «QR не генерируется»: технические состояния инициализации НЕ
    /// считаются готовыми — иначе фронтенд шлёт QR-запрос слишком рано, и TDLib
    /// молча его игнорирует.
    #[test]
    fn ui_ready_state_excludes_bootstrap_states() {
        assert!(!TdlibRuntime::is_ui_ready_state(""));
        assert!(!TdlibRuntime::is_ui_ready_state("authorizationStateWaitTdlibParameters"));
        assert!(!TdlibRuntime::is_ui_ready_state("authorizationStateWaitEncryptionKey"));
        assert!(TdlibRuntime::is_ui_ready_state("authorizationStateWaitPhoneNumber"));
        assert!(TdlibRuntime::is_ui_ready_state("authorizationStateWaitOtherDeviceConfirmation"));
        assert!(TdlibRuntime::is_ui_ready_state("authorizationStateReady"));
    }

    #[test]
    fn qr_login_is_allowed_only_while_waiting_for_phone_number() {
        assert!(TdlibRuntime::is_qr_login_state("authorizationStateWaitPhoneNumber"));
        assert!(!TdlibRuntime::is_qr_login_state("authorizationStateWaitCode"));
        assert!(!TdlibRuntime::is_qr_login_state("authorizationStateWaitPassword"));
        assert!(!TdlibRuntime::is_qr_login_state("authorizationStateWaitOtherDeviceConfirmation"));
        assert!(!TdlibRuntime::is_qr_login_state("authorizationStateReady"));
    }

    /// Живой репорт владельца (2026-10-31): на экране «🔑 Авторизация Telegram»
    /// висело `Ошибка (set_phone): Call to setAuthenticationPhoneNumber unexpected
    /// (код 400)`. Причина: `setAuthenticationPhoneNumber` валиден ТОЛЬКО в
    /// `authorizationStateWaitPhoneNumber`, а клиент слал его в любом состоянии.
    #[test]
    fn phone_login_state_is_only_wait_phone_number() {
        assert!(is_phone_login_state("authorizationStateWaitPhoneNumber"));
        assert!(!is_phone_login_state("authorizationStateWaitCode"));
        assert!(!is_phone_login_state("authorizationStateWaitPassword"));
        assert!(!is_phone_login_state("authorizationStateWaitOtherDeviceConfirmation"));
        assert!(!is_phone_login_state("authorizationStateWaitEmailAddress"));
        assert!(!is_phone_login_state("authorizationStateReady"));
        assert!(!is_phone_login_state(""));
    }

    /// Отказ ДО отправки: UI получает машинный код и показывает человеческий
    /// текст + приводит экран к фактическому шагу, вместо сырого 400.
    #[test]
    fn phone_auth_state_error_is_typed() {
        assert_eq!(phone_auth_state_error("authorizationStateWaitPhoneNumber"), None);
        assert_eq!(
            phone_auth_state_error("authorizationStateWaitCode").as_deref(),
            Some("PHONE_AUTH_IN_PROGRESS:wait_code")
        );
        assert_eq!(
            phone_auth_state_error("authorizationStateWaitPassword").as_deref(),
            Some("PHONE_AUTH_IN_PROGRESS:wait_password")
        );
        assert_eq!(
            phone_auth_state_error("authorizationStateWaitEmailCode").as_deref(),
            Some("PHONE_AUTH_IN_PROGRESS:wait_email_code")
        );
        assert_eq!(
            phone_auth_state_error("authorizationStateWaitOtherDeviceConfirmation").as_deref(),
            Some("PHONE_AUTH_IN_PROGRESS:wait_other_device")
        );
        // QR-ожидание в ответе getAuthorizationState приходит и как WaitQrCode.
        assert_eq!(
            phone_auth_state_error("authorizationStateWaitQrCode").as_deref(),
            Some("PHONE_AUTH_IN_PROGRESS:wait_other_device")
        );
        assert_eq!(
            phone_auth_state_error("authorizationStateReady").as_deref(),
            Some("PHONE_AUTH_ALREADY_AUTHORIZED")
        );
        for boot in [
            "",
            "authorizationStateWaitTdlibParameters",
            "authorizationStateWaitEncryptionKey",
            "authorizationStateClosed",
        ] {
            assert_eq!(
                phone_auth_state_error(boot).as_deref(),
                Some("PHONE_AUTH_NOT_READY"),
                "техническое состояние {boot} — это not_ready"
            );
        }
    }

    /// Ждать имеет смысл ТОЛЬКО техническую инициализацию TDLib: она меняется
    /// сама. Терминальные состояния (`waitCode`, `ready`, `closed`) сами не
    /// изменятся — иначе сообщение «уже авторизован» приходит через 10 секунд
    /// ожидания, хотя ответ известен сразу.
    #[test]
    fn bootstrap_states_are_only_technical_init() {
        for boot in [
            "",
            "authorizationStateWaitTdlibParameters",
            "authorizationStateWaitEncryptionKey",
        ] {
            assert!(is_bootstrap_state(boot), "{boot} — техническая инициализация");
        }
        for settled in [
            "authorizationStateWaitPhoneNumber",
            "authorizationStateWaitCode",
            "authorizationStateWaitPassword",
            "authorizationStateWaitOtherDeviceConfirmation",
            "authorizationStateReady",
            "authorizationStateClosed",
        ] {
            assert!(!is_bootstrap_state(settled), "{settled} — состояние уже определилось");
        }
    }

    /// Тот же класс дефекта у email-ветки: без проверки Telegram отвечает
    /// `400 Call to setAuthenticationEmailAddress unexpected`.
    #[test]
    fn email_auth_state_error_is_typed() {
        assert_eq!(email_auth_state_error("authorizationStateWaitEmailAddress"), None);
        assert_eq!(
            email_auth_state_error("authorizationStateWaitEmailCode").as_deref(),
            Some("EMAIL_AUTH_NOT_READY")
        );
        assert_eq!(
            email_auth_state_error("authorizationStateReady").as_deref(),
            Some("EMAIL_AUTH_ALREADY_AUTHORIZED")
        );
    }

    /// Гейт проводки: проверка состояния ОБЯЗАНА идти ДО `send_value`.
    #[test]
    fn set_phone_guards_state_before_sending() {
        const SRC: &str = include_str!("tdlib_runtime.rs");
        let start = SRC.find("pub fn set_phone").expect("set_phone пропал");
        let end = SRC.find("pub fn check_code").expect("check_code пропал");
        let body = &SRC[start..end];
        let guard = body.find("phone_auth_state_error").expect("set_phone без проверки состояния");
        let send = body.find("send_value").expect("set_phone без send_value");
        assert!(
            guard < send,
            "проверка состояния должна быть ДО отправки — иначе TDLib отвечает 400 unexpected"
        );
        assert!(
            body.contains("wait_for_state"),
            "set_phone обязан дождаться waitPhoneNumber (холодный старт TDLib), иначе ранний клик = 400"
        );
    }

    /// R-4: каталог состояния изолирован от mainline (`~/.tdlib/{api_id}`).
    #[test]
    fn state_root_dir_is_isolated_from_mainline() {
        let p = state_root_dir(12345);
        let s = p.to_string_lossy();
        assert!(s.contains("firmware-desktop-electron"), "путь: {s}");
        assert!(s.ends_with("12345"), "путь: {s}");
    }

    /// Границы формата `setTdlibParameters`: 1.8.65+ → FLAT, ≤1.8.64 → nested.
    /// В бандлах проекта живут ОБЕ линии (x86 = 1.8.61, x64 = 1.8.65), и
    /// ошибочный формат не даёт ошибки — TDLib молча видит api_id=0.
    #[test]
    fn tdlib_version_selects_parameters_format() {
        assert!(!params_are_flat(Some("1.8.61")), "x86-бандл 1.8.61 должен быть nested");
        assert!(!params_are_flat(Some("1.8.64")));
        assert!(!params_are_flat(Some("1.7.9")));
        assert!(!params_are_flat(Some("1.8")));
        assert!(params_are_flat(Some("1.8.65")), "x64-бандл 1.8.65 должен быть FLAT");
        assert!(params_are_flat(Some("1.8.70")));
        assert!(params_are_flat(Some("2.0.0")));
        assert!(params_are_flat(Some(" 1.8.65+git ")), "суффикс/пробелы не мешают");
        // Неизвестная версия — как в mainline (текущая линия 1.8.65+).
        assert!(params_are_flat(None));
        assert!(params_are_flat(Some("garbage")));
    }

    /// FLAT (≥1.8.65): поля на верхнем уровне, `session_count` есть,
    /// вложенного `parameters` и снятых полей нет.
    #[test]
    fn flat_parameters_shape() {
        let v = build_tdlib_parameters(true, 30248800, "deadbeef", "/db/x86_64", "PC x86_64");
        assert_eq!(v["@type"], "setTdlibParameters");
        assert_eq!(v["@extra"], "set_tdlib_params");
        assert_eq!(v["api_id"], 30248800);
        assert_eq!(v["api_hash"], "deadbeef");
        assert_eq!(v["database_directory"], "/db/x86_64");
        assert_eq!(v["session_count"], 2);
        assert_eq!(v["device_model"], "PC x86_64");
        assert!(v.get("parameters").is_none(), "FLAT не должен иметь parameters");
        assert!(v.get("enable_storage_optimizer").is_none());
        assert!(v.get("ignore_file_names").is_none());
    }

    /// Nested (≤1.8.64): поля внутри `parameters` (@type tdlibParameters),
    /// `enable_storage_optimizer` присутствует, `session_count` — нет.
    #[test]
    fn nested_parameters_shape() {
        let v = build_tdlib_parameters(false, 30248800, "deadbeef", "/db/i686", "PC x86");
        assert_eq!(v["@type"], "setTdlibParameters");
        assert_eq!(v["@extra"], "set_tdlib_params");
        let p = &v["parameters"];
        assert_eq!(p["@type"], "tdlibParameters");
        assert_eq!(p["api_id"], 30248800);
        assert_eq!(p["api_hash"], "deadbeef");
        assert_eq!(p["database_directory"], "/db/i686");
        assert_eq!(p["enable_storage_optimizer"], false);
        assert_eq!(p["ignore_file_names"], false);
        assert!(p.get("session_count").is_none(), "у ≤1.8.64 нет session_count");
    }
}
