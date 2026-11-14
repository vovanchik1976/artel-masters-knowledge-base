/**
 * Панель медиа карточки (SP-15 срез 3b, D-069 v4) — «инструмент в описании файла».
 *
 * Приказ владельца (2026-10-13): пользователь ВЫБИРАЕТ фото сразу (видит превью и
 * лимит), а прикрепление к теме карточки происходит АВТОМАТИЧЕСКИ после завершения
 * загрузки прошивки. Причина: карточки ещё нет до `/complete` (её id рождается там),
 * а гонять пользователя «сначала загрузи прошивку, потом ищи свою карточку» — дефект
 * живого прогона. Поэтому файлы лежат в локальной очереди (`CardMediaQueue`) и уходят
 * в ту же тему, как только панель привязана к карточке.
 *
 * Контракт: `max_media` (лимит фото на карточку) — СЕРВЕРНЫЙ, из `media/init` и из
 * списка медиа (`GET /desktop/cards/{kind}/{id}/media`); `MAX_MEDIA_FALLBACK` в
 * `CardMediaQueue` — только до первого ответа сервера.
 *
 * Превью: локальный файл показывается по `file://`-адресу (та же машина, поэтому это
 * дешевле и точнее любого фетча); если Chromium файл не отдал — элемент деградирует
 * до иконки, без падения панели. Превью С КАРТОЧКИ (уже загруженные фото) тянутся
 * JS-ом с токеном → `blob:` (тег `<img>` не шлёт `Authorization`).
 *
 * Зависимости инжектируются — контракт закрыт гейтами `tests/upload-card-media.test.ts`
 * и `tests/card-media-queue.test.ts`.
 */

import type { MediaCompleteResult, MediaUploadHooks } from "./CardMediaUploader";
import type { ResolvedMedia } from "./MediaGallery";
import { bindMediaGallery, renderMediaGalleryHtml, resolveCardMedia } from "./MediaGallery";
import { fullSizeResolver, loadProtectedThumbs, revokeObjectUrls } from "./MediaAuth";
import { openMediaLightbox } from "./MediaLightbox";
import { localFileUrl } from "./MediaTdlib";
import {
  CardMediaQueue,
  type LocalMediaFile,
  type MediaQueueItem,
  type MediaItemStatus,
} from "./CardMediaQueue";
import { formatBytes } from "./format";
import { mediaSizeNotice } from "./MediaSize";
import { renderProgressRingHtml, setProgressRing } from "./ProgressRing";
import { t } from "../i18n";

/** Владелец карточки: публичный файл каталога или личный файл Vault. */
export type CardKind = "file" | "personal";

/** Карточка, к которой цепляется медиа. */
export interface CardRef {
  kind: CardKind;
  cardId: number;
}

/**
 * Карточка из ответа `POST /desktop/uploads/.../complete`.
 *
 * Публичный путь → `file_id` (он же приходит для дедупа `duplicate`/`reanchored`:
 * карточка уже в каталоге — медиа цепляем к ней). Личный путь → `personal_file_id`.
 * Пусто/`0`/не-число → `null`: панель не показываем, загрузка не страдает (fail-open).
 */
export function uploadedCardRef(result: unknown): CardRef | null {
  if (!result || typeof result !== "object") return null;
  const raw = result as Record<string, unknown>;
  const personalId = Number(raw.personal_file_id ?? 0);
  if (Number.isFinite(personalId) && personalId > 0) {
    return { kind: "personal", cardId: personalId };
  }
  const fileId = Number(raw.file_id ?? 0);
  if (Number.isFinite(fileId) && fileId > 0) {
    return { kind: "file", cardId: fileId };
  }
  return null;
}

/** Событие передачи одного фото (`tdlib-upload-progress`, `upload_id` = rust-id). */
export interface MediaProgressEvent {
  upload_id: string;
  bytes_uploaded: number;
  total: number;
}

export interface CardMediaPanelDeps {
  /** Канонический домен сервера (относительные `thumb_url` → абсолютные). */
  baseUrl: () => string;
  /** `GET /desktop/cards/{kind}/{id}/media` — только для своего контейнера. */
  list: (kind: CardKind, cardId: number) => Promise<{ media?: unknown; max_media?: number }>;
  /**
   * Байты медиа: своя TDLib (`file://`), иначе серверный прокси (`blob:`).
   * Элемент передаём вторым аргументом — фетчер сам решает путь по якорю.
   */
  fetchBytes: (url: string, item?: ResolvedMedia) => Promise<string>;
  /** init → TDLib-передача фото → complete (полный цикл, `CardMediaUploader`). */
  addPhoto: (
    kind: CardKind,
    cardId: number,
    filePath: string,
    hooks?: MediaUploadHooks,
  ) => Promise<MediaCompleteResult | { media?: unknown }>;
  /** Диалог выбора фото → пути + размеры (инжектится: тесты не тянут Electron). */
  pickPhotos: () => Promise<LocalMediaFile[]>;
  /** Подписка на прогресс передачи (кольцо на элементе очереди). */
  listenProgress?: (cb: (e: MediaProgressEvent) => void) => () => void;
  /** Строка в лог страницы. */
  log: (msg: string, type?: string) => void;
}

/** Абсолютный `file://`-адрес локального файла (превью выбранного фото). */
export { localFileUrl };

function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value: string): string {
  return esc(value).replace(/"/g, "&quot;");
}

export class CardMediaPanel {
  /** Локальная очередь выбранных фото (уходит в тему карточки автоматически). */
  private readonly queue = new CardMediaQueue();
  private kind: CardKind | null = null;
  private cardId = 0;
  /** Созданные `blob:`-адреса — освобождаем при перерисовке и при показе другой карточки. */
  private blobs: string[] = [];
  private galleryItems: ResolvedMedia[] = [];
  private bound = false;
  /** Отправка последовательная (одно фото за раз: тема карточки — общий чат). */
  private flushing = false;
  private currentSend: { itemId: number; rustUploadId: string } | null = null;
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: CardMediaPanelDeps,
  ) {}

  /**
   * Разметка панели + обработчики + подписка на прогресс (идемпотентно).
   *
   * Вызывается на `bindEvents()` страницы: инструмент виден СРАЗУ (ещё без карточки),
   * поэтому можно выбрать фото до нажатия «Загрузить» — приказ владельца.
   */
  bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.root.style.display = "block";
    this._subscribeProgress();
    this._render();
  }

  /** Показать панель для карточки и отправить всё, что ждало её появления. */
  async show(card: CardRef): Promise<void> {
    this.bind();
    const switched = this.kind !== card.kind || this.cardId !== card.cardId;
    this.kind = card.kind;
    this.cardId = card.cardId;
    if (switched) {
      // Очередь набиралась ДЛЯ новой карточки (её ещё не существовало) — ждущие
      // элементы сохраняем, а «хвосты» прошлой карточки (отправленные/упавшие) убираем.
      this._releaseQueue(this.queue.dropSettled());
    }
    this._render();
    await this._refreshGallery();
    await this._flush();
  }

  /** Перерисовать подписи/статусы при смене языка (очередь — модель, не DOM). */
  applyLang(): void {
    if (!this.bound) return;
    this._render();
  }

  /**
   * Отвязать панель от карточки, СОХРАНИВ очередь ждущих фото.
   *
   * Вызывается на старте новой загрузки (D-069 v4): инструмент живёт ДО карточки,
   * поэтому выбранные фото — «фото к следующей загрузке», терять их нельзя
   * (`dispose()` как раз стирал бы выбор пользователя). Галерея прошлой карточки
   * уходит вместе со своими blob-адресами, «хвосты» (отправлено/ошибка) — тоже:
   * они принадлежали прошлой карточке.
   */
  detachCard(): void {
    if (!this.bound) return;
    this._releaseQueue(this.queue.dropSettled());
    this._replaceBlobs([]);
    this.galleryItems = [];
    this.kind = null;
    this.cardId = 0;
    this.currentSend = null;
    this._render();
  }

  /** Освободить ресурсы (blob-адреса, подписка). Панель скрывается. */
  dispose(): void {
    this._unsubscribeProgress();
    this._releaseQueue(this.queue.clear());
    this._replaceBlobs([]);
    this.galleryItems = [];
    this.root.innerHTML = "";
    this.root.style.display = "none";
    this.bound = false;
    this.kind = null;
    this.cardId = 0;
    this.currentSend = null;
  }


  // ── передача ─────────────────────────────────────────────────────────────

  /** Отправить все ждущие фото (по одному). Без привязанной карточки — no-op. */
  private async _flush(): Promise<void> {
    const kind = this.kind;
    if (!kind || this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const item = this.queue.takeNext();
        if (!item) break;
        this._render();
        await this._send(kind, item);
        this._render();
      }
    } finally {
      this.flushing = false;
    }
  }

  private async _send(kind: CardKind, item: MediaQueueItem): Promise<void> {
    this.currentSend = { itemId: item.id, rustUploadId: "" };
    try {
      await this.deps.addPhoto(kind, this.cardId, item.path, {
        onInit: (init) => {
          const max = Number(init?.max_media ?? 0);
          if (max > 0) this.queue.setMax(max);
        },
        onUploadStarted: (rustUploadId) => {
          if (this.currentSend && this.currentSend.itemId === item.id) {
            this.currentSend.rustUploadId = rustUploadId;
          }
        },
      });
      this.queue.markSent(item.id);
      this.deps.log(t("media.added"), "success");
      // Галерея карточки — источник правды: после успеха обновляем и чистим очередь.
      await this._refreshGallery();
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.queue.markError(item.id, reason);
      this.deps.log(t("media.upload_failed", { reason }), "warn");
    } finally {
      this.currentSend = null;
    }
  }

  /** Выбор фото → очередь; при уже привязанной карточке отправка стартует сразу. */
  private async _pick(): Promise<void> {
    if (this.queue.full) {
      this.deps.log(t("media.limit_reached", { max: this.queue.max }), "warn");
      return;
    }
    let files: LocalMediaFile[] = [];
    try {
      files = (await this.deps.pickPhotos()) ?? [];
    } catch (err) {
      this.deps.log(t("media.upload_failed", { reason: (err as Error)?.message ?? err }), "warn");
      return;
    }
    if (!files.length) return;
    const res = this.queue.add(files);
    for (const rejected of res.rejected) {
      if (rejected.reason === "no_path") this.deps.log(t("media.need_path"), "warn");
      else if (rejected.reason === "duplicate") this.deps.log(t("media.duplicate"), "warn");
      else this.deps.log(t("media.limit_reached", { max: this.queue.max }), "warn");
    }
    this._render();
    if (res.added.length) await this._flush();
  }

  private _subscribeProgress(): void {
    if (this.unlisten || !this.deps.listenProgress) return;
    this.unlisten = this.deps.listenProgress((event) => {
      const current = this.currentSend;
      if (!current || !current.rustUploadId || event?.upload_id !== current.rustUploadId) return;
      const total = Number(event.total ?? 0);
      if (!(total > 0)) return;
      const ratio = Math.min(1, Math.max(0, Number(event.bytes_uploaded ?? 0) / total));
      this._updateRing(current.itemId, ratio);
    });
  }

  private _unsubscribeProgress(): void {
    if (!this.unlisten) return;
    try {
      this.unlisten();
    } catch {
      /* отписка уже могла упасть (окно закрывается) — не беда */
    }
    this.unlisten = null;
  }


  // ── данные карточки ──────────────────────────────────────────────────────

  private async _refreshGallery(): Promise<void> {
    const kind = this.kind;
    if (!kind) return;
    try {
      const res = await this.deps.list(kind, this.cardId);
      const max = Number(res?.max_media ?? 0);
      if (max > 0) this.queue.setMax(max);
      const items = resolveCardMedia(res?.media as never, this.deps.baseUrl(), {
        // Своя карточка: даже одобренная публичная может быть не видна `<img>`-ом
        // (маршрут для неодобренной fail-closed) — безопаснее тянуть с токеном.
        authorized: true,
      });
      const loaded = await loadProtectedThumbs(items, (url, item) =>
        this.deps.fetchBytes(url, item),
      );
      this._replaceBlobs(loaded.objectUrls);
      this.galleryItems = loaded.items;
      this._releaseQueue(this.queue.clearSent());
      this.queue.setBaseline(loaded.items.length);
      this._render();
    } catch (err) {
      // fail-open: нет медиа/нет доступа — панель остаётся с кнопкой «Добавить».
      this.deps.log(`Media list failed: ${(err as Error)?.message ?? String(err)}`, "warn");
    }
  }

  // ── рендер ───────────────────────────────────────────────────────────────

  private _statusText(): string {
    if (!this.kind) return t("media.wait_card");
    if (this.queue.items.some((it) => it.status === "sending")) return t("media.sending_now");
    return t("media.card_bound", { id: this.cardId });
  }

  private _stateText(item: MediaQueueItem): string {
    switch (item.status) {
      case "waiting":
        return t("media.st_waiting");
      case "sending":
        return t("media.st_sending");
      case "sent":
        return t("media.st_sent");
      default:
        return t("media.st_error", { reason: item.error ?? "" });
    }
  }

  private _itemHtml(item: MediaQueueItem): string {
    const preview = item.previewUrl || localFileUrl(item.path);
    const large = mediaSizeNotice(item.size) === "large";
    const ring =
      item.status === "sending"
        ? `<span class="card-media-ring">${renderProgressRingHtml(null)}</span>`
        : "";
    const retry =
      item.status === "error"
        ? `<button type="button" class="card-media-retry" data-media-retry="${item.id}">` +
          `${esc(t("media.retry_btn"))}</button>`
        : "";
    const body = preview
      ? `<img class="card-media-item-img" src="${escAttr(preview)}" alt="" loading="lazy" />`
      : "🖼";
    return (
      `<li class="card-media-item" data-media-id="${item.id}" data-status="${item.status}">` +
      `<span class="card-media-preview">${body}</span>` +
      `<span class="card-media-meta">` +
      `<span class="card-media-name" title="${escAttr(item.path)}">${esc(item.name)}</span>` +
      `<span class="card-media-sub">${esc(formatBytes(item.size))}` +
      (large ? ` · <span class="card-media-warn">${esc(t("media.size_warn"))}</span>` : "") +
      `</span>` +
      `<span class="card-media-state">${esc(this._stateText(item))}</span>` +
      `</span>` +
      ring +
      `<button type="button" class="card-media-remove" data-media-remove="${item.id}"` +
      ` title="${escAttr(t("media.remove_hint"))}"` +
      `${item.status === "sending" ? " disabled" : ""}>✕</button>` +
      retry +
      `</li>`
    );
  }


  private _render(): void {
    if (!this.bound) return;
    const used = this.queue.used;
    const max = this.queue.max;
    const free = Math.max(0, max - used);
    const items = this.queue.items.map((it) => this._itemHtml(it)).join("");
    this.root.innerHTML =
      `<div class="card-media-head">` +
      `<div class="card-media-title">` +
      `${esc(this.kind ? t("media.panel_title", { id: this.cardId }) : t("media.panel_title_new"))}` +
      `</div>` +
      `<div class="card-media-status">${esc(this._statusText())}</div>` +
      `</div>` +
      `<div class="card-media-actions">` +
      `<button type="button" class="card-add-media-btn"${this.queue.full ? " disabled" : ""}>` +
      `${esc(t("media.pick_btn", { n: free }))}</button>` +
      `<span class="card-media-counter" data-media-counter>` +
      `${esc(t("media.counter", { n: used, max }))}</span>` +
      `</div>` +
      `<ul class="card-media-list">${items}</ul>` +
      `<div class="card-media-gallery-host"></div>`;
    this._wireEvents();
    this._renderGallery();
  }

  private _wireEvents(): void {
    const pick = this.root.querySelector<HTMLButtonElement>(".card-add-media-btn");
    pick?.addEventListener("click", () => {
      void this._pick();
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-media-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = this.queue.remove(Number(btn.dataset.mediaRemove ?? "0"));
        if (item) this._releaseQueue([item]);
        this._render();
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-media-retry]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (this.queue.retry(Number(btn.dataset.mediaRetry ?? "0"))) {
          this._render();
          void this._flush();
        }
      });
    });
    // Локальное превью может быть недоступно (Chromium не отдал file://) — деградируем.
    this.root.querySelectorAll<HTMLImageElement>(".card-media-item-img").forEach((img) => {
      img.addEventListener("error", () => {
        img.replaceWith(document.createTextNode("🖼"));
      });
    });
  }

  private _renderGallery(): void {
    const host = this.root.querySelector<HTMLElement>(".card-media-gallery-host");
    if (!host) return;
    const items = this.galleryItems;
    if (!items.length) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = renderMediaGalleryHtml(items);
    bindMediaGallery(host, items, (index) => {
      openMediaLightbox(
        items.map((m) => ({
          fullUrl: m.fullUrl,
          thumbUrl: m.thumbUrl,
          width: m.width,
          height: m.height,
          // Свой резолвер на каждое открытие: лайтбокс освобождает blob при закрытии.
          resolveFull: m.authorized
            ? fullSizeResolver(m.fullUrl, (url, item) => this.deps.fetchBytes(url, item), m)
            : undefined,
        })),
        index,
      );
    });
  }

  /** Кольцо прогресса конкретного элемента (без пересборки списка — не мельтешит). */
  private _updateRing(itemId: number, progress: number | null): void {
    const host = this.root.querySelector<HTMLElement>(
      `li[data-media-id="${itemId}"] .card-media-ring`,
    );
    if (host) setProgressRing(host, progress);
  }

  private _replaceBlobs(urls: string[]): void {
    revokeObjectUrls(this.blobs);
    this.blobs = urls;
  }

  /** Освободить ресурсы снятых из очереди элементов (`blob:`-превью). */
  private _releaseQueue(items: MediaQueueItem[]): void {
    const urls = (items ?? [])
      .map((it) => it.previewUrl)
      .filter((url): url is string => Boolean(url));
    if (urls.length) revokeObjectUrls(urls);
  }

  /** Экспонировано для гейта лимита: серверный `max_media` в текущей очереди. */
  get maxMedia(): number {
    return this.queue.max;
  }

  /** Экспонировано для гейта статусов: снимок очереди. */
  get queueSnapshot(): ReadonlyArray<{ id: number; status: MediaItemStatus }> {
    return this.queue.items.map((it) => ({ id: it.id, status: it.status }));
  }
}

/** Реэкспорт типа загрузчика — вызывающему не нужно тянуть два модуля. */
export type { MediaCompleteResult };

