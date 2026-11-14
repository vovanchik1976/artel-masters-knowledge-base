/**
 * Маппинг частей сервера (`DownloadInitResponse.parts`) в Rust-descriptor
 * parts-конвейера (multi/vault/composite).
 *
 * BUG-DOWNLOAD-051 (live 2026-09-25, files.id=35/38): для pm_lease сервер отдаёт
 * координаты PM-доставки пер-частово (`pm_delivery`). Их ОБЯЗАТЕЛЬНО донести до
 * Rust: `tg_file_id` части — это Vault-якорь (bot-side file_id), который чужая
 * TDLib-сессия резолвить не может (`getRemoteFile → 400 Invalid remote file
 * identifier`). Rust резолвит document из СВОЕГО PM-сообщения
 * (getMessage → fallback getChatHistory), как в owner-backdoor flow.
 */

/** MultiPartDescriptor из TypeScript в Rust (`parts_download.rs::parse_parts`). */
export interface MultiPartDescriptor {
  tg_file_id: string;
  part_index: number;
  expected_sha256: string | null;
  expected_size: number | null;
  /** Hint-чат (join/getChat + getMessage-warmup); для PM-lease это id бота. */
  chat_id?: number;
  message_id?: number;
  /** BUG-DOWNLOAD-051: пер-частовый PM-якорь доставки (pm_lease). */
  pm_chat_id?: number;
  pm_message_id?: number;
  /**
   * BUG-DOWNLOAD-052: `tg_file_unique_id` части — сессионно-независимый ключ
   * документа (TDLib `remote.unique_id`). Различает части ОДИНАКОВОГО размера
   * (files.id=38: 2 × 2 093 796 556 Б) и не сбивается посторонними документами
   * в окне истории PM.
   */
  pm_unique_id?: string;
}

/** Часть из ответа сервера (DownloadPartInfo) — только нужные поля. */
export interface ServerDownloadPart {
  index: number;
  size: number;
  sha256?: string;
  tg_file_id: string;
  /** BUG-DOWNLOAD-052: `tg_file_unique_id` документа части (стабильный ключ). */
  unique_id?: string;
  mtproto?: {
    mtproto_chat_id?: number | null;
    mtproto_message_id?: number | null;
  } | null;
  /** Контракт PM-Lease (BUG-DOWNLOAD-051): координаты delivery-сообщения. */
  pm_delivery?: {
    chat_id?: number | null;
    message_id?: number | null;
    size?: number | null;
    order?: number | null;
    /** BUG-DOWNLOAD-052: стабильный ключ документа доставки. */
    unique_id?: string | null;
  } | null;
}

/**
 * DownloadRcaLog — зеркало лога вкладки «Передача» в файл (Linux-dev, e2e-prod32).
 *
 * Мост `engine.appendDownloadRca` (electron/main.ts → download-rca.log в
 * FW_ELECTRON_LOG_DIR). Best-effort: вне Electron (юнит-тесты) — no-op.
 * Формат строки — JSON с полями op/phase/... (те же, что Rust `[dl-rca]`),
 * чтобы single и multi лежали рядом.
 */
export function appendDownloadRca(entry: Record<string, unknown>): void {
  try {
    const w = window as unknown as {
      fwCloud?: { invoke: <R>(c: string, a?: Record<string, unknown>) => Promise<R> };
    };
    const line = JSON.stringify(entry);
    void w.fwCloud?.invoke("engine.appendDownloadRca", { line })?.catch(() => {});
  } catch {
    /* best-effort — лог не должен ломать передачу */
  }
}

/**
 * Является ли `tg_file_id` TDLib-совместимым (base64 remote_file_id).
 * MTProto numeric ID — строка из цифр; TDLib такие не резолвит.
 */
export function isTdlibRemoteFileId(tg_file_id: string): boolean {
  return !/^\d+$/.test(tg_file_id);
}

/**
 * Descriptors частей для owner-multi-download (BUG-DOWNLOAD-052, фаза 3).
 *
 * Части ЛИЧНОГО файла доставляются ботом в PM владельца; клиентский `tg_file_id`
 * для чужой сессии невалиден, поэтому резолв идёт по pm-якорю доставки
 * (`pm_chat_id`/`pm_message_id`) и стабильному `pm_unique_id`. Пустой
 * `tg_file_id` Rust допускает именно при наличии pm-якоря (`parse_parts`).
 */
export function buildOwnerPartDescriptors(parts: ServerOwnerPart[]): MultiPartDescriptor[] {
  return (parts || [])
    .map((p, i) => {
      const pm = p.pm_delivery ?? {};
      const pmChat = pm.chat_id ?? null;
      const pmMsg = pm.message_id ?? null;
      const uniqueRaw = pm.unique_id ?? p.unique_id ?? null;
      const uniqueId =
        typeof uniqueRaw === "string" && uniqueRaw.length > 0 ? uniqueRaw : undefined;
      const fileIdRaw = p.tg_file_id ?? "";
      const tgFileId =
        fileIdRaw.length > 0 && isTdlibRemoteFileId(fileIdRaw) ? fileIdRaw : "";
      return {
        tg_file_id: tgFileId,
        part_index: typeof p.index === "number" ? p.index : i,
        expected_sha256: null,
        expected_size: p.size ?? null,
        pm_chat_id: pmChat != null && pmChat !== 0 ? pmChat : undefined,
        pm_message_id: pmMsg != null && pmMsg !== 0 ? pmMsg : undefined,
        pm_unique_id: uniqueId,
      } as MultiPartDescriptor;
    })
    .sort((a, b) => a.part_index - b.part_index);
}

/** Часть owner-доставки (ответ `POST /desktop/vault/owner/{tg}/files/{id}/download`). */
export interface ServerOwnerPart {
  index?: number | null;
  size?: number | null;
  unique_id?: string | null;
  tg_file_id?: string | null;
  pm_delivery?: {
    chat_id?: number | null;
    message_id?: number | null;
    size?: number | null;
    order?: number | null;
    unique_id?: string | null;
  } | null;
}

/**
 * Параметры резолва delivery-документа в СВОЕЙ TDLib-сессии.
 *
 * BUG-DOWNLOAD-052 (фаза 3, owner-backdoor): bot-side `delivery_message_id`
 * (= Bot API id) НЕ равен MTProto id сообщения, поэтому резолв по нему в
 * TDLib-сессии владельца промахивается; «самый свежий документ чата» — тоже
 * ненадёжная эвристика (в PM живут посторонние документы). Приоритет — стабильный
 * `unique_id` (TDLib `remote.unique_id` = Bot-API `file_unique_id`) + размер.
 */
export interface OwnerResolveParams {
  chatId: number;
  messageId: number;
  uniqueId?: string;
  expectedSize?: number;
  /** Совместимость с `invoke(cmd, Record<string, unknown>)` (Tauri/Electron bridge). */
  [key: string]: unknown;
}

/**
 * Собрать параметры `tdlib_get_message_file` для owner-download.
 *
 * `uniqueId`/`expectedSize` включают strict-резолв Rust (`resolve_pm_part_document`:
 * getMessage-кандидаты → история PM по `unique_id`, затем по размеру). Без них
 * (старый сервер) остаётся прежний путь «самый свежий документ чата».
 */
export function buildOwnerResolveParams(meta: {
  owner_pm_chat_id?: number | null;
  delivery_message_id?: number | null;
  delivery_unique_id?: string | null;
  size_bytes?: number | null;
}): OwnerResolveParams {
  const chatId = Number(meta.owner_pm_chat_id ?? 0);
  const messageId = Number(meta.delivery_message_id ?? 0);
  const uniqueRaw = meta.delivery_unique_id ?? null;
  const uniqueId =
    typeof uniqueRaw === "string" && uniqueRaw.length > 0 ? uniqueRaw : undefined;
  const sizeRaw = Number(meta.size_bytes ?? 0);
  const expectedSize = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : undefined;
  return expectedSize != null
    ? { chatId, messageId, uniqueId, expectedSize }
    : { chatId, messageId, uniqueId };
}

/**
 * Собрать descriptors частей для Rust. `fallbackChatId` — hint-чат из первой
 * части (`mtproto.mtproto_chat_id`); 0/null → не передаём (BUG-CROSS-USER-003).
 */
export function buildMultiPartDescriptors(
  parts: ServerDownloadPart[],
  fallbackChatId: number | null | undefined,
): MultiPartDescriptor[] {
  const hintChatId =
    fallbackChatId != null && fallbackChatId !== 0 ? fallbackChatId : undefined;

  return (parts || [])
    .filter((p) => !!p.tg_file_id && p.tg_file_id.length > 0 && isTdlibRemoteFileId(p.tg_file_id))
    .map((p) => {
      const pmChatRaw = p.pm_delivery?.chat_id ?? null;
      const pmMsgRaw = p.pm_delivery?.message_id ?? null;
      const pmChatId = pmChatRaw != null && pmChatRaw !== 0 ? pmChatRaw : undefined;
      const pmMessageId = pmMsgRaw != null && pmMsgRaw !== 0 ? pmMsgRaw : undefined;
      // BUG-DOWNLOAD-052: стабильный ключ документа части — приоритетный
      // критерий резолва в истории PM (части с одинаковым размером различаются).
      const pmUniqueRaw = p.pm_delivery?.unique_id ?? p.unique_id ?? null;
      const pmUniqueId =
        typeof pmUniqueRaw === "string" && pmUniqueRaw.length > 0 ? pmUniqueRaw : undefined;
      return {
        tg_file_id: p.tg_file_id,
        part_index: p.index,
        expected_sha256: p.sha256 && p.sha256.length > 0 ? p.sha256 : null,
        expected_size: p.size ?? null,
        chat_id: hintChatId,
        message_id: p.mtproto?.mtproto_message_id ?? undefined,
        pm_chat_id: pmChatId,
        pm_message_id: pmMessageId,
        pm_unique_id: pmUniqueId,
      };
    });
}
