//! M4a3-шаг2 — сервисные TDLib-команды (не сама передача файлов):
//! join чата / join по invite-ссылке, удаление сообщений, авто-/start бота.
//!
//! Зеркало mainline ([`tdlib_download.rs:3354`](../../desktop/src-tauri/src/tdlib_download.rs)
//! `tdlib_send_bot_start`, `tdlib_join_chat`, `tdlib_join_chat_by_invite_link`,
//! `tdlib_delete_messages`), но без Tauri/tokio — через `TdlibRuntime::send_and_wait`.
//!
//! Зачем UI это нужно (по коду DownloadPage/UploadPage/SearchPage):
//!   - `join_chat` / `join_chat_by_invite_link` — вход в приватный storage-чат,
//!     без которого `downloadFile` не знает размер файла (total=0);
//!   - `delete_messages` — само-удаление своих upload-сообщений при отмене;
//!   - `send_bot_start` — открыть ЛС с ботом (`/start`), чтобы host-mediation видел чат.

use std::time::Duration;

use serde_json::{json, Value};

use crate::tdlib_runtime::TdlibRuntime;

/// Таймаут сервисных вызовов (как в UI — `_invokeWithTimeout(..., 15000)`).
const MISC_TIMEOUT: Duration = Duration::from_secs(20);

/// Таймауты стартового cleanup зависших upload-документов в PM
/// (порт из mainline: история — 8s, удаление — 5s).
const CLEANUP_HISTORY_TIMEOUT: Duration = Duration::from_secs(8);
const CLEANUP_DELETE_TIMEOUT: Duration = Duration::from_secs(5);

/// Уникальный суффикс `@extra` (без внешних крейтов).
fn extra_suffix(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}_{n:x}")
}

/// Нормализация chat_id канала/супергруппы (mainline `tdlib_json.rs:80`).
///
/// Положительный id КАК ЕСТЬ (в т.ч. PM) → `-100<id>`.
///
/// ВАЖНО: функция нормализует ЛЮБОЙ положительный id, поэтому для ЛС с ботом
/// (положительный user_id бота) её вызывать НЕЛЬЗЯ — `-100<user_id>` уведёт
/// запрос в несуществующий супергруп и сломает PM (Host-Mediation ADR).
/// PM-путь (`delete_messages`) передаёт chat_id без нормализации.
pub fn to_tdlib_chat_id(chat_id: i64) -> i64 {
    if chat_id > 0 {
        format!("-100{chat_id}").parse::<i64>().unwrap_or(chat_id)
    } else {
        chat_id
    }
}

/// `USER_ALREADY_PARTICIPANT` — не ошибка (mainline трактует как успех).
fn is_already_participant(err: &str) -> bool {
    let e = err.to_uppercase();
    e.contains("USER_ALREADY_PARTICIPANT") || e.contains("ALREADY A PARTICIPANT")
}

/// getChat-warmup: форсирует кеширование чата в TDLib (без него downloadFile
/// не может определить размер файла).
fn warmup_get_chat(rt: &TdlibRuntime, chat_id: i64) {
    let _ = rt.send_and_wait(
        json!({
            "@type": "getChat",
            "chat_id": chat_id,
            "@extra": extra_suffix("warm_getchat"),
        }),
        MISC_TIMEOUT,
    );
}

/// `tdlib_join_chat(chatId)` → joinChat + getChat-warmup.
pub fn join_chat(rt: &TdlibRuntime, chat_id: i64) -> Result<Value, String> {
    let tdl_chat_id = to_tdlib_chat_id(chat_id);
    let res = rt.send_and_wait(
        json!({
            "@type": "joinChat",
            "chat_id": tdl_chat_id,
            "@extra": extra_suffix("join_chat"),
        }),
        MISC_TIMEOUT,
    );
    match res {
        Ok(_) => {
            warmup_get_chat(rt, tdl_chat_id);
            Ok(json!({ "status": "joined", "chat_id": tdl_chat_id }))
        }
        Err(e) if is_already_participant(&e) => {
            warmup_get_chat(rt, tdl_chat_id);
            Ok(json!({ "status": "already_participant", "chat_id": tdl_chat_id }))
        }
        Err(e) => Err(format!("join_chat({tdl_chat_id}): {e}")),
    }
}

/// `tdlib_join_chat_by_invite_link(inviteLink, chatId?)` → joinChatByInviteLink
/// + getChat-warmup по переданному chatId (mainline BUG-CROSS-USER-DOWNLOAD-004).
pub fn join_chat_by_invite_link(
    rt: &TdlibRuntime,
    invite_link: &str,
    chat_id: Option<i64>,
) -> Result<Value, String> {
    if invite_link.is_empty() {
        return Err("join_chat_by_invite_link: inviteLink обязателен".into());
    }
    let res = rt.send_and_wait(
        json!({
            "@type": "joinChatByInviteLink",
            "invite_link": invite_link,
            "@extra": extra_suffix("join_invite"),
        }),
        MISC_TIMEOUT,
    );
    match res {
        Ok(v) => {
            // Ответ — `chat`; берём его id для warmup, иначе переданный chatId.
            let joined_id = v["id"].as_i64().or(chat_id);
            if let Some(cid) = joined_id {
                warmup_get_chat(rt, cid);
            }
            Ok(json!({ "status": "joined", "chat_id": joined_id }))
        }
        Err(e) if is_already_participant(&e) => {
            if let Some(cid) = chat_id {
                warmup_get_chat(rt, cid);
            }
            Ok(json!({ "status": "already_participant" }))
        }
        Err(e) => Err(format!("join_chat_by_invite_link: {e}")),
    }
}

/// Запрос `deleteMessages` (вынесено в чистую функцию — юнит-тестируемый
/// контракт chat_id).
///
/// ВАЖНО: `chat_id` идёт КАК ЕСТЬ, без `to_tdlib_chat_id`. Причина —
/// mainline `tdlib_download.rs:4014` (`tdlib_delete_messages`): для ЛС с ботом
/// chat_id = положительный user_id бота, и `-100<id>` сломал бы адресацию PM
/// (удаление ушло бы в несуществующий супергруп). Это же нарушение было
/// перенесено в Electron-порт — исправлено (BUG-PM-DELETE-001).
pub fn build_delete_messages_request(chat_id: i64, message_ids: &[i64], revoke: bool) -> Value {
    json!({
        "@type": "deleteMessages",
        "chat_id": chat_id,
        "message_ids": message_ids,
        "revoke": revoke,
        "@extra": extra_suffix("del_msgs"),
    })
}

/// `tdlib_delete_messages(chatId, messageIds, revoke?)` → deleteMessages.
///
/// Используется для self-delete СВОИХ upload-сообщений в PM (после Host
/// `vaulted` / при отмене загрузки) — `UploadPage._deleteOwnPmMessages`.
pub fn delete_messages(
    rt: &TdlibRuntime,
    chat_id: i64,
    message_ids: Vec<i64>,
    revoke: bool,
) -> Result<Value, String> {
    if message_ids.is_empty() {
        // Расхождение с mainline (там Err) — задокументировано в
        // PORT_DIVERGENCES.md. UI зовёт команду только с непустым списком,
        // поэтому пустой ввод безопаснее трактовать как benign noop.
        return Ok(json!({ "status": "noop", "deleted": 0 }));
    }
    rt.send_and_wait(
        build_delete_messages_request(chat_id, &message_ids, revoke),
        MISC_TIMEOUT,
    )?;
    Ok(json!({ "status": "deleted", "chat_id": chat_id }))
}

/// Запрос `createPrivateChat` для ЛС с ПОЛЬЗОВАТЕЛЕМ (bot/Host/user).
///
/// ВАЖНО: `user_id` идёт КАК ЕСТЬ, без `to_tdlib_chat_id`: нормализация дала бы
/// `-100<user_id>` (несуществующая супергруппа). Тот же инвариант, что у
/// [`build_delete_messages_request`] (BUG-PM-DELETE-001).
pub fn build_create_private_chat_request(user_id: i64, extra_prefix: &str) -> Value {
    json!({
        "@type": "createPrivateChat",
        "user_id": user_id,
        "force": true,
        "@extra": extra_suffix(&format!("{extra_prefix}_pm")),
    })
}

/// Достать `chat.id` из ответа TDLib (`chat` → Some, иначе None: error/др. тип).
pub fn chat_id_from_response(v: &Value) -> Option<i64> {
    if v["@type"].as_str() == Some("chat") {
        v["id"].as_i64()
    } else {
        None
    }
}

// ── SP-07 S-2: Silent Beacon — чтение описания бота (pull, D-006/D-015) ─────
// Второй, независимый по транспорту контур поиска адреса сервера: координаты
// лежат в ОПИСАНИИ БОТА (`userFullInfo.bot_info.description`), клиент читает их
// через СВОЙ TDLib. Ноль сообщений в PM (D-006) — команда только читает.

/// `user_id` приватного чата из ответа `searchPublicChat`/`createPrivateChat`.
///
/// `chat.type` = `chatTypePrivate{user_id}`; вернуть надо именно USER id, потому
/// что `getUserFullInfo` работает с пользователем, а не с чатом.
pub fn private_chat_user_id_from_response(v: &Value) -> Option<i64> {
    if v["@type"].as_str() != Some("chat") {
        return None;
    }
    if v["type"]["@type"].as_str() != Some("chatTypePrivate") {
        return None;
    }
    v["type"]["user_id"].as_i64()
}

/// Описание бота из ответа `getUserFullInfo` (`bot_info.description`).
///
/// Почему именно `bot_info.description`, а не `bio`: в TDLib `userFullInfo.bio`
/// помечен как «may be null for bots», а описание бота, которое показывается в
/// пустом чате (то самое, что задаёт `setMyDescription`), лежит в `bot_info`.
/// Любой неожиданный ответ → `None`: это fail-open (клиент остаётся на текущем
/// адресе), а не ошибка.
pub fn bot_description_from_user_full_info(v: &Value) -> Option<String> {
    let description = v["bot_info"]["description"].as_str()?;
    if description.trim().is_empty() {
        return None;
    }
    Some(description.to_string())
}

/// `tdlib_get_bot_description(userId?, username?)` → `{description, user_id}`.
///
/// Резолв цели (без отправки сообщений): сначала `searchPublicChat` по username,
/// затем `createPrivateChat` (тот же порядок, что у `resolve_private_chat`);
/// далее `getUserFullInfo` и разбор `bot_info.description`.
pub fn read_bot_description(
    rt: &TdlibRuntime,
    user_id: i64,
    username: Option<String>,
) -> Result<Value, String> {
    if !private_chat_target_ok(user_id, username.as_deref()) {
        return Err("tdlib_get_bot_description: userId or username required".to_string());
    }

    let mut resolved_user_id = if user_id > 0 { Some(user_id) } else { None };
    if resolved_user_id.is_none() {
        if let Some(uname) = username.as_deref() {
            let uname = uname.trim().trim_start_matches('@');
            if !uname.is_empty() {
                if let Ok(v) = rt.send_and_wait(
                    json!({
                        "@type": "searchPublicChat",
                        "username": uname,
                        "@extra": extra_suffix("botdesc_search"),
                    }),
                    MISC_TIMEOUT,
                ) {
                    resolved_user_id = private_chat_user_id_from_response(&v);
                }
            }
        }
    }

    let target = resolved_user_id.ok_or_else(|| {
        "tdlib_get_bot_description: bot user_id not resolved (searchPublicChat)".to_string()
    })?;

    let full = rt.send_and_wait(
        json!({
            "@type": "getUserFullInfo",
            "user_id": target,
            "@extra": extra_suffix("botdesc_full"),
        }),
        MISC_TIMEOUT,
    )?;

    let description = bot_description_from_user_full_info(&full).ok_or_else(|| {
        "tdlib_get_bot_description: bot has no description (маяка нет)".to_string()
    })?;

    Ok(json!({ "description": description, "user_id": target }))
}

// ── Phase 3 (гигиена PM): клиент сам делает чат с ботом «тихим» ─────────────
// Юзер не должен видеть в списке чатов «болтающий» чат с ботом. Telegram не даёт
// серверу менять настройки клиента юзера — это делает СОБСТВЕННЫЙ TDLib юзера:
// mute (setChatNotificationSettings, mute_for = max) + archive (addChatToList).

/// Запрос mute (уведомления off навсегда, ~68 лет).
pub fn build_mute_chat_request(chat_id: i64) -> Value {
    json!({
        "@type": "setChatNotificationSettings",
        "scope": {
            "@type": "notificationSettingsScopeChat",
            "chat_id": chat_id,
        },
        "notification_settings": {
            "@type": "chatNotificationSettings",
            "use_default_mute_for": false,
            "mute_for": 2_147_483_647_i64,
        },
    })
}

/// Запрос переноса чата в архив (TDLib 1.8+: addChatToList(chatListArchive)).
pub fn build_archive_chat_request(chat_id: i64) -> Value {
    json!({
        "@type": "addChatToList",
        "chat_id": chat_id,
        "chat_list": { "@type": "chatListArchive" },
    })
}

/// `tdlib_quiet_bot_chat(chatId)` — mute + archive, оба best-effort.
///
/// Архив/мьют идемпотентны: повторный вызов возвращает ошибку TDLib
/// («chat list is the same» и т.п.) — трактуем как успех.
pub fn quiet_bot_chat(rt: &TdlibRuntime, chat_id: i64) -> Result<Value, String> {
    if chat_id <= 0 {
        // PM-чат положительный; отрицательный (-100…) — не личка.
        return Err("tdlib_quiet_bot_chat: private chat_id (positive) required".into());
    }
    let mut muted = false;
    let mut archived = false;
    if rt.send_and_wait(
        {
            let mut req = build_mute_chat_request(chat_id);
            req["@extra"] = Value::String(extra_suffix("quiet_mute"));
            req
        },
        MISC_TIMEOUT,
    )
    .is_ok()
    {
        muted = true;
    }
    if rt.send_and_wait(
        {
            let mut req = build_archive_chat_request(chat_id);
            req["@extra"] = Value::String(extra_suffix("quiet_archive"));
            req
        },
        MISC_TIMEOUT,
    )
    .is_ok()
    {
        archived = true;
    }
    Ok(json!({
        "status": "ok",
        "chat_id": chat_id,
        "muted": muted,
        "archived": archived,
    }))
}


/// Резолв chat_id приватного чата с пользователем (без отправки сообщений).
///
/// Порядок (как mainline): `searchPublicChat` по username (best-effort — ошибка
/// не фатальна), затем `createPrivateChat` по user_id (обязательный; ошибка
/// возвращается как Err). `Ok(None)` — чат не определён.
fn resolve_private_chat_id(
    rt: &TdlibRuntime,
    user_id: i64,
    username: Option<&str>,
    prefix: &str,
) -> Result<Option<i64>, String> {
    let mut chat_id: Option<i64> = None;

    if let Some(uname) = username {
        let uname = uname.trim().trim_start_matches('@');
        if !uname.is_empty() {
            if let Ok(v) = rt.send_and_wait(
                json!({
                    "@type": "searchPublicChat",
                    "username": uname,
                    "@extra": extra_suffix(&format!("{prefix}_search")),
                }),
                MISC_TIMEOUT,
            ) {
                chat_id = chat_id_from_response(&v);
            }
        }
    }

    if chat_id.is_none() && user_id > 0 {
        let v = rt.send_and_wait(
            build_create_private_chat_request(user_id, prefix),
            MISC_TIMEOUT,
        )?;
        chat_id = chat_id_from_response(&v);
    }

    Ok(chat_id)
}

/// Чистая валидация цели резолва ЛС: нужен user_id > 0 либо непустой username
/// (с ведущим `@` и пробелами допускается). Вынесена из [`resolve_private_chat`]
/// ради юнит-теста без TDLib-runtime.
pub fn private_chat_target_ok(user_id: i64, username: Option<&str>) -> bool {
    if user_id > 0 {
        return true;
    }
    username
        .map(|s| !s.trim().trim_start_matches('@').is_empty())
        .unwrap_or(false)
}

/// `tdlib_resolve_private_chat(userId, username?)` → `{chat_id, user_id}`.
///
/// Host-PM staging (вариант 1): цель загрузки — скрытый PM user↔Host, поэтому
/// клиенту нужен chat_id ЛС с Host-АККАУНТОМ (не ботом). В отличие от
/// [`send_bot_start`] сообщение НЕ отправляется: Host — пользователь, `/start`
/// не нужен, а `createPrivateChat(force=true)` открывает ЛС локально.
pub fn resolve_private_chat(
    rt: &TdlibRuntime,
    user_id: i64,
    username: Option<String>,
) -> Result<Value, String> {
    if !private_chat_target_ok(user_id, username.as_deref()) {
        return Err("tdlib_resolve_private_chat: userId or username required".to_string());
    }

    let chat_id = resolve_private_chat_id(rt, user_id, username.as_deref(), "resolve_pm")?
        .ok_or_else(|| {
            "tdlib_resolve_private_chat: chat not resolved (searchPublicChat/createPrivateChat)"
                .to_string()
        })?;

    Ok(json!({ "chat_id": chat_id, "user_id": user_id }))
}

/// `tdlib_send_bot_start(botUserId, botUsername?)` — открыть ЛС с ботом и послать `/start`.
///
/// Резолв чата (как mainline): сначала `searchPublicChat` по username (работает для
/// «свежего» аккаунта, у которого бота нет в кеше), затем `createPrivateChat`.
pub fn send_bot_start(
    rt: &TdlibRuntime,
    bot_user_id: i64,
    bot_username: Option<String>,
) -> Result<Value, String> {
    let chat_id = resolve_private_chat_id(rt, bot_user_id, bot_username.as_deref(), "botstart")?
        .ok_or_else(|| {
            "send_bot_start: не удалось определить chat с ботом (searchPublicChat/createPrivateChat)"
                .to_string()
        })?;

    rt.send_and_wait(
        json!({
            "@type": "sendMessage",
            "chat_id": chat_id,
            "input_message_content": {
                "@type": "inputMessageText",
                "text": { "@type": "formattedText", "text": "/start", "entities": [] },
            },
            "@extra": extra_suffix("botstart_send"),
        }),
        MISC_TIMEOUT,
    )?;
    // BUG-UPLOAD-CACHE-001 (порт из mainline `tdlib_download.rs::tdlib_send_bot_start`):
    // стартовый cleanup зависших upload-документов в PM. Best-effort — не
    // влияет на результат auto-/start (все ошибки только логируются).
    cleanup_stuck_pm_uploads(rt, chat_id);
    Ok(json!({ "status": "sent", "chat_id": chat_id }))
}

/// BUG-UPLOAD-CACHE-001 (startup cleanup): отобрать «зависшие» (Pending)
/// upload-документы из истории PM.
///
/// Чистая функция (без TDLib) — юнит-тестируема. Возвращает
/// `(message_ids, document_file_ids)`:
///   * `message_ids` — id своих сообщений с caption `upload_id:*` в состоянии
///     `messageSendingStatePending` (именно они воскрешают зомби-uploader);
///   * `document_file_ids` — id их TDLib-файлов (для `deleteFile` — снятие
///     cached-remote, чтобы следующий `preliminaryUploadFile` залил с нуля).
///
/// Доставленные (`messageSendingStateSent`) части не трогаем: они нужны
/// серверу до `/complete` + vault.
pub fn collect_stuck_pm_uploads(messages: &[Value]) -> (Vec<i64>, Vec<i64>) {
    let mut stuck_ids: Vec<i64> = Vec::new();
    let mut doc_file_ids: Vec<i64> = Vec::new();
    for m in messages {
        if m["is_outgoing"].as_bool() != Some(true) {
            continue;
        }
        if m["content"]["@type"].as_str() != Some("messageDocument") {
            continue;
        }
        let caption = m["content"]["caption"]["text"].as_str().unwrap_or("");
        if !caption.starts_with("upload_id:") {
            continue;
        }
        if m["sending_state"]["@type"].as_str() != Some("messageSendingStatePending") {
            continue;
        }
        if let Some(id) = m["id"].as_i64() {
            stuck_ids.push(id);
        }
        if let Some(fid) = m["content"]["document"]["document"]["id"].as_i64() {
            doc_file_ids.push(fid);
        }
    }
    (stuck_ids, doc_file_ids)
}

/// BUG-UPLOAD-CACHE-001 (startup cleanup): удалить наши «зависшие» (Pending)
/// upload-документы в PM с ботом.
///
/// Порт из mainline
/// [`tdlib_download.rs::cleanup_stuck_pm_uploads`](../../desktop/src-tauri/src/tdlib_download.rs)
/// (без Tauri/tokio — через `TdlibRuntime::send_and_wait`/`send_value`).
///
/// # Почему нужно
///
/// После убитой/прерванной сессии в ЛС остаются outgoing документы с caption
/// `upload_id:*` в состоянии `messageSendingStatePending`. При следующем старте
/// TDLib подгружает последнее такое сообщение как `last_message` чата и
/// воскрешает его uploader: у файла `is_uploading_active=true`, а локальный
/// путь в БД не восстановлен → бесконечный retry → сообщение вечно Pending,
/// а наш `sendMessage(inputFileRemote)` виснет (UI 0%).
///
/// Удаление stuck-сообщений (revoke) снимает «якорь»; `deleteFile` чистит
/// cached-remote, чтобы следующий upload реально залил часть с нуля.
///
/// Best-effort: любая ошибка только логируется (не роняет auto-bot-start).
fn cleanup_stuck_pm_uploads(rt: &TdlibRuntime, chat_id: i64) {
    // 1. История ЛС (последние 100 сообщений). Точка отсчёта — `getChat.last_message.id`
    // (BUG-DOWNLOAD-052 фаза 2): `from_message_id=0` в клиентской TDLib отдаёт ОДНО
    // последнее сообщение, поэтому такой срез не находит зависшие upload-сообщения.
    let from_message_id = crate::download::history_start_message_id(rt, chat_id);
    let history = match rt.send_and_wait(
        json!({
            "@type": "getChatHistory",
            "chat_id": chat_id,
            "from_message_id": from_message_id,
            "offset": 0,
            "limit": 100,
            "only_local": false,
            "@extra": extra_suffix("botstart_history"),
        }),
        CLEANUP_HISTORY_TIMEOUT,
    ) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("engine-core[misc]: cleanupStuckUploads: getChatHistory failed: {e}");
            return;
        }
    };
    let Some(messages) = history["messages"].as_array() else {
        eprintln!("engine-core[misc]: cleanupStuckUploads: getChatHistory без поля messages");
        return;
    };

    // 2. Ищем свои Pending upload-документы (caption upload_id:*).
    let (stuck_ids, doc_file_ids) = collect_stuck_pm_uploads(messages);
    if stuck_ids.is_empty() {
        eprintln!(
            "engine-core[misc]: cleanupStuckUploads: chat_id={chat_id} — зависших upload-сообщений нет"
        );
        return;
    }
    eprintln!(
        "engine-core[misc]: cleanupStuckUploads: chat_id={chat_id} — найдено {} stuck upload-сообщений (msg_ids={stuck_ids:?}, file_ids={doc_file_ids:?})",
        stuck_ids.len()
    );

    // 3. deleteMessages (revoke) — снимаем «якорь» poison.
    match rt.send_and_wait(
        build_delete_messages_request(chat_id, &stuck_ids, true),
        CLEANUP_DELETE_TIMEOUT,
    ) {
        Ok(_) => eprintln!("engine-core[misc]: cleanupStuckUploads: deleteMessages OK"),
        Err(e) => {
            eprintln!("engine-core[misc]: cleanupStuckUploads: deleteMessages failed: {e}")
        }
    }

    // 4. deleteFile ссылок — снимаем cached-remote (после удаления stuck-сообщения
    // файл выходит из «uploading»), следующий upload идёт с нуля.
    for fid in &doc_file_ids {
        let _ = rt.send_value(json!({ "@type": "deleteFile", "file_id": fid }));
    }
    if !doc_file_ids.is_empty() {
        eprintln!(
            "engine-core[misc]: cleanupStuckUploads: deleteFile отправлен для {} файлов",
            doc_file_ids.len()
        );
    }
}


/// Диспетчер сервисных команд (из main-loop sidecar).
pub fn dispatch(
    method: &str,
    rt: &TdlibRuntime,
    params: &Value,
) -> Result<Value, String> {
    match method {
        "tdlib_join_chat" => {
            let chat_id = params
                .get("chatId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
                .ok_or_else(|| "tdlib_join_chat: chatId required".to_string())?;
            join_chat(rt, chat_id)
        }
        "tdlib_join_chat_by_invite_link" => {
            let link = params
                .get("inviteLink")
                .and_then(|v| v.as_str())
                .or_else(|| params.get("invite_link").and_then(|v| v.as_str()))
                .ok_or_else(|| "tdlib_join_chat_by_invite_link: inviteLink required".to_string())?;
            let chat_id = params
                .get("chatId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()));
            join_chat_by_invite_link(rt, link, chat_id)
        }
        "tdlib_delete_messages" => {
            let chat_id = params
                .get("chatId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
                .ok_or_else(|| "tdlib_delete_messages: chatId required".to_string())?;
            let ids: Vec<i64> = params
                .get("messageIds")
                .or_else(|| params.get("message_ids"))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default();
            let revoke = params.get("revoke").and_then(|v| v.as_bool()).unwrap_or(true);
            delete_messages(rt, chat_id, ids, revoke)
        }
        "tdlib_quiet_bot_chat" => {
            let chat_id = params
                .get("chatId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("chat_id").and_then(|v| v.as_i64()))
                .ok_or_else(|| "tdlib_quiet_bot_chat: chatId required".to_string())?;
            quiet_bot_chat(rt, chat_id)
        }
        "tdlib_resolve_private_chat" => {
            let user_id = params
                .get("userId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("user_id").and_then(|v| v.as_i64()))
                .or_else(|| params.get("hostChatId").and_then(|v| v.as_i64()))
                .or_else(|| params.get("host_chat_id").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            let username = params
                .get("username")
                .and_then(|v| v.as_str())
                .or_else(|| params.get("hostUsername").and_then(|v| v.as_str()))
                .or_else(|| params.get("host_username").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            resolve_private_chat(rt, user_id, username)
        }
        "tdlib_send_bot_start" => {
            let bot_user_id = params
                .get("botUserId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("bot_user_id").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            let username = params
                .get("botUsername")
                .and_then(|v| v.as_str())
                .or_else(|| params.get("bot_username").and_then(|v| v.as_str()))
                .map(|s| s.to_string());
            send_bot_start(rt, bot_user_id, username)
        }
        "tdlib_get_bot_description" => {
            // SP-07 S-2 (Silent Beacon): описание бота с payload BEACON:v1:…
            let user_id = params
                .get("userId")
                .and_then(|v| v.as_i64())
                .or_else(|| params.get("user_id").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            let username = params
                .get("username")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            read_bot_description(rt, user_id, username)
        }
        other => Err(format!("misc: unknown method {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_id_normalization() {
        // Положительный id (канал без префикса) → -100<id>.
        assert_eq!(to_tdlib_chat_id(1234567890), -1001234567890);
        // Уже TDLib-форма — не трогаем.
        assert_eq!(to_tdlib_chat_id(-1001234567890), -1001234567890);
    }

    #[test]
    fn to_tdlib_chat_id_must_not_be_used_for_pm() {
        // Контракт нормализации: ЛЮБОЙ положительный id → -100<id>, включая
        // PM-бота. Поэтому delete_messages её НЕ зовёт (см. следующий тест) —
        // иначе удаление уходило бы в несуществующий супергруп.
        assert_eq!(to_tdlib_chat_id(777000), -100777000);
    }

    #[test]
    fn create_private_chat_request_keeps_user_id_as_is() {
        // Host-PM (вариант 1): цель загрузки — ЛС user↔Host. user_id идёт КАК
        // ЕСТЬ; to_tdlib_chat_id дал бы -100<id> (несуществующая супергруппа),
        // и createPrivateChat упал бы → клиент не смог бы загрузить файл.
        let req = build_create_private_chat_request(608600364, "resolve_pm");
        assert_eq!(req["@type"].as_str(), Some("createPrivateChat"));
        assert_eq!(req["user_id"].as_i64(), Some(608600364));
        assert_eq!(req["force"].as_bool(), Some(true));
    }

    #[test]
    fn chat_id_from_response_accepts_chat_only() {
        // Ответ TDLib: успех — объект `chat`; ошибка — `error` (id брать нельзя,
        // иначе загрузка ушла бы в чужой/несуществующий чат).
        assert_eq!(chat_id_from_response(&json!({ "@type": "chat", "id": 42 })), Some(42));
        assert_eq!(chat_id_from_response(&json!({ "@type": "error", "code": 400 })), None);
        assert_eq!(chat_id_from_response(&json!({ "@type": "chat" })), None);
    }

    #[test]
    fn resolve_private_chat_requires_user_id_or_username() {
        // Контракт валидации — чистая функция `private_chat_target_ok`, которую
        // вызывает `resolve_private_chat` ДО любого TDLib-запроса
        // (createPrivateChat(0) дал бы мусорный чат).
        assert!(!private_chat_target_ok(0, None));
        assert!(!private_chat_target_ok(0, Some("")));
        assert!(!private_chat_target_ok(0, Some("   ")));
        // username с ведущим '@' и пробелами не считается пустым.
        assert!(private_chat_target_ok(0, Some("  @host_user  ")));
        // user_id достаточно и без username.
        assert!(private_chat_target_ok(608600364, None));
    }

    #[test]
    fn delete_messages_request_keeps_pm_chat_id_as_is() {
        // BUG-PM-DELETE-001: до фикса chat_id нормализовался в -100<bot_user_id>
        // → PM не чистился («удаление» уходило в несуществующий супергруп).
        let req = build_delete_messages_request(777000, &[10, 11], true);
        assert_eq!(req["chat_id"].as_i64(), Some(777000));
        assert_eq!(req["revoke"].as_bool(), Some(true));
        let ids: Vec<i64> = req["message_ids"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_i64())
            .collect();
        assert_eq!(ids, vec![10, 11]);
    }

    #[test]
    fn collect_stuck_pm_uploads_filters_pending_documents_only() {
        let messages = json!([
            // 1) свой Pending документ с caption upload_id:* → чистим
            {
                "id": 101,
                "is_outgoing": true,
                "sending_state": { "@type": "messageSendingStatePending" },
                "content": {
                    "@type": "messageDocument",
                    "caption": { "text": "upload_id: abc/1111" },
                    "document": { "document": { "id": 9001 } }
                }
            },
            // 2) доставленный (Sent) свой документ → НЕ трогаем (нужен до /complete)
            {
                "id": 102,
                "is_outgoing": true,
                "sending_state": { "@type": "messageSendingStateSent" },
                "content": {
                    "@type": "messageDocument",
                    "caption": { "text": "upload_id: abc/1112" },
                    "document": { "document": { "id": 9002 } }
                }
            },
            // 3) входящее (сообщение бота) → НЕ трогаем
            {
                "id": 103,
                "is_outgoing": false,
                "sending_state": { "@type": "messageSendingStatePending" },
                "content": {
                    "@type": "messageDocument",
                    "caption": { "text": "upload_id: abc/1113" },
                    "document": { "document": { "id": 9003 } }
                }
            },
            // 4) свой Pending документ без caption upload_id:* → НЕ трогаем
            {
                "id": 104,
                "is_outgoing": true,
                "sending_state": { "@type": "messageSendingStatePending" },
                "content": {
                    "@type": "messageDocument",
                    "caption": { "text": "просто файл" },
                    "document": { "document": { "id": 9004 } }
                }
            },
            // 5) свой Pending текст → НЕ трогаем
            {
                "id": 105,
                "is_outgoing": true,
                "sending_state": { "@type": "messageSendingStatePending" },
                "content": { "@type": "messageText", "text": { "text": "привет" } }
            }
        ]);
        let (ids, files) = collect_stuck_pm_uploads(messages.as_array().unwrap());
        assert_eq!(ids, vec![101]);
        assert_eq!(files, vec![9001]);
    }

    #[test]
    fn mute_chat_request_targets_chat_scope_with_max_mute() {
        let req = build_mute_chat_request(889_875_218);
        assert_eq!(req["@type"], "setChatNotificationSettings");
        assert_eq!(req["scope"]["@type"], "notificationSettingsScopeChat");
        assert_eq!(req["scope"]["chat_id"].as_i64(), Some(889_875_218));
        assert_eq!(req["notification_settings"]["mute_for"].as_i64(), Some(2_147_483_647));
        assert_eq!(
            req["notification_settings"]["use_default_mute_for"],
            false
        );
    }

    #[test]
    fn archive_chat_request_moves_to_archive_list() {
        let req = build_archive_chat_request(889_875_218);
        assert_eq!(req["@type"], "addChatToList");
        assert_eq!(req["chat_id"].as_i64(), Some(889_875_218));
        assert_eq!(req["chat_list"]["@type"], "chatListArchive");
    }

    #[test]
    fn already_participant_is_not_an_error() {
        assert!(is_already_participant(
            "TDLib error 400: USER_ALREADY_PARTICIPANT"
        ));
        assert!(!is_already_participant("TDLib error 400: CHAT_NOT_FOUND"));
    }

    // ── SP-07 S-2: Silent Beacon — чтение описания бота (pull, D-006/D-015) ──

    #[test]
    fn bot_description_is_read_from_bot_info() {
        // Описание бота живёт в userFullInfo.bot_info.description (не bio:
        // bio «may be null for bots»). Маяк читается именно отсюда.
        let full = json!({
            "@type": "userFullInfo",
            "bio": { "text": "" },
            "bot_info": { "description": "ARTEL — база знань\n\nBEACON:v1:1:abc" }
        });
        assert_eq!(
            bot_description_from_user_full_info(&full).as_deref(),
            Some("ARTEL — база знань\n\nBEACON:v1:1:abc")
        );
    }

    #[test]
    fn bot_description_fails_open_on_unexpected_shapes() {
        // Любой неожиданный ответ → None (fail-open: клиент остаётся на текущем
        // адресе, вместо того чтобы упасть на «не таком» ответе TDLib).
        assert_eq!(bot_description_from_user_full_info(&json!({})), None);
        assert_eq!(
            bot_description_from_user_full_info(&json!({ "@type": "error", "code": 400 })),
            None
        );
        assert_eq!(
            bot_description_from_user_full_info(&json!({ "bot_info": {} })),
            None
        );
        // Пустое описание — тоже «маяка нет» (а не пустой адрес).
        assert_eq!(
            bot_description_from_user_full_info(&json!({ "bot_info": { "description": "   " } })),
            None
        );
    }

    #[test]
    fn private_chat_user_id_is_taken_from_chat_type() {
        // searchPublicChat/createPrivateChat → chat.type = chatTypePrivate{user_id};
        // getUserFullInfo требует USER id (не chat id).
        let chat = json!({
            "@type": "chat",
            "id": 123456,
            "type": { "@type": "chatTypePrivate", "user_id": 777000 }
        });
        assert_eq!(private_chat_user_id_from_response(&chat), Some(777000));
        // Не приватный чат / ошибка → None.
        assert_eq!(
            private_chat_user_id_from_response(&json!({ "@type": "chat", "type": { "@type": "chatTypeSupergroup", "supergroup_id": 1 } })),
            None
        );
        assert_eq!(
            private_chat_user_id_from_response(&json!({ "@type": "error", "code": 400 })),
            None
        );
    }
}
