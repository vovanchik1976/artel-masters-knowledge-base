/**
 * Боевой конвейер медиа через СВОЮ TDLib (SP-15 срез 5, D-071) — «как файлы».
 *
 * Порядок ровно тот же, что у скачивания прошивки:
 *   1. `tdlib_get_message_file` — строгий резолв документа сообщения-якоря
 *      (`uniqueId`/`expectedSize`, BUG-DOWNLOAD-051/052) → `file_id` (+ миниатюра);
 *   2. `tdlib_start_download` — движок кладёт байты в медиа-кеш движка;
 *   3. прогресс/финал — событием `tdlib-download-progress` (`completed`/`error`);
 *   4. UI получает `file://`-адрес (галерея/лайтбокс рисуют локальный файл).
 *
 * Почему не серверный прокси: Bot API `getFile` отдаёт ≤20 МБ, поэтому крупный
 * оригинал было видно только превью. Прокси остаётся ФОЛБЭКОМ — для чужих
 * публичных карточек (сессии зрителя нет в storage-чате) и когда TDLib не готов.
 *
 * Зависимости инжектятся (invoke/listen/cacheDir) — поэтому и боевой путь
 * проверяется юнит-тестами `tests/media-fetch.test.ts` на фейках, без Electron.
 */

import type { ResolvedMedia } from "./MediaGallery";
import {
  joinLocalPath,
  localFileUrl,
  mediaCacheFileName,
  mediaCacheKey,
  mediaDownloadOutcome,
  pickMediaFileId,
  type MediaAnchor,
  type MediaDocInfo,
  type MediaDownloadProgress,
  type MediaVariant,
} from "./MediaTdlib";

/** Сколько ждём завершения передачи, если движок молчит (на файл, не на все). */
export const MEDIA_FETCH_TIMEOUT_MS = 60_000;

export type MediaInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type MediaListen = <T>(
  event: string,
  handler: (e: { payload: T }) => void,
) => Promise<() => void>;

export interface MediaFetchDeps {
  invoke: MediaInvoke;
  listen: MediaListen;
  /** Каталог медиа-кеша движка (`media_cache_dir`). */
  cacheDir: () => Promise<string>;
  /** Таймаут ожидания завершения одной передачи. */
  timeoutMs?: number;
}

/** Фетчер байтов медиа: якорь + вариант → `file://`-адрес. */
export interface MediaLocalFetcher {
  bytes(anchor: MediaAnchor, variant: MediaVariant): Promise<string>;
  /** Сколько успешных путей в кеше (диагностика/тесты). */
  cached(): number;
}


export function createMediaLocalFetcher(deps: MediaFetchDeps): MediaLocalFetcher {
  const d: MediaFetchDeps = {
    invoke: deps.invoke,
    listen: deps.listen,
    cacheDir: deps.cacheDir,
    timeoutMs: deps.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS,
  };
  /** Готовые адреса (сессионный кеш: повторное открытие зума не качает снова). */
  const ready = new Map<string, string>();
  /** Передачи в полёте — дедуп (галерея может запросить один файл дважды). */
  const flying = new Map<string, Promise<string>>();

  const downloadTo = (fileId: number, savePath: string): Promise<void> => {
    const timeoutMs = Number(d.timeoutMs || MEDIA_FETCH_TIMEOUT_MS);
    return new Promise<void>((resolve, reject) => {
      let unlisten: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (unlisten) unlisten();
        unlisten = null;
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const done = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      void d
        .listen<MediaDownloadProgress>("tdlib-download-progress", (e) => {
          const p = e.payload;
          if (!p || Number(p.file_id) !== fileId) return;
          const outcome = mediaDownloadOutcome(p);
          if (outcome.error) return fail(new Error(`media download: ${outcome.error}`));
          if (outcome.done) done();
        })
        .then((fn) => {
          unlisten = fn;
          timer = setTimeout(
            () => fail(new Error(`media download timeout (file_id=${fileId})`)),
            timeoutMs,
          );
          // Старт после подписки — иначе ранний updateFile потеряется.
          d.invoke<string>("tdlib_start_download", { fileId, savePath }).catch(fail);
        })
        .catch(fail);
    });
  };

  const fetchOnce = async (anchor: MediaAnchor, variant: MediaVariant): Promise<string> => {
    const dir = await d.cacheDir();
    const info = await d.invoke<MediaDocInfo>("tdlib_get_message_file", {
      chatId: anchor.chatId,
      messageId: anchor.messageId || undefined,
      uniqueId: anchor.uniqueId || undefined,
      expectedSize: anchor.sizeBytes || undefined,
    });
    const fileId = pickMediaFileId(info, variant);
    if (!fileId) {
      throw new Error("media: в сообщении-якоре нет файла под этот вариант");
    }
    // Имя — по ФАКТИЧЕСКИ выбранному файлу: если миниатюры у документа нет и мы
    // взяли оригинал, расширение обязано быть от оригинала (иначе PNG лёг бы в `.jpg`).
    const usedThumb = variant === "thumb" && Number(info?.thumb_file_id ?? 0) > 0;
    const nameVariant: MediaVariant = usedThumb ? "thumb" : "full";
    const path = joinLocalPath(dir, mediaCacheFileName(anchor, nameVariant, info?.file_name));
    await downloadTo(fileId, path);
    return localFileUrl(path);
  };

  return {
    async bytes(anchor: MediaAnchor, variant: MediaVariant): Promise<string> {
      const key = mediaCacheKey(anchor, variant);
      const hit = ready.get(key);
      if (hit) return hit;
      const run = flying.get(key);
      if (run) return run;
      const p = fetchOnce(anchor, variant)
        .then((url) => {
          ready.set(key, url);
          return url;
        })
        .finally(() => flying.delete(key));
      flying.set(key, p);
      return p;
    },
    cached(): number {
      return ready.size;
    },
  };
}


export interface MediaBytesFetcherDeps extends MediaFetchDeps {
  /** Серверный прокси (`api.mediaObjectUrl`) — фолбэк для чужих карточек. */
  fallback: (url: string) => Promise<string>;
}

/**
 * Фетчер байтов для UI: сначала СВОЯ TDLib (если у элемента есть якорь), затем
 * серверный прокси. Отказ TDLib не ломает карточку — падаем на прокси, а его
 * отказ уже fail-open в `loadProtectedThumbs` (превью остаётся серверным).
 *
 * Вариант задаётся при создании: превью — `thumb`, зум — `full` (ленивый).
 */
export function mediaBytesFetcher(
  deps: MediaBytesFetcherDeps,
  variant: MediaVariant,
): (url: string, item?: ResolvedMedia) => Promise<string> {
  const local = createMediaLocalFetcher(deps);
  return async (url: string, item?: ResolvedMedia): Promise<string> => {
    const anchor = item?.tdlibAnchor;
    if (anchor) {
      try {
        return await local.bytes(anchor, variant);
      } catch {
        /* нет TDLib-доступа/движок занят — прокси ниже (fail-open) */
      }
    }
    return deps.fallback(url);
  };
}
