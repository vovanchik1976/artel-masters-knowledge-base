/**
 * Боевой конвейер медиа через СВОЮ TDLib (SP-15 срез 5, D-071).
 *
 * Проверяем путь «как файлы» на фейковом движке (инжект invoke/listen):
 *
 *   F1 полный цикл: `tdlib_get_message_file` → `tdlib_start_download` → событие
 *      `completed` → `file://` в медиа-кеше (и превью берёт МИНИАТЮРУ);
 *   F2 нет миниатюры → превью-слот качает оригинал, расширение — от оригинала
 *      (иначе PNG лежал бы в `.jpg` и браузер показал бы битую картинку);
 *   F3 ошибка передачи (событие `error`) → reject (вызывающий уйдёт на прокси);
 *   F4 дедуп: два параллельных запроса одного файла = одна передача;
 *   F5 кеш: повторный запрос не дёргает движок вообще;
 *   F6 `mediaBytesFetcher` без якоря → сразу серверный прокси (TDLib не трогаем);
 *   F7 отказ TDLib (`get_message_file` упал) → фолбэк на прокси (fail-open);
 *   F8 таймаут: движок молчит → reject, слушатель и таймер сняты (нет утечки).
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { createMediaLocalFetcher, mediaBytesFetcher } from "../src/ui/MediaFetch";
import type { MediaAnchor } from "../src/ui/MediaTdlib";
import type { ResolvedMedia } from "../src/ui/MediaGallery";

/** Корень проекта (там `index.html`, `src/`, `tests/`) — независимо от outDir. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`корень проекта не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

/** Исходник относительно корня проекта. */
function readSource(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

const ANCHOR: MediaAnchor = {
  chatId: 777,
  messageId: 585,
  uniqueId: "AgAD8KcAAkAKuEk",
  sizeBytes: 26_214_400,
};

interface EngineOptions {
  info?: Record<string, unknown> | null;
  failResolve?: boolean;
  failStart?: boolean;
  /** Ошибка в событии завершения (движок не смог положить файл на диск). */
  eventError?: string;
  /** Движок молчит: ни события, ни ошибки (проверка таймаута). */
  silent?: boolean;
}

/** Фейк движка: перехватывает команды и даёт эмитить события вручную. */
function fakeEngine(opts: EngineOptions = {}) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  let handler: ((e: { payload: unknown }) => void) | null = null;
  let unlistened = 0;

  const emit = (payload: unknown): void => {
    handler?.({ payload });
  };

  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === "media_cache_dir") return { path: "/tmp/fw-media" } as unknown as T;
    if (cmd === "tdlib_get_message_file") {
      if (opts.failResolve) throw new Error("resolve_pm_part_document: часть не найдена");
      return (opts.info ?? {
        file_id: 900,
        size: 26_214_400,
        thumb_file_id: 901,
        thumb_size: 12_345,
      }) as unknown as T;
    }
    if (cmd === "tdlib_start_download") {
      if (opts.failStart) throw new Error("engine busy");
      const fileId = Number(args?.fileId ?? 0);
      if (!opts.silent) {
        // Событие обязано нести ФАКТИЧЕСКИ скачиваемый file_id — движок
        // фильтрует прогресс по нему (иначе клиент не отличит свой файл от чужого).
        queueMicrotask(() =>
          emit(
            opts.eventError
              ? { file_id: fileId, completed: false, error: opts.eventError }
              : { file_id: fileId, completed: true, downloaded: 12_345, total: 12_345 },
          ),
        );
      }
    }
    return "" as unknown as T;
  };

  const listen = async <T>(
    _event: string,
    cb: (e: { payload: T }) => void,
  ): Promise<() => void> => {
    handler = cb as (e: { payload: unknown }) => void;
    return () => {
      handler = null;
      unlistened += 1;
    };
  };

  return {
    deps: { invoke, listen, cacheDir: async () => "/tmp/fw-media", timeoutMs: 50 },
    calls,
    emit,
    unlistened: () => unlistened,
  };
}

test("F1: превью идёт своим TDLib — миниатюра по якорю → file:// в медиа-кеше", async () => {
  const engine = fakeEngine();
  const fetcher = createMediaLocalFetcher(engine.deps);

  const url = await fetcher.bytes(ANCHOR, "thumb");

  assert.equal(url, "file:///tmp/fw-media/c777_thumb_AgAD8KcAAkAKuEk.jpg");
  assert.deepEqual(
    engine.calls.map((c) => c.cmd),
    ["tdlib_get_message_file", "tdlib_start_download"],
  );
  const resolve = engine.calls[0].args as Record<string, unknown>;
  assert.equal(resolve.chatId, 777);
  assert.equal(resolve.uniqueId, "AgAD8KcAAkAKuEk");
  assert.equal(resolve.expectedSize, 26_214_400);
  const start = engine.calls[1].args as Record<string, unknown>;
  assert.equal(start.fileId, 901, "превью обязано брать миниатюру, а не оригинал");
  assert.equal(start.savePath, "/tmp/fw-media/c777_thumb_AgAD8KcAAkAKuEk.jpg");
  assert.equal(engine.unlistened(), 1, "слушатель обязан сниматься");
});


test("F2: нет миниатюры — превью тянет оригинал, расширение от оригинала", async () => {
  const engine = fakeEngine({
    info: { file_id: 900, size: 26_214_400, file_name: "IMG_0042.PNG" },
  });
  const fetcher = createMediaLocalFetcher(engine.deps);

  const url = await fetcher.bytes(ANCHOR, "thumb");

  assert.equal(url, "file:///tmp/fw-media/c777_full_AgAD8KcAAkAKuEk.png");
  const start = engine.calls[1].args as Record<string, unknown>;
  assert.equal(start.fileId, 900, "без миниатюры берём оригинал (fail-open)");
});

test("F3: ошибка передачи в событии → reject (вызывающий уйдёт на прокси)", async () => {
  const engine = fakeEngine({ eventError: "move_file: ENOSPC" });
  const fetcher = createMediaLocalFetcher(engine.deps);

  await assert.rejects(() => fetcher.bytes(ANCHOR, "full"), /move_file: ENOSPC/);
  assert.equal(engine.unlistened(), 1);
  assert.equal(fetcher.cached(), 0, "провал не должен попадать в кеш адресов");
});

test("F4: два параллельных запроса одного файла — одна передача", async () => {
  const engine = fakeEngine();
  const fetcher = createMediaLocalFetcher(engine.deps);

  const [a, b] = await Promise.all([
    fetcher.bytes(ANCHOR, "thumb"),
    fetcher.bytes(ANCHOR, "thumb"),
  ]);

  assert.equal(a, b);
  assert.equal(
    engine.calls.filter((c) => c.cmd === "tdlib_start_download").length,
    1,
    "дедуп обязан схлопнуть параллельные запросы",
  );
});

test("F5: повторный запрос берёт сессионный кеш (движок не дёргается)", async () => {
  const engine = fakeEngine();
  const fetcher = createMediaLocalFetcher(engine.deps);

  await fetcher.bytes(ANCHOR, "thumb");
  const before = engine.calls.length;
  const again = await fetcher.bytes(ANCHOR, "thumb");

  assert.equal(again, "file:///tmp/fw-media/c777_thumb_AgAD8KcAAkAKuEk.jpg");
  assert.equal(engine.calls.length, before, "повтор не должен звать движок");
  assert.equal(fetcher.cached(), 1);
});

test("F6: без якоря TDLib не трогаем — сразу серверный прокси", async () => {
  const engine = fakeEngine();
  const fetchBytes = mediaBytesFetcher(
    { ...engine.deps, fallback: async (url: string) => `blob:${url}` },
    "thumb",
  );
  const item = {
    id: 7,
    thumbUrl: "https://tv-firmware.duckdns.org/media/file/3/7/thumb",
    fullUrl: "https://tv-firmware.duckdns.org/media/file/3/7/full",
    width: null,
    height: null,
    hasThumb: true,
    authorized: true,
  } as ResolvedMedia;

  const url = await fetchBytes(item.thumbUrl, item);

  assert.equal(url, `blob:${item.thumbUrl}`);
  assert.equal(engine.calls.length, 0, "чужой/старый элемент — движок не нужен");
});

test("F7: отказ TDLib (нет документа по якорю) → фолбэк на прокси (fail-open)", async () => {
  const engine = fakeEngine({ failResolve: true });
  const fetchBytes = mediaBytesFetcher(
    { ...engine.deps, fallback: async (url: string) => `blob:${url}` },
    "full",
  );
  const item = {
    id: 7,
    thumbUrl: "https://tv-firmware.duckdns.org/media/personal/3/7/thumb",
    fullUrl: "https://tv-firmware.duckdns.org/media/personal/3/7/full",
    width: null,
    height: null,
    hasThumb: true,
    authorized: true,
    tdlibAnchor: ANCHOR,
  } as ResolvedMedia;

  const url = await fetchBytes(item.fullUrl, item);

  assert.equal(url, `blob:${item.fullUrl}`, "провал TDLib обязан упасть на прокси");
  assert.ok(
    engine.calls.some((c) => c.cmd === "tdlib_get_message_file"),
    "TDLib обязан быть ПЕРВЫМ вариантом",
  );
});

test("F8: молчащий движок → таймаут-reject, слушатель снят", async () => {
  const engine = fakeEngine({ silent: true });
  const fetcher = createMediaLocalFetcher(engine.deps);

  await assert.rejects(() => fetcher.bytes(ANCHOR, "thumb"), /timeout/);
});

// ─── G1..G4: гейты по исходникам (защита от регресса «вернули прокси») ───────

test("G1: боевой фетчер ходит в движок тем же конвейером, что скачивание файла", () => {
  const src = readSource(path.join("src", "ui", "MediaFetch.ts"));
  assert.match(src, /"tdlib_get_message_file"/, "резолв документа идёт через TDLib");
  assert.match(src, /"tdlib_start_download"/, "байты кладёт downloadFile движка");
  assert.match(src, /"tdlib-download-progress"/, "финал/ошибку даёт событие движка");
  assert.doesNotMatch(
    src,
    /api\.mediaObjectUrl\(/,
    "боевой модуль не зовёт прокси сам: фолбэк инжектится снаружи",
  );
});

test("G2: страницы подключают TDLib-фетчер (превью — thumb, зум — full)", () => {
  const search = readSource(path.join("src", "ui", "SearchPage.ts"));
  assert.match(search, /mediaBytesForUi\(/, "поиск обязан звать TDLib-фетчер");
  assert.match(search, /"thumb"\)/, "превью — вариант thumb");
  assert.match(search, /"full"\)/, "зум — вариант full (снимает потолок 20 МБ)");
  assert.match(
    search,
    /_isOwnPublicCard/,
    "своя публичная карточка берёт владельческий список с якорями",
  );

  const upload = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(upload, /mediaBytesForUi\(/, "панель медиа обязана звать TDLib-фетчер");

  const panel = readSource(path.join("src", "ui", "CardMediaPanel.ts"));
  assert.match(
    panel,
    /loadProtectedThumbs\(items, \(url, item\)/,
    "элемент обязан доезжать до фетчера: без него TDLib-путь не включается",
  );
});

test("G3: медиа-кеш существует в обоих концах (движок + мост Electron)", () => {
  const rust = readSource(path.join("engine-core", "src", "main.rs"));
  assert.match(rust, /"media_cache_dir"/, "движок обязан отдавать каталог медиа-кеша");
  const bridge = readSource(path.join("electron", "main.ts"));
  assert.match(bridge, /"media_cache_dir"/, "мост обязан пробрасывать команду в UI");
});

test("G4: якоря TDLib — только у защищённых (владельческих) элементов", () => {
  const gallery = readSource(path.join("src", "ui", "MediaGallery.ts"));
  assert.match(gallery, /authorized\s*\?\s*mediaAnchorOf\(/, "якорь собирается под authorized");
  assert.match(gallery, /tdlibAnchor/, "элемент обязан нести якорь до фетчера");
});

