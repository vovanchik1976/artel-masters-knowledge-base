/**
 * Тесты галереи и лайтбокса медиа карточки (SP-15 v3, D-069).
 *
 * Проверяем ЧИСТУЮ логику (без DOM):
 *   G1 абсолютные URL из относительных путей (канонический домен, хвостовые слэши);
 *   G2 нормализация списка медиа: мусор отбрасывается, превью fail-open → оригинал;
 *   G3 разметка галереи: экранирование, лимит, индексы превьюшек, пусто → "";
 *   L1 зум: границы 1×–5×, NaN → 1×, точка под курсором остаётся на месте;
 *   L2 панорамирование: картинка не уезжает за вьюпорт, «влезает» → без сдвига;
 *   L3 навигация: заворот индекса в обе стороны, пустой список → 0;
 *   L4 двойной клик: 1× ↔ 2×.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  absoluteUrl,
  renderMediaGalleryHtml,
  resolveCardMedia,
} from "../src/ui/MediaGallery";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  clampScale,
  stepIndex,
  toggleScale,
  zoomAt,
} from "../src/ui/MediaLightbox";

const BASE = "https://tv-firmware.duckdns.org";

test("G1: absoluteUrl склеивает канонический домен и относительный путь", () => {
  assert.equal(absoluteUrl(BASE, "/media/file/1/2/thumb"), `${BASE}/media/file/1/2/thumb`);
  assert.equal(absoluteUrl(`${BASE}/`, "/media/x"), `${BASE}/media/x`);
  assert.equal(absoluteUrl(BASE, "media/x"), `${BASE}/media/x`);
  assert.equal(absoluteUrl(BASE, "https://cdn.example/x.jpg"), "https://cdn.example/x.jpg");
  assert.equal(absoluteUrl(BASE, ""), "");
  assert.equal(absoluteUrl("", "/media/x"), "/media/x");
});

test("G2: resolveCardMedia нормализует записи и отбрасывает мусор", () => {
  const items = resolveCardMedia(
    [
      { id: 7, thumb_url: "/media/file/5/7/thumb", full_url: "/media/file/5/7/full", width: 1200, height: 900, has_thumb: true },
      { id: 8, full_url: "/media/file/5/8/full", has_thumb: false },
      { id: 0, thumb_url: "/media/file/5/0/thumb" },
      { thumb_url: "/media/file/5/none/thumb" },
      null as unknown as { id: number },
      { id: 9 },
    ],
    BASE,
  );
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].thumbUrl, `${BASE}/media/file/5/7/thumb`);
  assert.equal(items[0].fullUrl, `${BASE}/media/file/5/7/full`);
  assert.equal(items[0].width, 1200);
  assert.equal(items[1].thumbUrl, `${BASE}/media/file/5/8/full`, "без превью показываем оригинал");
  assert.equal(items[1].hasThumb, false);
});

test("G2: resolveCardMedia терпит пустой/битый вход", () => {
  assert.deepEqual(resolveCardMedia(undefined, BASE), []);
  assert.deepEqual(resolveCardMedia(null, BASE), []);
  assert.deepEqual(resolveCardMedia([] as never, BASE), []);
});

test("G3: renderMediaGalleryHtml — индексы, лимит и экранирование", () => {
  const items = resolveCardMedia(
    [
      { id: 1, thumb_url: "/media/file/1/1/thumb", full_url: "/media/file/1/1/full", width: 10, height: 20, has_thumb: true },
      { id: 2, thumb_url: "/media/file/1/2/thumb?a=1&b=2", full_url: "/media/file/1/2/full", has_thumb: true },
    ],
    BASE,
  );
  const html = renderMediaGalleryHtml(items);
  assert.match(html, /data-media-index="0"/);
  assert.match(html, /data-media-index="1"/);
  assert.match(html, /data-count="2"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /a=1&amp;b=2/, "URL экранируется в атрибуте");
  assert.match(html, /title="10×20"/);

  assert.equal(renderMediaGalleryHtml(items, { limit: 1 }).includes('data-media-index="1"'), false);
  assert.equal(renderMediaGalleryHtml([]), "");
});

test("L1: clampScale держит 1×–5× и лечит NaN", () => {
  assert.equal(clampScale(0.2), MIN_SCALE);
  assert.equal(clampScale(99), MAX_SCALE);
  assert.equal(clampScale(Number.NaN), MIN_SCALE);
  assert.equal(clampScale(2.5), 2.5);
});

test("L1: zoomAt увеличивает вокруг точки и не двигает её", () => {
  const start = { scale: 1, offsetX: 0, offsetY: 0 };
  const zoomed = zoomAt(start, 2, { x: 100, y: 50 });
  assert.equal(zoomed.scale, 2);
  // Точка (100,50) до и после зума совпадает:
  assert.equal(100 * zoomed.scale + zoomed.offsetX, 100);
  assert.equal(50 * zoomed.scale + zoomed.offsetY, 50);

  const atMax = zoomAt({ scale: MAX_SCALE, offsetX: 5, offsetY: 5 }, 2, { x: 0, y: 0 });
  assert.deepEqual(atMax, { scale: MAX_SCALE, offsetX: 5, offsetY: 5 }, "на пределе состояние не меняется");
});

test("L2: clampPan не даёт уехать за вьюпорт, влезающую картинку не двигает", () => {
  const viewport = { w: 800, h: 600 };
  const image = { w: 400, h: 300 };
  assert.deepEqual(
    clampPan({ scale: 1, offsetX: 100, offsetY: -100 }, viewport, image),
    { scale: 1, offsetX: 0, offsetY: 0 },
    "картинка меньше вьюпорта — панорамировать нечего",
  );
  const bounded = clampPan({ scale: 4, offsetX: 9999, offsetY: -9999 }, viewport, image);
  assert.equal(bounded.offsetX, (400 * 4 - 800) / 2);
  assert.equal(bounded.offsetY, -((300 * 4 - 600) / 2));
});

test("L3: stepIndex заворачивает индекс в обе стороны", () => {
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.equal(stepIndex(0, 0, 0), 0);
});

test("L4: toggleScale переключает 1× ↔ 2×", () => {
  assert.equal(toggleScale(1), 2);
  assert.equal(toggleScale(2), 1);
  assert.equal(toggleScale(5), 1);
});
