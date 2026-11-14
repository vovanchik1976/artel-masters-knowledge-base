/**
 * «Отправить другу» — чистые помощники (SP-33, D-175).
 *
 * Модуль без DOM: только данные и решения, которые легко покрыть юнит-тестами
 * (node:test не умеет DOM). Всё, что рисуется, живёт в SearchPage/App.
 */

/** Элемент справочника пользователей ARTEL (см. `VaultDirectoryItem`). */
export interface DirectoryEntry {
  user_ref: string;
  display_name: string;
  username?: string | null;
  /**
   * У получателя ДЕЙСТВУЮЩЕЕ личное хранилище (сервер отдаёт только таких).
   * Поле-страховка: `false` (старый/чужой сервер) — строку не показываем.
   */
  vault_active?: boolean;
}

/** Входящая передача (см. `VaultIncomingShare`). */
export interface IncomingShare {
  share_id: number;
  sender_tg_id: number;
  sender_name: string;
  file_name: string;
  size_bytes: number;
  expires_at: string | null;
  expires_in_hours: number;
  parts_count: number;
}

/**
 * Поиск получателя по справочнику.
 *
 * Регистронезависимо и по кириллице (обычный `toLowerCase` не трогает
 * кириллицу в JS так, как это делает серверный casefold) — сравниваем по
 * `toLocaleLowerCase()` без локали.
 */
export function filterDirectory(
  items: DirectoryEntry[],
  query: string,
): DirectoryEntry[] {
  // Файл можно отдать только мастеру с активным хранилищем: `vault_active`
  // приходит с сервера, но клиент не доверяет отсутствию поля на слово
  // (`false` — прячем строку), иначе получатель не сможет принять файл.
  const q = (query || "").trim().toLocaleLowerCase();
  const eligible = items.filter((item) => item.vault_active !== false);
  if (!q) return eligible;
  return eligible.filter((item) => {
    const name = (item.display_name || "").toLocaleLowerCase();
    const username = (item.username || "").toLocaleLowerCase();
    return name.includes(q) || username.includes(q);
  });
}

/** Инициалы для аватара-кружка: «Иван Петров» → «ИП», «Мастер» → «М». */
export function directoryInitials(name: string | null | undefined): string {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] || "";
  const second = words.length > 1 ? Array.from(words[1])[0] || "" : "";
  return (first + second).toLocaleUpperCase() || "?";
}

/** Подпись получателя в списке: «Имя (@nick)». */
export function directoryEntryLabel(item: DirectoryEntry): string {
  const name = (item.display_name || "").trim();
  const username = (item.username || "").trim();
  if (name && username) return `${name} (@${username.replace(/^@/, "")})`;
  if (name) return name;
  if (username) return `@${username.replace(/^@/, "")}`;
  return "—";
}

/** Сколько часов осталось до истечения ссылки (0 = истекла). */
export function remainingHours(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!expiresAt) return 0;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return 0;
  const diff = Math.floor((ts - nowMs) / 3_600_000);
  return diff > 0 ? diff : 0;
}

/** Истекла ли ссылка (для блокировки кнопок «Принять»). */
export function isShareExpired(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresAt) return true;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return true;
  return ts <= nowMs;
}

/** Части личного файла из download-meta (SP-33: у принятого файла — PM-якорь). */
export interface VaultDownloadPart {
  index: number;
  name?: string;
  size?: number;
  sha256?: string;
  tg_file_id?: string;
  unique_id?: string | null;
  pm_delivery?: {
    chat_id?: number | null;
    message_id?: number | null;
    size?: number | null;
    order?: number | null;
    unique_id?: string | null;
  } | null;
  mtproto?: {
    mtproto_chat_id?: number | null;
    mtproto_message_id?: number | null;
  } | null;
}

/** Дескриптор части для Rust-конвейера (совпадает с MultiPartDescriptor). */
export interface VaultPartDescriptor {
  tg_file_id: string;
  part_index: number;
  expected_sha256: string | null;
  expected_size: number | null;
  chat_id?: number;
  message_id?: number;
  pm_chat_id?: number;
  pm_message_id?: number;
  pm_unique_id?: string;
}

/**
 * Собрать дескрипторы частей для скачивания ЛИЧНОГО файла.
 *
 * Два сценария (SP-33/D-175):
 *   * свой загруженный файл — есть клиентский `tg_file_id` (своя TDLib-сессия);
 *   * файл, ПРИНЯТЫЙ от другого мастера, — клиентского id нет, зато есть
 *     PM-якорь доставки (`pm_delivery`: chat_id + message_id + unique_id):
 *     клиент резолвит документ в своём чате по уникальному ключу
 *     (BUG-DOWNLOAD-051/052). Пустой `tg_file_id` при таком якоре допустим
 *     (его допускает Rust `parse_parts`).
 */
export function buildVaultPartDescriptors(
  parts: VaultDownloadPart[],
): VaultPartDescriptor[] {
  return (parts || [])
    .map((p, i) => {
      const pm = p.pm_delivery ?? {};
      const pmChat = pm.chat_id ?? null;
      const pmMsg = pm.message_id ?? null;
      const uniqueRaw = pm.unique_id ?? p.unique_id ?? null;
      const uniqueId =
        typeof uniqueRaw === "string" && uniqueRaw.length > 0 ? uniqueRaw : undefined;
      const tgFileId = typeof p.tg_file_id === "string" ? p.tg_file_id : "";
      return {
        tg_file_id: tgFileId,
        part_index: typeof p.index === "number" ? p.index : i,
        expected_sha256: p.sha256 && p.sha256.length > 0 ? p.sha256 : null,
        expected_size: p.size ?? null,
        chat_id:
          p.mtproto?.mtproto_chat_id != null && p.mtproto.mtproto_chat_id !== 0
            ? p.mtproto.mtproto_chat_id
            : undefined,
        message_id:
          p.mtproto?.mtproto_message_id != null && p.mtproto.mtproto_message_id !== 0
            ? p.mtproto.mtproto_message_id
            : undefined,
        pm_chat_id: pmChat != null && pmChat !== 0 ? pmChat : undefined,
        pm_message_id: pmMsg != null && pmMsg !== 0 ? pmMsg : undefined,
        pm_unique_id: uniqueId,
      } as VaultPartDescriptor;
    })
    .sort((a, b) => a.part_index - b.part_index);
}

/** Есть ли у части чем скачивать (клиентский id ИЛИ PM-якорь). */
export function hasDownloadAnchor(part: VaultPartDescriptor): boolean {
  if (part.tg_file_id) return true;
  return Boolean(part.pm_unique_id || (part.pm_chat_id && part.pm_message_id));
}
