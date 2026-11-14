/**
 * Загрузка фото в карточку (SP-15 v3, D-069) — «отдельный инструмент в описании».
 *
 * Поток: `media/init` (сервер создаёт джобу и отдаёт координаты) → клиент шлёт фото
 * боту своим TDLib (движок сам ставит caption `upload_id:<uuid>`) → бот постит фото
 * В ТУ ЖЕ ТЕМУ карточки → `media/complete` (статус + обновлённый список медиа).
 *
 * Типы объявлены локально (структурно совместимы с `api.ts`), чтобы модуль и его
 * тесты не тянули `import.meta` из API-клиента. Зависимости инжектируются —
 * логика покрыта тестами без Electron/TDLib.
 */

/** Владелец карточки: публичный файл каталога или личный файл Vault. */
export type MediaCardKind = "file" | "personal";

export interface MediaInitResult {
  ok: boolean;
  upload_id: string;
  mode: string;
  vault_chat_id: number;
  topic_id: number | null;
  pm_chat_id: number | null;
  caption_hint?: string;
  max_media?: number;
}

export interface MediaCompleteResult {
  ok: boolean;
  status: string;
  error: string | null;
  /** Список медиа карточки (форма — забота вызывающего; загрузчик его не парсит). */
  media: unknown[];
}

/** Хуки наблюдателя одной отправки (кольцо прогресса на элементе очереди). */
export interface MediaUploadHooks {
  /** Ответ `media/init` — в частности серверный лимит фото (`max_media`). */
  onInit?: (init: MediaInitResult) => void;
  /**
   * Rust-идентификатор передачи. По нему матчатся события `tdlib-upload-progress`
   * (поле `upload_id` = значение, возвращённое `tdlib_start_upload`).
   */
  onUploadStarted?: (rustUploadId: string) => void;
}

export interface MediaUploaderDeps {
  init: (kind: MediaCardKind, cardId: number) => Promise<MediaInitResult>;
  startUpload: (args: {
    filePath: string;
    chatId: number;
    pm: boolean;
    sessionUploadId: string;
  }) => Promise<string>;
  waitUpload: (rustUploadId: string) => Promise<unknown>;
  complete: (
    kind: MediaCardKind,
    cardId: number,
    uploadId: string,
  ) => Promise<MediaCompleteResult>;
  /** Пауза между опросами `complete` (бот постит в тему асинхронно). */
  pollDelayMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_DELAY_MS = 1500;
const DEFAULT_MAX_POLLS = 12;

export class CardMediaUploader {
  constructor(private readonly deps: MediaUploaderDeps) {}

  /**
   * Загрузить одно фото в карточку. Возвращает итог с актуальным списком медиа.
   *
   * `hooks` — необязательный наблюдатель (лимит из `init` + rust-id передачи для
   * кольца прогресса); контракт без хуков не меняется.
   *
   * Бросает: нет chat_id от сервера / джоба отклонена ботом (`failed`) /
   * таймаут ожидания обработки.
   */
  async addPhoto(
    kind: MediaCardKind,
    cardId: number,
    filePath: string,
    hooks?: MediaUploadHooks,
  ): Promise<MediaCompleteResult> {
    const init = await this.deps.init(kind, cardId);
    hooks?.onInit?.(init);
    const pmChatId = Number(init.pm_chat_id ?? 0);
    const chatId = pmChatId > 0 ? pmChatId : Number(init.vault_chat_id ?? 0);
    if (!chatId) {
      throw new Error("media: сервер не вернул chat_id для загрузки");
    }

    const rustUploadId = await this.deps.startUpload({
      filePath,
      chatId,
      pm: pmChatId > 0,
      sessionUploadId: init.upload_id,
    });
    hooks?.onUploadStarted?.(rustUploadId);
    await this.deps.waitUpload(rustUploadId);

    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxPolls = Math.max(1, this.deps.maxPolls ?? DEFAULT_MAX_POLLS);
    const delay = Math.max(0, this.deps.pollDelayMs ?? DEFAULT_POLL_DELAY_MS);
    let last: MediaCompleteResult | null = null;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      last = await this.deps.complete(kind, cardId, init.upload_id);
      if (last.status === "failed") {
        throw new Error(last.error || "media: бот отклонил медиа");
      }
      if (last.status === "completed") {
        return last;
      }
      if (attempt < maxPolls - 1) {
        await sleep(delay);
      }
    }
    throw new Error("media: таймаут ожидания обработки ботом");
  }
}
