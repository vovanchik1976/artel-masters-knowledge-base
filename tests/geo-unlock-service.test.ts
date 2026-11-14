/**
 * GEO_Unlock — сервисный слой main-процесса: тариф и валидация входа.
 *
 * Платное/бесплатное решается СОДЕРЖИМЫМ дампа, а не именем команды
 * (решения владельца D-148/D-150, 2026-11-01):
 *   * `kind: "record"` — журнальный массив в NVRAM-пуле раздела eMMC (p31,
 *     256 записей × 512 Б, parity + 3×CRC32C) — ЕДИНСТВЕННАЯ живая копия
 *     (драйвер `tztv-eeprom` читает регион оттуда), поэтому правится только
 *     с grant'ом; владельцу сервер выдаёт grant `kind: "owner"` без списания;
 *   * `kind: "image"` в файле ровно 64 КиБ и образом С НАЧАЛА файла — дамп
 *     микросхемы NVM (24C512) — бесплатен;
 *   * всё остальное — дамп раздела eMMC (плоские копии по смещениям, несколько
 *     копий, пустой список) — платно. Отдельного класса «не поддерживается»
 *     больше нет: теория GPP1 снята владельцем (D-150);
 *   * все сканы и `checkOnly` — бесплатны.
 *
 * Байты закрыты тестами ядер (geo-unlock-samsung/lg), здесь — только контракт:
 * что именно требует grant, что отклоняется и что рендерер может спросить
 * заранее.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BadInput,
  LicenseRequired,
  geoPatchLg,
  geoPatchSamsung,
  geoScanLg,
  geoScanSamsung,
  needsGrantForSamsung,
  requireGrant,
} from "../electron/geo-unlock/service";

import { REGION_OFF } from "../electron/geo-unlock/index";
import {
  ARRAY_BASES,
  FLAT_IMAGE_BASES,
  buildFlatAreas,
  buildImage,
  buildPool,
  regionRecordOffset,
  sibling,
  tmpFile,
} from "./geo-unlock-fixtures";

/** Мнимая выдача сервера (в бою её подписывает `POST /desktop/tools/…`). */
const TRIAL = { id: "grant-trial-1", kind: "trial" as const };

test("G1: grant обязателен и строго типизирован", () => {
  assert.deepEqual(requireGrant(TRIAL), TRIAL);
  assert.deepEqual(requireGrant({ id: "x", kind: "paid" }), { id: "x", kind: "paid" });
  // владелец: сервер выдаёт kind "owner" — операция проходит без списания
  assert.deepEqual(requireGrant({ id: "owner-1", kind: "owner" }), { id: "owner-1", kind: "owner" });
  // D-151: действующий пакет мастера — цена операции и есть срок пакета
  assert.deepEqual(requireGrant({ id: "pkg-1", kind: "package" }), {
    id: "pkg-1",
    kind: "package",
  });
  for (const bad of [
    undefined,
    null,
    {},
    { id: "" },
    { id: "x" },
    { id: "x", kind: "free" },
    { id: "x", kind: "gold" },
  ]) {
    assert.throws(() => requireGrant(bad), LicenseRequired, JSON.stringify(bad));
  }
});

test("G2: тариф по содержимому: журнал eMMC платный, плоский образ — нет", () => {
  const image = tmpFile("image.bin", buildImage(0x01));
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  assert.equal(needsGrantForSamsung(geoScanSamsung({ path: image }).copies), false);
  assert.equal(needsGrantForSamsung(geoScanSamsung({ path: pool }).copies), true);
  // Вердикт считается в main и отдаётся рендереру готовым: UI правила не повторяет.
  const imageScan = geoScanSamsung({ path: image });
  assert.equal(imageScan.dumpKind, "nvm24c512");
  assert.equal(imageScan.needsGrant, false);
  const poolScan = geoScanSamsung({ path: pool });
  assert.equal(poolScan.dumpKind, "emmc-journal");
  assert.equal(poolScan.needsGrant, true);
});

test("G3: журнальный массив раздела eMMC без grant не патчится", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const out = sibling(pool, ".patched");
  assert.throws(() => geoPatchSamsung({ path: pool, out, region: 0x02 }), LicenseRequired);
  assert.equal(fs.existsSync(out), false, "гейт срабатывает ДО записи файла");
});

test("G4: плоский образ 64 КиБ (NVM-микросхема) правится БЕЗ grant — бесплатно", () => {
  const file = tmpFile("image.bin", buildImage(0x01));
  const out = sibling(file, ".patched");
  const res = geoPatchSamsung({ path: file, out, region: 0x02 });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "free");
  assert.equal(fs.readFileSync(out)[0x3e65], 0x02);
  // Микросхема 24C512 — это НЕ «плоская копия раздела»: она сама и есть носитель
  // региона на старых моделях, поэтому предупреждения «на ТВ ничего не изменится»
  // здесь быть не должно (D-154). Раньше оно печаталось и отговаривало от метода.
  assert.ok(
    !res.log.some(line => line.includes("no working region copy")),
    "дампу микросхемы предупреждение о неробочій копії не нужно",
  );
  assert.equal((res as { flatOnly?: boolean }).flatOnly, false);
});

test("G5: checkOnly на журнале бесплатен (grant не нужен), тариф показан как paid", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const res = geoPatchSamsung({ path: pool, region: 0x02, checkOnly: true });
  assert.equal(res.rc, 0);
  assert.equal(res.target, null);
  // отчёт тарифицируется как «платный дамп», но сам отчёт ничего не стоит
  assert.equal(res.license, "paid");
  assert.equal(fs.existsSync(`${pool}.patched`), false);
});

test("G6: с grant журнал правится во ВСЕХ массивах и файл верифицируется", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const out = sibling(pool, ".patched");
  const res = geoPatchSamsung({ path: pool, out, region: 0x02, grant: TRIAL });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "paid");
  assert.equal(res.target, out);
  const patched = fs.readFileSync(out);
  for (const base of ARRAY_BASES) {
    const byte = patched[regionRecordOffset(base) + (REGION_OFF & 0xff)];
    assert.equal(byte, 0x02, `array @0x${base.toString(16)}`);
  }
});

test("G7: запись поверх исходника запрещена (исходник = откат мастера)", () => {
  const file = tmpFile("image.bin", buildImage(0x01));
  assert.throws(
    () => geoPatchSamsung({ path: file, out: file, region: 0x02, grant: TRIAL }),
    BadInput,
  );
});

test("G8: относительный путь и не-файл отвергаются", () => {
  assert.throws(() => geoScanSamsung({ path: "image.bin" }), BadInput);
  assert.throws(() => geoScanSamsung({ path: os.tmpdir() }), BadInput);
  assert.throws(() => geoScanSamsung({ path: path.join(os.tmpdir(), "geo-missing.bin") }), BadInput);
});

test("G9: регион вне байта отвергается", () => {
  const file = tmpFile("image.bin", buildImage(0x01));
  assert.throws(
    () => geoPatchSamsung({ path: file, out: sibling(file, ".p"), region: 0x100, grant: TRIAL }),
    BadInput,
  );
});

test("G10: скан бесплатен и ничего не пишет", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const res = geoScanSamsung({ path: pool });
  assert.equal(res.ok, true);
  assert.equal(res.copies.length, 2);
  assert.equal(fs.existsSync(`${pool}.patched`), false);
});

test("G12: дамп раздела с плоскими копиями платный — без grant патч не начинается", () => {
  const dump = tmpFile("flat-areas.bin", buildFlatAreas(buildImage(0x01)));
  const out = sibling(dump, ".patched");
  assert.throws(
    () => geoPatchSamsung({ path: dump, out, region: 0x02 }),
    LicenseRequired,
    "дамп раздела — платно, отказ должен быть про оплату",
  );
  assert.equal(fs.existsSync(out), false, "гейт срабатывает ДО записи файла");
  // с grant'ом тот же дамп правится: плоских копий больше одной, значит это
  // дамп раздела, а не микросхема (D-150)
  const res = geoPatchSamsung({ path: dump, out, region: 0x02, grant: TRIAL });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "paid");
  const patched = fs.readFileSync(out);
  for (const base of FLAT_IMAGE_BASES) {
    assert.equal(patched[base + 0x3e65], 0x02, `копия @0x${base.toString(16)}`);
  }
});

test("G12b: скан дампа раздела бесплатен и сразу говорит «потрібен grant»", () => {
  const dump = tmpFile("flat-areas.bin", buildFlatAreas(buildImage(0x01)));
  const scan = geoScanSamsung({ path: dump });
  assert.equal(scan.ok, true);
  assert.equal(scan.copies.length, FLAT_IMAGE_BASES.length);
  assert.ok(scan.copies.every(copy => copy.kind === "image"), "в таком дампе только плоские копии");
  assert.equal(scan.dumpKind, "emmc-journal");
  assert.equal(scan.needsGrant, true);
  assert.ok(
    !scan.log.some(line => /GPP/i.test(line)),
    "никаких упоминаний снятой теории GPP1 в отчёте быть не должно",
  );
  assert.equal(fs.existsSync(`${dump}.patched`), false);
});

test("G13: владельцу платный журнал доступен без списания (grant kind owner)", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const out = sibling(pool, ".patched");
  const res = geoPatchSamsung({
    path: pool,
    out,
    region: 0x03,
    grant: { id: "owner-1", kind: "owner" },
  });
  assert.equal(res.rc, 0);
  // тариф дампа остаётся платным — бесплатной была выдача grant'а, а не операция
  assert.equal(res.license, "paid");
  const patched = fs.readFileSync(out);
  for (const base of ARRAY_BASES) {
    const byte = patched[regionRecordOffset(base) + (REGION_OFF & 0xff)];
    assert.equal(byte, 0x03, `array @0x${base.toString(16)}`);
  }
});

test("G14: образ не с начала файла — это дамп раздела (платно), а не микросхема", () => {
  const dump = Buffer.alloc(0x20000);
  buildImage(0x01).copy(dump, 0x10000);
  const file = tmpFile("offset-image.bin", dump);
  const scan = geoScanSamsung({ path: file });
  assert.equal(scan.copies.length, 1);
  assert.equal(scan.copies[0].imageBase, 0x10000);
  assert.equal(scan.dumpKind, "emmc-journal");
  assert.equal(scan.needsGrant, true);
  assert.throws(
    () => geoPatchSamsung({ path: file, out: sibling(file, ".patched"), region: 0x02 }),
    LicenseRequired,
  );
  assert.equal(fs.existsSync(`${file}.patched`), false);
  // с grant'ом правится: единственный образ лежит по смещению, регион меняется
  const out = sibling(file, ".paid");
  const res = geoPatchSamsung({ path: file, out, region: 0x02, grant: TRIAL });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "paid");
  assert.equal(fs.readFileSync(out)[0x10000 + 0x3e65], 0x02);
});

test("G15: платный дамп БЕЗ рабочей копии тоже предупреждает — на ТВ ничего не изменится", () => {
  // Реальный сценарий мастера: он снял не 2 МиБ из eMMC, а область плоских копий.
  // Дамп платный (это раздел eMMC, grant нужен), но рабочей копии региона в нём
  // нет: править нечего. На работающем ТВ такой патч регион НЕ меняет — и раньше
  // сервис об этом молчал (предупреждение висело только на `license === "free"`),
  // рапортуя зелёный успех.
  const dump = tmpFile("flat-areas.bin", buildFlatAreas(buildImage(0x01)));
  const out = sibling(dump, ".patched");
  const res = geoPatchSamsung({ path: dump, out, region: 0x02, grant: TRIAL });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "paid");
  assert.ok(
    res.log.some(line => line.includes("no working region copy")),
    "платный патч без рабочей копии обязан предупредить так же, как бесплатный",
  );
  // Рендерер не вычисляет состав копий сам: main отдаёт готовый признак.
  const flatOnly = (res as { flatOnly?: boolean }).flatOnly;
  assert.equal(flatOnly, true, "нужен флаг flatOnly для текста предупреждения в UI");
});

test("G16: патч рабочей копии раздела eMMC НЕ помечается как «нет рабочей копии»", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const res = geoPatchSamsung({ path: pool, out: sibling(pool, ".patched"), region: 0x02, grant: TRIAL });
  assert.equal(res.rc, 0);
  assert.equal(res.license, "paid");
  assert.ok(
    !res.log.some(line => line.includes("no working region copy")),
    "рабочая копия поправлена — лишнего предупреждения быть не должно",
  );
  assert.equal((res as { flatOnly?: boolean }).flatOnly, false);
});

test("G11: LG — скан и патч бесплатны (отказ приходит от ядра, не от гейта)", () => {
  // 32 KiB «не-LG» образ: гейта здесь нет вообще, отказ — доменный (NotLgNvm)
  const file = tmpFile("lg.bin", Buffer.alloc(0x8000, 0xaa));
  const scan = geoScanLg({ path: file });
  assert.equal(scan.ok, false);
  assert.equal(scan.rc, 2);
  assert.throws(() => geoPatchLg({ path: file, out: sibling(file, ".p"), newValue: 3640 }), BadInput);
  assert.throws(
    () => geoPatchLg({ path: file, out: sibling(file, ".p"), newValue: 3640, grant: TRIAL }),
    BadInput,
  );
});
