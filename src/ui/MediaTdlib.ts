/**
 * Медиа карточки через СВОЮ TDLib — чистая логика (SP-15 срез 5, D-071).
 *
 * Приказ владельца (2026-10-13): «Гоним всё через TDLib ровно так, как и файлы».
 * Причина: серверный прокси идёт через Bot API `getFile`, который отдаёт ≤20 МБ,
 * поэтому крупный оригинал в галерее было видно только превью. У Desktop-клиента
 * есть СВОЯ TDLib-сессия того же аккаунта → байты берём локально, лимита нет,
 * трафик VPS не тратится.
 *
 * Здесь только ЧИСТЫЕ функции (никакого DOM/TDLib/RPC): тесты
 * `tests/media-tdlib.test.ts`. Боевой конвейер — `src/ui/MediaFetch.ts`.
 *
 * Ключ резолва — `anchor` (`tg_chat_id`/`tg_message_id`/`tg_file_unique_id` из
 * `GET /desktop/cards/.../media`). `unique_id` приоритетен: bot-side `message_id`
 * в клиентской TDLib сдвинут (`real << 20`, BUG-DOWNLOAD-052).
 */

/** Якорь медиа в Telegram (откуда клиент берёт байты своим TDLib). */
export interface MediaAnchor {
  /** Чат якоря: для личной карточки — ЛС пользователя с ботом. */
  chatId: number;
  /** Bot-side id сообщения (может промахиваться — `uniqueId` надёжнее). */
  messageId: number;
  /** `tg_file_unique_id` — сессионно-независимый ключ файла Telegram. */
  uniqueId: string;
  /** Размер оригинала (0 = неизвестен) — страховка строгого резолва. */
  sizeBytes: number;
}

export type MediaVariant = "thumb" | "full";

/** Ответ движка `tdlib_get_message_file` (поля, которые нам нужны). */
export interface MediaDocInfo {
  file_id?: number;
  size?: number;
  unique_id?: string;
  thumb_file_id?: number;
  thumb_size?: number;
  thumb_unique_id?: string;
  file_name?: string;
}

/** Прогресс single-download движка (`tdlib-download-progress`). */
export interface MediaDownloadProgress {
  file_id?: number;
  downloaded?: number;
  total?: number;
  completed?: boolean;
  error?: string | null;
}

/** Поля медиа-элемента, из которых собирается якорь. */
export interface MediaAnchorFields {
  tg_chat_id?: number | null;
  tg_message_id?: number | null;
  tg_file_unique_id?: string | null;
  size_bytes?: number | null;
}

/**
 * Собрать якорь из полей медиа (или `null`, если TDLib-путь невозможен).
 *
 * Требуется `chatId` И хотя бы один ключ сообщения (`messageId` либо
 * `uniqueId`): без чата резолв бессмыслен, без ключа — неоднозначен. Якоря
 * отдаёт ТОЛЬКО `GET /desktop/cards/.../media` (владелец); в выдаче поиска их
 * нет намеренно (координаты чужого PM не раскрываем).
 */
export function mediaAnchorOf(raw: MediaAnchorFields | null | undefined): MediaAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const chatId = Number(raw.tg_chat_id ?? 0);
  const messageId = Number(raw.tg_message_id ?? 0);
  const uniqueId = String(raw.tg_file_unique_id ?? "").trim();
  const sizeBytes = Number(raw.size_bytes ?? 0);
  if (!Number.isFinite(chatId) || chatId <= 0) return null;
  const hasKey = (Number.isFinite(messageId) && messageId > 0) || uniqueId.length > 0;
  if (!hasKey) return null;
  return {
    chatId,
    messageId: Number.isFinite(messageId) && messageId > 0 ? messageId : 0,
    uniqueId,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
  };
}

/**
 * Какой файл качать под вариант: миниатюру (`thumb`) или оригинал (`full`).
 *
 * Fail-open: миниатюры у документа может не быть (`thumb_file_id=0`) — тогда
 * превью-слот тоже тянет оригинал (поведение сервера 1-в-1). Нет основного
 * файла → 0 (вызывающий обязан упасть в fallback, а не качать «что-то»).
 */
export function pickMediaFileId(
  info: MediaDocInfo | null | undefined,
  variant: MediaVariant,
): number {
  const main = Number(info?.file_id ?? 0);
  if (variant === "full") return main > 0 ? main : 0;
  const thumb = Number(info?.thumb_file_id ?? 0);
  if (thumb > 0) return thumb;
  return main > 0 ? main : 0;
}


/** Ожидаемый размер выбранного файла (0 = неизвестен). */
export function expectedMediaBytes(
  info: MediaDocInfo | null | undefined,
  variant: MediaVariant,
): number {
  const main = Number(info?.size ?? 0);
  if (variant === "full") return main > 0 ? main : 0;
  const thumb = Number(info?.thumb_size ?? 0);
  if (thumb > 0) return thumb;
  return main > 0 ? main : 0;
}

/** Ключ кеша байтов: один чат × один файл × один вариант. */
export function mediaCacheKey(anchor: MediaAnchor, variant: MediaVariant): string {
  const uid = anchor.uniqueId || `m${anchor.messageId}`;
  return `c${anchor.chatId}:${uid}:${variant}`;
}

/** Расширение из имени файла Telegram (`.jpg`), либо `""`. */
function extensionOf(fileName: string | undefined): string {
  const name = String(fileName || "").trim();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? `.${ext.toLowerCase()}` : "";
}

/** Безопасный фрагмент имени файла (непечатное/разделители → `_`). */
function sanitizeNamePart(value: string, fallback: string): string {
  const clean = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean ? clean.slice(0, 48) : fallback;
}

/**
 * Имя файла в медиа-кеше движка.
 *
 * Миниатюра Telegram — всегда JPEG (её рендерит сам Telegram), оригинал приезжает
 * документом → расширение берём из имени (`file_name`), иначе нейтральное `.img`
 * (для `file://` этого достаточно; HEIC Chromium не покажет в любом случае).
 */
export function mediaCacheFileName(
  anchor: MediaAnchor,
  variant: MediaVariant,
  fileName?: string | null,
): string {
  const uid = sanitizeNamePart(anchor.uniqueId, `m${anchor.messageId}`);
  if (variant === "thumb") return `c${anchor.chatId}_thumb_${uid}.jpg`;
  return `c${anchor.chatId}_full_${uid}${extensionOf(fileName ?? undefined) || ".img"}`;
}

/** Склейка пути: разделитель берём из `dir` (Windows/POSIX), без двойных слэшей. */
export function joinLocalPath(dir: string, name: string): string {
  const base = String(dir || "").trim();
  const file = String(name || "").trim();
  if (!base) return file;
  if (!file) return base;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${file}`;
}

/** Абсолютный `file://`-адрес локального файла (превью и оригинал галереи). */
export function localFileUrl(filePath: string): string {
  const clean = String(filePath || "").replace(/\\/g, "/");
  if (!clean) return "";
  // Windows-диск → file:///C:/…, POSIX → file:///home/…
  const withScheme = clean.startsWith("/") ? `file://${clean}` : `file:///${clean}`;
  // encodeURI не трогает `#` (зарезервирован) — иначе имя файла с `#` обрежется.
  return encodeURI(withScheme).replace(/#/g, "%23");
}

/**
 * Терминальное состояние события скачивания: `done` (файл на диске) либо `error`.
 *
 * `completed=false` без ошибки — это ещё прогресс (движку «доверять на слово»
 * нельзя: у parts-конвейера финальный `updateFile` приходит и после `completed`).
 */
export function mediaDownloadOutcome(
  ev: MediaDownloadProgress | null | undefined,
): { done: boolean; error: string | null } {
  if (!ev) return { done: false, error: null };
  const err = ev.error ? String(ev.error) : "";
  if (err) return { done: false, error: err };
  return { done: ev.completed === true, error: null };
}
