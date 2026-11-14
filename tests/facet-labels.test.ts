/**
 * Гейты подписей фасетов (SP-31 follow-up, 2026-11-04).
 *
 * Владелец: сырые значения индекса («firmware», «tv») в панели фасетов не
 * читаются — показываем канонические подписи («Firmware», «TV»). Свободные
 * текстовые фасеты (brand/model/chassis/…) остаются без переименования.
 * Клик-хендлер обязан продолжать работать по raw-значению (data-value).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { facetOptionLabel } from "../src/search/facetLabels";

const REPO = join(__dirname, "..", "..");

test("kind: firmware/documentation/software → Firmware/Documentation/Software", () => {
  assert.equal(facetOptionLabel("kind", "firmware"), "Firmware");
  assert.equal(facetOptionLabel("kind", "documentation"), "Documentation");
  assert.equal(facetOptionLabel("kind", "software"), "Software");
});

test("device_category: tv→TV, stb→STB, android_tv→Android TV, все 12 значений", () => {
  assert.equal(facetOptionLabel("device_category", "tv"), "TV");
  assert.equal(facetOptionLabel("device_category", "stb"), "STB");
  assert.equal(facetOptionLabel("device_category", "android_tv"), "Android TV");
  assert.equal(facetOptionLabel("device_category", "media_server"), "Media Server");
  assert.equal(facetOptionLabel("device_category", "dvd_bluray"), "DVD/Blu-ray");
  assert.equal(facetOptionLabel("device_category", "power_station"), "Power Station");
  // Каждое известное значение получает НЕ-сырую подпись (кроме «other»-одиночек
  // подпись обязана отличаться от сырого значения).
  for (const v of ["tv", "monitor", "stb", "android_tv", "media_server", "audio", "dvd_bluray", "radio", "console", "power_station", "appliance"]) {
    assert.notEqual(facetOptionLabel("device_category", v), v, `raw просочился: ${v}`);
  }
});

test("hardware_type: original→Original, china_clone→China-clone", () => {
  assert.equal(facetOptionLabel("hardware_type", "original"), "Original");
  assert.equal(facetOptionLabel("hardware_type", "china_clone"), "China-clone");
});

test("fallback: неизвестное значение и свободные фасеты — как есть", () => {
  assert.equal(facetOptionLabel("kind", "unknown_kind"), "unknown_kind");
  assert.equal(facetOptionLabel("device_category", "rare_device"), "rare_device");
  assert.equal(facetOptionLabel("hardware_type", "rma"), "rma");
  // Свободные текстовые фасеты — значение = подпись.
  assert.equal(facetOptionLabel("brand", "Samsung"), "Samsung");
  assert.equal(facetOptionLabel("model", "32DH3500"), "32DH3500");
  assert.equal(facetOptionLabel("chassis", "TP.MS338.PB803"), "TP.MS338.PB803");
  assert.equal(facetOptionLabel("unknown_field", "x"), "x");
});

test("SearchPage: подпись идёт через facetOptionLabel, data-value остаётся raw", () => {
  const src = readFileSync(join(REPO, "src", "ui", "SearchPage.ts"), "utf-8");
  assert.match(src, /import \{ facetOptionLabel \} from "\.\.\/search\/facetLabels"/);
  // В рендере опции подпись — через хелпер…
  assert.match(src, /facetOptionLabel\(g\.field, o\.value\)/);
  // …а data-value — raw (иначе Meili-фильтр сломается).
  assert.match(src, /data-value="\$\{this\.esc\(o\.value\)\}"/);
});
