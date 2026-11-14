/**
 * Очередь фото карточки (SP-15 срез 3b, D-069 v4) — ЧИСТАЯ модель, без DOM и TDLib.
 *
 * Приказ владельца (2026-10-13): «пользователь должен сразу видеть, куда и как
 * цепляется медиа, и видеть превью уже выбранного — и после завершения загрузки
 * прошивки происходит прикрепление». Поэтому выбор фото идёт ДО появления карточки
 * (карточки ещё нет — она рождается на `/complete`), файлы лежат локально в очереди,
 * а отправка запускается автоматически, когда карточка привязана.
 *
 * Лимит фото на карточку — серверный (`media/init` и список медиа отдают `max_media`);
 * здесь он хранится как значение очереди, а `MAX_MEDIA_FALLBACK` — только для UI до
 * первого ответа сервера (анти-дрейф-гейт сверяет его с `bot/services/card_media_service.py`).
 */

/** Значение лимита до первого ответа сервера (сервер: `MAX_PER_CARD`). */
export const MAX_MEDIA_FALLBACK = 5;

export interface LocalMediaFile {
  path: string;
  name: string;
  size: number;
  /** Готовый `blob:`-адрес превью (если диалог его дал); иначе строим `file://`. */
  previewUrl?: string;
}

export type MediaItemStatus = "waiting" | "sending" | "sent" | "error";

export interface MediaQueueItem extends LocalMediaFile {
  id: number;
  status: MediaItemStatus;
  /** Причина отказа бота/сервера (только для `error`). */
  error?: string;
}

export type MediaAddRejection = "limit" | "duplicate" | "no_path";

export interface MediaAddResult {
  added: MediaQueueItem[];
  rejected: Array<{ path: string; reason: MediaAddRejection }>;
}

export class CardMediaQueue {
  private seq = 0;
  private readonly list: MediaQueueItem[] = [];
  /** Сколько фото УЖЕ на карточке (из галереи) — тоже входит в лимит. */
  private baseline = 0;
  private limit: number;

  constructor(limit: number = MAX_MEDIA_FALLBACK) {
    this.limit = _normalizeLimit(limit);
  }

  get items(): readonly MediaQueueItem[] {
    return this.list;
  }

  get max(): number {
    return this.limit;
  }

  /** Обновить лимит из ответа сервера (`max_media`). Некорректное значение игнорируем. */
  setMax(limit: number): void {
    if (Number.isFinite(limit) && Math.floor(limit) > 0) this.limit = Math.floor(limit);
  }

  /** Сколько фото уже на карточке (в галерее). */
  setBaseline(count: number): void {
    this.baseline = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  /** Занято с учётом карточки: галерея + очередь (включая отправленные до чистки). */
  get used(): number {
    return this.baseline + this.list.length;
  }

  get full(): boolean {
    return this.used >= this.limit;
  }

  get waitingCount(): number {
    return this.list.filter((it) => it.status === "waiting").length;
  }

  get sentCount(): number {
    return this.list.filter((it) => it.status === "sent").length;
  }

  /**
   * Добавить выбранные файлы. Отклоняем: пустой путь, повтор (по пути), превышение
   * лимита. Возвращаем добавленные и причины отказов — UI показывает их честно.
   */
  add(files: LocalMediaFile[]): MediaAddResult {
    const added: MediaQueueItem[] = [];
    const rejected: Array<{ path: string; reason: MediaAddRejection }> = [];
    for (const file of files ?? []) {
      const filePath = String(file?.path ?? "");
      if (!filePath) {
        rejected.push({ path: filePath, reason: "no_path" });
        continue;
      }
      if (this.list.some((it) => it.path === filePath)) {
        rejected.push({ path: filePath, reason: "duplicate" });
        continue;
      }
      if (this.used >= this.limit) {
        rejected.push({ path: filePath, reason: "limit" });
        continue;
      }
      const item: MediaQueueItem = {
        id: (this.seq += 1),
        path: filePath,
        name: String(file?.name ?? "") || filePath.split(/[\\/]/).pop() || filePath,
        size: Number.isFinite(file?.size) && file.size > 0 ? Number(file.size) : 0,
        ...(file?.previewUrl ? { previewUrl: String(file.previewUrl) } : {}),
        status: "waiting",
      };
      this.list.push(item);
      added.push(item);
    }
    return { added, rejected };
  }

  /** Взять следующее фото к отправке (переводит в `sending`). Ошибки не авторетраим. */
  takeNext(): MediaQueueItem | null {
    const item = this.list.find((it) => it.status === "waiting");
    if (!item) return null;
    item.status = "sending";
    return item;
  }

  markSent(id: number): void {
    const item = this.list.find((it) => it.id === id);
    if (item) {
      item.status = "sent";
      item.error = undefined;
    }
  }

  markError(id: number, error: string): void {
    const item = this.list.find((it) => it.id === id);
    if (item) {
      item.status = "error";
      item.error = error;
    }
  }

  /** Вернуть упавшее фото в очередь (кнопка «Повторить»). */
  retry(id: number): boolean {
    const item = this.list.find((it) => it.id === id && it.status === "error");
    if (!item) return false;
    item.status = "waiting";
    item.error = undefined;
    return true;
  }

  /** Убрать элемент из очереди; возвращаем его (вызывающий освободит превью). */
  remove(id: number): MediaQueueItem | null {
    const index = this.list.findIndex((it) => it.id === id);
    if (index < 0) return null;
    return this.list.splice(index, 1)[0];
  }

  /**
   * Убрать уже отправленные (галерея карточки теперь — источник правды).
   * Возвращаем отсоединённые элементы, чтобы вызывающий освободил их превью.
   */
  clearSent(): MediaQueueItem[] {
    const done = this.list.filter((it) => it.status === "sent");
    for (const item of done) {
      const index = this.list.indexOf(item);
      if (index >= 0) this.list.splice(index, 1);
    }
    return done;
  }

  /**
   * Убрать «хвосты» прошлой карточки (отправленные/упавшие), СОХРАНИВ ждущие.
   *
   * Нужно при привязке к новой карточке: очередь набиралась ДО её появления (карточка
   * рождается на `/complete`), поэтому ждущие элементы принадлежат именно ей.
   */
  dropSettled(): MediaQueueItem[] {
    const settled = this.list.filter((it) => it.status === "sent" || it.status === "error");
    for (const item of settled) {
      const index = this.list.indexOf(item);
      if (index >= 0) this.list.splice(index, 1);
    }
    this.baseline = 0;
    return settled;
  }

  /** Полная очистка (смена карточки/страницы) — возвращает всё, что было. */
  clear(): MediaQueueItem[] {
    const all = [...this.list];
    this.list.length = 0;
    this.baseline = 0;
    return all;
  }
}

function _normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && Math.floor(limit) > 0 ? Math.floor(limit) : MAX_MEDIA_FALLBACK;
}
