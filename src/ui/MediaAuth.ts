/**
 * Защищённые медиа карточки (SP-15 v3, D-069): байты тянет JS, а не тег `<img>`.
 *
 * Причина: маршрут медиа (`GET /media/{kind}/{card}/{media}/{variant}`) для
 * НЕпубличной карточки fail-closed требует `Authorization: Bearer` (личная
 * карточка — всегда владелец; публичная неодобренная — тоже владелец), а тег
 * `<img src>` заголовки отправить не может. Поэтому клиент качает байты сам
 * (`api.mediaObjectUrl`) и подставляет `blob:`-адрес.
 *
 * Здесь только ЧИСТАЯ логика (фетчер инжектится) — тесты `tests/media-auth.test.ts`.
 */

import type { ResolvedMedia } from "./MediaGallery";

/** Фетчер байтов: абсолютный URL (+ элемент для TDLib-пути) → `blob:`/`file://`. */
export type MediaUrlFetcher = (url: string, item?: ResolvedMedia) => Promise<string>;

export interface ProtectedThumbsResult {
  /** Новый список (входной не мутируется): blob-превью у успешно скачанных. */
  items: ResolvedMedia[];
  /** Созданные `blob:`-адреса — их надо освободить при перерисовке. */
  objectUrls: string[];
  /** Сколько превью не удалось получить (fail-open: остался серверный URL). */
  failures: number;
}

/**
 * Скачать превью защищённых медиа с токеном и подменить на `blob:`-адреса.
 *
 * Оригинал (`full`) НЕ трогаем: он грузится лениво — только при открытии зума
 * (тянуть все оригиналы в галерею нельзя: это мегабайты на каждую карточку).
 * Отказ фетчера не роняет галерею — превью остаётся серверным (fail-open).
 *
 * Элемент передаётся фетчеру вторым аргументом: при наличии якоря он берёт байты
 * СВОИМ TDLib (`mediaBytesFetcher`, SP-15 срез 5), иначе — серверный прокси.
 */
export async function loadProtectedThumbs(
  items: ResolvedMedia[],
  fetchUrl: MediaUrlFetcher,
): Promise<ProtectedThumbsResult> {
  const out: ResolvedMedia[] = [];
  const objectUrls: string[] = [];
  let failures = 0;
  for (const item of items) {
    if (!item.authorized || !item.thumbUrl) {
      out.push({ ...item });
      continue;
    }
    try {
      const blob = await fetchUrl(item.thumbUrl, item);
      if (blob) {
        out.push({ ...item, thumbUrl: blob });
        objectUrls.push(blob);
      } else {
        failures += 1;
        out.push({ ...item });
      }
    } catch {
      failures += 1;
      out.push({ ...item });
    }
  }
  return { items: out, objectUrls, failures };
}

/** Освободить `blob:`-адреса (иначе они живут до перезапуска окна). */
export function revokeObjectUrls(
  urls: string[],
  revoke: (url: string) => void = (url) => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* окружающий контекст без blob-URL — не беда */
    }
  },
): number {
  let count = 0;
  for (const url of urls || []) {
    if (!url) continue;
    revoke(url);
    count += 1;
  }
  return count;
}

/**
 * Ленивый резолвер ОРИГИНАЛА для лайтбокса: качаем один раз на открытие зума
 * (повторные заходы на то же фото берут уже полученный адрес).
 *
 * `item` — медиа-элемент: при наличии якоря фетчер идёт СВОИМ TDLib (вариант
 * `full`), поэтому крупный оригинал (>20 МБ) больше не упирается в Bot API.
 */
export function fullSizeResolver(
  url: string,
  fetchUrl: MediaUrlFetcher,
  item?: ResolvedMedia,
): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    if (!pending) pending = fetchUrl(url, item);
    return pending;
  };
}
