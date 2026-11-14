/**
 * Боевая обвязка медиа-фетчера (SP-15 срез 5, D-071): реальный мост Electron.
 *
 * Вынесено из `MediaFetch.ts` намеренно: тестируемый модуль не должен тянуть
 * `tauri-polyfill` (в `tsconfig.tests.json` его нет — node:test упал бы на импорте).
 * Здесь же — единственная точка, где UI узнаёт каталог медиа-кеша движка.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mediaBytesFetcher,
  type MediaBytesFetcherDeps,
  type MediaInvoke,
  type MediaListen,
} from "./MediaFetch";
import type { MediaVariant } from "./MediaTdlib";
import type { ResolvedMedia } from "./MediaGallery";

/** Каталог медиа-кеша движка (`media_cache_dir`) — спрашиваем при каждом файле. */
function engineCacheDir(): Promise<string> {
  return invoke<{ path?: string }>("media_cache_dir").then((res) =>
    String(res?.path || ""),
  );
}

/**
 * Прод-зависимости: `invoke`/`listen` движка + каталог кеша + серверный прокси
 * как фолбэк (чужие публичные карточки, TDLib недоступен).
 */
export function defaultMediaFetchDeps(
  fallback: (url: string) => Promise<string>,
): MediaBytesFetcherDeps {
  const inv: MediaInvoke = (cmd, args) => invoke(cmd, args);
  const lis: MediaListen = (event, handler) => listen(event, handler);
  return { invoke: inv, listen: lis, cacheDir: engineCacheDir, fallback };
}

/** Фетчер медиа-байтов для страницы: сначала своя TDLib, затем прокси. */
export function mediaBytesForUi(
  fallback: (url: string) => Promise<string>,
  variant: MediaVariant,
): (url: string, item?: ResolvedMedia) => Promise<string> {
  return mediaBytesFetcher(defaultMediaFetchDeps(fallback), variant);
}
