/**
 * Тесты отдачи защищённых медиа (SP-15 v3, D-069) — Desktop.
 *
 * `<img src="/media/...">` НЕ умеет отправлять `Authorization`, а маршрут медиа
 * для непубличной карточки fail-closed требует Bearer (личная карточка → всегда
 * владелец, публичная неодобренная → владелец). Поэтому байты тянет JS
 * (заголовок + `objectURL`), а не тег.
 *
 *   M1 флаг `authorized` у элементов: по умолчанию нет, с opts — да;
 *   M2 защищённые превью подменяются blob-URL (фетчер зовётся с АБСОЛЮТНЫМ thumb);
 *   M3 fail-open: фетчер упал → превью остаётся серверным, счётчик отказов растёт;
 *   M4 оригинал НЕ тянется вместе с превью (лениво — только при открытии зума);
 *   M5 входной список не мутируется;
 *   M6 `revokeObjectUrls` освобождает все blob-URL (утечки при перерисовке нет);
 *   M7 гвардия поколения показа: ответ старого показа не перетирает новый.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCardMedia } from "../src/ui/MediaGallery";
import {
  loadProtectedThumbs,
  revokeObjectUrls,
  type MediaUrlFetcher,
} from "../src/ui/MediaAuth";
import { createShowGuard } from "../src/ui/MediaLightbox";

const BASE = "https://tv-firmware.duckdns.org";

function mediaList(): Parameters<typeof resolveCardMedia>[0] {
  return [
    {
      id: 7,
      thumb_url: "/media/personal/3/7/thumb",
      full_url: "/media/personal/3/7/full",
      width: 1200,
      height: 900,
      has_thumb: true,
    },
    {
      id: 8,
      thumb_url: "/media/personal/3/8/thumb",
      full_url: "/media/personal/3/8/full",
      has_thumb: true,
    },
  ];
}

/** Фетчер-заглушка: URL → `blob:<url>` (в тестах не нужен настоящий blob). */
function fakeFetcher(calls: string[], fail: string[] = []): MediaUrlFetcher {
  return async (url: string) => {
    calls.push(url);
    if (fail.includes(url)) throw new Error("HTTP 403");
    return `blob:${url}`;
  };
}

test("M1: authorized — по умолчанию выключен, с opts — у всех записей", () => {
  const plain = resolveCardMedia(mediaList(), BASE);
  assert.deepEqual(
    plain.map((m) => m.authorized),
    [false, false],
  );
  const owned = resolveCardMedia(mediaList(), BASE, { authorized: true });
  assert.deepEqual(
    owned.map((m) => m.authorized),
    [true, true],
  );
});

test("M2: защищённые превью едут через фетчер как blob-URL", async () => {
  const items = resolveCardMedia(mediaList(), BASE, { authorized: true });
  const calls: string[] = [];
  const res = await loadProtectedThumbs(items, fakeFetcher(calls));
  assert.deepEqual(calls, [
    `${BASE}/media/personal/3/7/thumb`,
    `${BASE}/media/personal/3/8/thumb`,
  ]);
  assert.equal(res.items[0].thumbUrl, `blob:${BASE}/media/personal/3/7/thumb`);
  assert.equal(res.items[1].thumbUrl, `blob:${BASE}/media/personal/3/8/thumb`);
  assert.equal(res.failures, 0);
  assert.equal(res.objectUrls.length, 2);
});

test("M3: fail-open — превью остаётся серверным, отказ посчитан", async () => {
  const items = resolveCardMedia(mediaList(), BASE, { authorized: true });
  const bad = `${BASE}/media/personal/3/7/thumb`;
  const res = await loadProtectedThumbs(items, fakeFetcher([], [bad]));
  assert.equal(res.failures, 1);
  assert.equal(res.items[0].thumbUrl, bad, "серверный URL сохранён");
  assert.equal(res.items[1].thumbUrl, `blob:${BASE}/media/personal/3/8/thumb`);
  assert.equal(res.objectUrls.length, 1, "blob только для успешного");
});

test("M4: оригинал ленивый — превью-загрузка его не тянет", async () => {
  const items = resolveCardMedia(mediaList(), BASE, { authorized: true });
  const calls: string[] = [];
  const res = await loadProtectedThumbs(items, fakeFetcher(calls));
  assert.equal(calls.length, 2, "два превью, ни одного оригинала");
  assert.ok(!calls.some((u) => u.endsWith("/full")));
  assert.equal(
    res.items[0].fullUrl,
    `${BASE}/media/personal/3/7/full`,
    "оригинал остаётся адресуемым для ленивой загрузки",
  );
});

test("M5: входной список не мутируется", async () => {
  const items = resolveCardMedia(mediaList(), BASE, { authorized: true });
  const before = items[0].thumbUrl;
  await loadProtectedThumbs(items, fakeFetcher([]));
  assert.equal(items[0].thumbUrl, before);
});

test("M6: revokeObjectUrls освобождает blob-URL", () => {
  const revoked: string[] = [];
  const count = revokeObjectUrls(["blob:a", "blob:b"], (u) => revoked.push(u));
  assert.equal(count, 2);
  assert.deepEqual(revoked, ["blob:a", "blob:b"]);
  assert.equal(revokeObjectUrls([], (u) => revoked.push(u)), 0);
  assert.equal(revokeObjectUrls([""] as string[], (u) => revoked.push(u)), 0);
});

test("M7: гвардия показа — ответ старого показа не перетирает новый", () => {
  const guard = createShowGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.begin();
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.isCurrent(first), false, "устаревший ответ отбрасывается");
});
