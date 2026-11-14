/**
 * Загрузка вложения карточки (SP-20, `D-094`).
 *
 * Поток ТОТ ЖЕ, что у медиа SP-15 (`CardMediaUploader`), и это осознанно: отдельного
 * контура загрузки в проекте нет, новый обязательно разошёлся бы с проверенным
 * (captions `upload_id:<uuid>`, ingest в `host_ingest`, якорь сообщения).
 *
 *   `attachments/init` → сервер создаёт upload-джобу `content_kind=card_attachment`
 *   и отдаёт координаты чата → клиент шлёт документ своим TDLib (движок сам ставит
 *   caption) → бот кладёт его в ТЕМУ карточки (публичная) или якорем на исходное
 *   сообщение (личная) → `attachments/{upload_id}/complete` — статус + свежий список.
 *
 * Баллы не участвуют: вложение — не файл каталога (`D-094`), `billing` не зовётся.
 *
 * Типы объявлены локально (структурно совместимы с `api.ts`), зависимости
 * инжектируются — логика покрыта тестами без Electron/TDLib.
 */

/** Владелец карточки: публичный файл каталога или личный файл Vault. */
export type AttachmentCardKind = "file" | "personal";

/** Типы вложений — те же значения, что `ATT_KINDS` в `card_attachment_service.py`. */
export const ATTACHMENT_KINDS = [
  "isp_emmc",
  "repair_pictures",
  "service_manual",
  "bulletin",
  "other",
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Лимит вложений до первого ответа сервера (сервер: `MAX_PER_CARD_ATTACHMENTS`). */
export const MAX_ATTACHMENTS_FALLBACK = 20;

/** Лимит описания вложения (сервер: `MAX_NOTE_CHARS` в `card_attachment_service.py`). */
export const MAX_ATTACHMENT_NOTE_CHARS = 500;

export interface AttachmentInitResult {
  ok: boolean;
  upload_id: string;
  mode: string;
  vault_chat_id: number;
  topic_id: number | null;
  /** PM бота (host-mediation): куда клиент шлёт документ своим TDLib. */
  pm_chat_id: number | null;
  caption_hint?: string;
  max_attachments?: number;
}

export interface AttachmentCompleteResult {
  ok: boolean;
  status: string;
  error: string | null;
  /** Список вложений карточки (форма элемента — забота вызывающего). */
  attachments: unknown[];
}

/** Хуки наблюдателя одной отправки (кольцо прогресса / лог). */
export interface AttachmentUploadHooks {
  onInit?: (init: AttachmentInitResult) => void;
  /** Rust-идентификатор передачи (`tdlib_start_upload`). */
  onUploadStarted?: (rustUploadId: string) => void;
}

export interface AttachmentUploaderDeps {
  init: (
    kind: AttachmentCardKind,
    cardId: number,
    attKind: string,
    note: string,
  ) => Promise<AttachmentInitResult>;
  startUpload: (args: {
    filePath: string;
    chatId: number;
    pm: boolean;
    sessionUploadId: string;
  }) => Promise<string>;
  waitUpload: (rustUploadId: string) => Promise<unknown>;
  complete: (
    kind: AttachmentCardKind,
    cardId: number,
    uploadId: string,
  ) => Promise<AttachmentCompleteResult>;
  /** Пауза между опросами `complete` (бот кладёт документ в тему асинхронно). */
  pollDelayMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_DELAY_MS = 1500;
const DEFAULT_MAX_POLLS = 12;

export class AttachmentUploader {
  constructor(private readonly deps: AttachmentUploaderDeps) {}

  /**
   * Приложить один файл к карточке. Возвращает итог со свежим списком вложений.
   *
   * Бросает: нет chat_id от сервера / джоба отклонена (`failed`) / таймаут.
   */
  async add(
    kind: AttachmentCardKind,
    cardId: number,
    filePath: string,
    attKind: string,
    note = "",
    hooks?: AttachmentUploadHooks,
  ): Promise<AttachmentCompleteResult> {
    const init = await this.deps.init(kind, cardId, attKind, note);
    hooks?.onInit?.(init);
    const pmChatId = Number(init.pm_chat_id ?? 0);
    const chatId = pmChatId > 0 ? pmChatId : Number(init.vault_chat_id ?? 0);
    if (!chatId) {
      throw new Error("вложение: сервер не вернул chat_id для загрузки");
    }

    const rustUploadId = await this.deps.startUpload({
      filePath,
      chatId,
      pm: pmChatId > 0,
      sessionUploadId: init.upload_id,
    });
    hooks?.onUploadStarted?.(rustUploadId);
    await this.deps.waitUpload(rustUploadId);

    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxPolls = Math.max(1, this.deps.maxPolls ?? DEFAULT_MAX_POLLS);
    const delay = Math.max(0, this.deps.pollDelayMs ?? DEFAULT_POLL_DELAY_MS);
    let last: AttachmentCompleteResult | null = null;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      last = await this.deps.complete(kind, cardId, init.upload_id);
      if (last.status === "failed") {
        throw new Error(last.error || "вложение: бот отклонил файл");
      }
      if (last.status === "completed") {
        return last;
      }
      if (attempt < maxPolls - 1) {
        await sleep(delay);
      }
    }
    throw new Error("вложение: таймаут ожидания обработки ботом");
  }
}
