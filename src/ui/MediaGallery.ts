/**
 * Галерея медиа карточки (SP-15 v3, D-069): превьюшки в описании + открытие лайтбокса.
 *
 * Данные приходят либо в карточке поиска (поле `media` из Meili), либо запросом
 * `GET /desktop/cards/{kind}/{id}/media`. Здесь — нормализация URL и рендер превью;
 * увеличение делает MediaLightbox (показывает ОРИГИНАЛ без потерь).
 *
 * Чистые функции (без DOM) покрыты тестами `tests/media-gallery.test.ts`.
 */

import { mediaAnchorOf, type MediaAnchor } from "./MediaTdlib";

export interface CardMediaItem {
  id?: number;
  media_kind?: string;
  mime?: string;
  size_bytes?: number;
  width?: number | null;
  height?: number | null;
  has_thumb?: boolean;
  thumb_url?: string;
  full_url?: string;
  tg_chat_id?: number;
  tg_message_id?: number;
  tg_file_unique_id?: string | null;
}

export interface ResolvedMedia {
  id: number;
  thumbUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  hasThumb: boolean;
  /**
   * Байты требуют `Authorization: Bearer` (личная карточка / неодобренная
   * публичная). Такой элемент грузит JS с токеном → `blob:`, тег `<img>`
   * заголовки не отправляет (`src/ui/MediaAuth.ts`).
   */
  authorized: boolean;
  /**
   * Якорь в Telegram для СВОЕЙ TDLib-сессии (SP-15 срез 5, D-071).
   *
   * Приходит только вместе с `authorized` (маршрут списка медиа — владельческий):
   * клиент качает превью/оригинал локально (`src/ui/MediaFetch.ts`), без потолка
   * Bot API 20 МБ. Нет якоря (чужой публичный файл, старый индекс) → серверный прокси.
   */
  tdlibAnchor?: MediaAnchor;
}

/** Относительный путь → абсолютный по базовому URL сервера (канонический домен). */
export function absoluteUrl(baseUrl: string, path: string): string {
  const clean = String(path || "").trim();
  if (!clean) return "";
  if (/^https?:\/\//i.test(clean)) return clean;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return clean;
  return `${base}${clean.startsWith("/") ? "" : "/"}${clean}`;
}

/**
 * Нормализовать список медиа карточки: только валидные записи, абсолютные URL.
 *
 * Превью может отсутствовать (`has_thumb=false`) — тогда превьюшкой служит сам
 * оригинал (fail-open, как на сервере).
 */
export function resolveCardMedia(
  items: CardMediaItem[] | undefined | null,
  baseUrl: string,
  opts: { authorized?: boolean } = {},
): ResolvedMedia[] {
  if (!Array.isArray(items)) return [];
  const authorized = Boolean(opts.authorized);
  const out: ResolvedMedia[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const id = Number((raw as CardMediaItem).id ?? 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    const thumb = absoluteUrl(baseUrl, String(raw.thumb_url || ""));
    const full = absoluteUrl(baseUrl, String(raw.full_url || raw.thumb_url || ""));
    if (!thumb && !full) continue;
    // Якорь TDLib — только для защищённых (владельческих) элементов: в выдаче
    // поиска координат чужого PM нет и быть не должно (сервер их не отдаёт).
    const anchor = authorized
      ? mediaAnchorOf({
          tg_chat_id: raw.tg_chat_id,
          tg_message_id: raw.tg_message_id,
          tg_file_unique_id: raw.tg_file_unique_id,
          size_bytes: raw.size_bytes,
        })
      : null;
    out.push({
      id,
      thumbUrl: thumb || full,
      fullUrl: full || thumb,
      width: raw.width ?? null,
      height: raw.height ?? null,
      hasThumb: Boolean(raw.has_thumb),
      authorized,
      ...(anchor ? { tdlibAnchor: anchor } : {}),
    });
  }
  return out;
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Разметка галереи: превьюшки с ленивой загрузкой (не грузим лишнее заранее). */
export function renderMediaGalleryHtml(
  items: ResolvedMedia[],
  opts: { limit?: number } = {},
): string {
  const limit = Math.max(1, Number(opts.limit ?? 12));
  const list = items.slice(0, limit);
  if (!list.length) return "";
  const tiles = list
    .map((m, i) => {
      const dims = m.width && m.height ? `${m.width}×${m.height}` : "";
      return (
        `<button type="button" class="card-media-thumb" data-media-index="${i}"` +
        (dims ? ` title="${dims}"` : "") +
        `><img src="${escapeAttr(m.thumbUrl)}" alt="" loading="lazy" decoding="async" />` +
        `</button>`
      );
    })
    .join("");
  return `<div class="card-media-gallery" data-count="${list.length}">${tiles}</div>`;
}

/** Привязать открытие лайтбокса к превьюшкам внутри контейнера карточки. */
export function bindMediaGallery(
  root: ParentNode,
  items: ResolvedMedia[],
  onOpen: (index: number) => void,
): void {
  root.querySelectorAll<HTMLElement>(".card-media-thumb").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.mediaIndex ?? "0");
      if (Number.isFinite(idx) && items[idx]) onOpen(idx);
    });
  });
}
