/**
 * Гейт «честный манифест загрузки» (BUG-CABINET-VAULT-SHA-MISMATCH-001, 2026-11-11).
 *
 * Живой дефект: одиночный сырой файл упаковывался в `.tar.zst`, но манифест
 * объявлял `type="firmware_file"` — тип считался от `singleSource`, а тот после
 * упаковки остаётся `"file"`. Сервер по этому типу писал
 * `byte_sha256 = files[0].sha256` (хэш ВНУТРЕННЕГО файла), клиент сверял его с
 * байтами АРХИВА → детерминированный «SHA-256 не совпал», скачать файл нельзя.
 *
 * Гейт по ИСХОДНИКАМ (DOM/FS в node:test нет) + чистые функции решения:
 *  U1 тип бандла выводится из КОНТЕЙНЕРА, а не из `singleSource`;
 *  U2 оба вызова `decideSingleSource` передают `allowSkipPacking`;
 *  U3 «не пакувати» разрешено ТОЛЬКО в личном хранилище (решение владельца);
 *  U4 выбор запоминается между запусками (`fw_upload_skip_packing`);
 *  U5 чекбокс есть в разметке и в трёх локалях;
 *  U6 отравленный кеш TDLib снимается при несовпадении sha/размера.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  SKIP_PACKING_STORAGE_KEY,
  readSkipPackingPref,
  writeSkipPackingPref,
} from "../src/search/SingleUploadPolicy";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

const UPLOAD_PAGE = "src/ui/UploadPage.ts";

test("U1: тип манифеста выводится из контейнера, а не из singleSource", () => {
  const src = read(UPLOAD_PAGE);
  const block = src.match(/type:\s*([\s\S]{0,900}?)\n\s*container:/);
  assert.ok(block, "не нашли вычисление `type` в манифесте uploadInit");
  assert.match(
    block![1],
    /manifestContainer !== null/,
    "тип не смотрит на контейнер: упакованный файл снова объявит себя firmware_file",
  );
  assert.doesNotMatch(
    block![1],
    /singleSource === "bundle"/,
    "старый (лживый) признак вернулся: singleSource после упаковки остаётся \"file\"",
  );
});

test("U2: оба вызова decideSingleSource передают allowSkipPacking", () => {
  const src = read(UPLOAD_PAGE);
  const calls = [...src.matchAll(/decideSingleSource\(\{([\s\S]{0,320}?)\}\)/g)].map(m => m[1]);
  assert.equal(calls.length, 2, "ожидались ровно два вызова (предпросмотр + старт)");
  for (const body of calls) {
    assert.match(body, /allowSkipPacking:/, "вызов без allowSkipPacking игнорирует выбор мастера");
  }
});

test("U3: «не пакувати» разрешено только в личном хранилище", () => {
  const src = read(UPLOAD_PAGE);
  const fn = src.match(/_skipPackingAllowed\(\):\s*boolean\s*\{([\s\S]{0,240}?)\n  \}/);
  assert.ok(fn, "нет метода _skipPackingAllowed — политика «не пакувати» не гейтится");
  assert.match(fn![1], /isPersonalScope\(\)/, "публичный каталог обязан паковать всегда");
});

test("U4: выбор запоминается между запусками", () => {
  const src = read(UPLOAD_PAGE);
  assert.match(src, /fw_upload_skip_packing|SKIP_PACKING_STORAGE_KEY/);
  assert.equal(SKIP_PACKING_STORAGE_KEY, "fw_upload_skip_packing");
  assert.equal(readSkipPackingPref(() => "1"), true);
  assert.equal(readSkipPackingPref(() => null), false, "по умолчанию пакуем");
  assert.equal(readSkipPackingPref(() => "0"), false);

  const store = new Map<string, string>();
  writeSkipPackingPref((k, v) => void store.set(k, v), true);
  assert.equal(store.get(SKIP_PACKING_STORAGE_KEY), "1");
  writeSkipPackingPref((k, v) => void store.set(k, v), false);
  assert.equal(store.get(SKIP_PACKING_STORAGE_KEY), "0");
});

test("U5: чекбокс есть в разметке и во всех трёх локалях", () => {
  const html = read("index.html");
  assert.match(html, /id="uploadSkipPacking"/, "нет чекбокса «не пакувати» в разметке");
  assert.match(html, /data-i18n="upload\.skip_packing"/, "подпись чекбокса без i18n");
  for (const loc of ["en", "ru", "uk"]) {
    assert.match(
      read(`src/i18n/locales/${loc}.ts`),
      /skip_packing:/,
      `локаль ${loc} без строки «не пакувати» — язык «залипнет»`,
    );
  }
});

test("U6: отравленный кеш TDLib снимается при несовпадении sha", () => {
  const rs = read("engine-core/src/parts_download.rs");
  const shaBlock = rs.match(
    /if let Err\(e\) = verify_sha\(&cached, part\.expected_sha256\.as_deref\(\)\) \{([\s\S]{0,700}?)\n    \}/,
  );
  assert.ok(shaBlock, "не нашли проверку sha в process_part_once");
  assert.match(
    shaBlock![1],
    /release_cache\(file_id\)/,
    "кеш части не снят: повтор скачивания виснет на отравленном файле",
  );

  // Size-guard — НЕ приёмка, но и не отравленный кеш: обрезанный файл остаётся
  // материалом resume (инвариант BUG-DOWNLOAD-049, гейт part-cache-release).
  const sizeBlock = rs.match(/if expected > 0 && written != expected \{([\s\S]{0,600}?)\n        \}/);
  assert.ok(sizeBlock, "не нашли size-guard в process_part_once");
  assert.doesNotMatch(
    sizeBlock![1],
    /release_cache\(file_id\)/,
    "size-guard не должен снимать кеш: обрезанная часть — материал resume",
  );
});
