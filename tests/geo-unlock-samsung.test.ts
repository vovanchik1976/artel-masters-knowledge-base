/**
 * GEO_Unlock / Samsung eeprom region core — поведенческие тесты.
 *
 * Порт ядра `tools/eeprom_region_patch.py` (см. `electron/geo-unlock/samsung.ts`).
 * Фикстуры — в `tests/geo-unlock-fixtures.ts` (та же схема, что в оригинальном
 * Python-наборе апстрима).
 *
 * Что защищаем (инварианты, на которых держится фича):
 *   S1 — CRC32C совпадает со стандартным check-value (иначе прошивка отвергнет
 *        «пропатченный» байт и восстановит старое значение из другой копии);
 *   S2 — байт региона находится и в flat-образе, и в журнальном пуле, и в
 *        поколении 2026 (толерантное окно);
 *   S3 — патч правит ВСЕ копии (parity + CRC32C), а не один байт;
 *   S4 — повреждённая запись восстанавливается из резервной копии массива;
 *   S5 — шум не даёт ложного кандидата (иначе можно «пропатчить» чужой байт);
 *   S6/S7 — честные коды возврата (2 = нечего патчить, 1 = нет файла).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  IMG_CRC_OFF,
  IMG_SIZE,
  REC_DATA_A,
  REC_SIZE,
  REGION_OFF,
  SEED,
  DumpReader,
  assembleArray,
  crc32c,
  findCandidates,
  patchSamsung,
  recordHealthy,
  recordState,
  scanSamsung,
  u32,
} from "../electron/geo-unlock/index";

import {
  ARRAY_BASES,
  buildChip,
  buildImage,
  buildImageVariant,
  buildPool,
  regionRecordOffset,
  sibling,
  tmpFile,
} from "./geo-unlock-fixtures";

test("S1: CRC32C совпадает со стандартным check-value", () => {
  // стандартная проверка Castagnoli: crc32c("123456789") == 0xE3069283
  const std = (crc32c(0xffffffff, Buffer.from("123456789", "latin1")) ^ 0xffffffff) >>> 0;
  assert.equal(std, 0xe3069283);
});

test("S2a: байт региона найден в flat-образе со смещением", () => {
  const img = buildImage();
  const file = tmpFile("image.bin", Buffer.concat([Buffer.alloc(0x100), img, Buffer.alloc(0x40)]));
  const reader = new DumpReader(file);
  try {
    assert.deepEqual(findCandidates(reader), [0x100 + REGION_OFF]);
  } finally {
    reader.close();
  }
});

test("S2b: поколение 2026 (толерантное окно) тоже распознаётся", () => {
  const file = tmpFile("variant.bin", buildImageVariant());
  const reader = new DumpReader(file);
  try {
    assert.deepEqual(findCandidates(reader), [REGION_OFF]);
  } finally {
    reader.close();
  }
});

test("S5: на шуме ложных кандидатов нет", () => {
  const noise = Buffer.alloc(256 * 64);
  for (let i = 0; i < noise.length; i += 1) noise[i] = i & 0xff;
  const file = tmpFile("noise.bin", noise);
  const reader = new DumpReader(file);
  try {
    assert.deepEqual(findCandidates(reader), []);
  } finally {
    reader.close();
  }
});

test("S2c: в пуле находится ровно две записи (живая + резервная)", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const res = scanSamsung(pool);
  assert.equal(res.ok, true);
  assert.equal(res.copies.length, 2);
  for (const inf of res.copies) {
    assert.equal(inf.kind, "record");
    assert.equal(inf.span, REGION_OFF & ~0xff);
    assert.equal(recordHealthy(inf.state ?? null), true);
    assert.equal(inf.oldRegion, 0x01);
  }
});

test("S2d: сборка образа из журнала даёт исходный образ байт-в-байт", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const reader = new DumpReader(pool);
  try {
    assert.deepEqual(assembleArray(reader, ARRAY_BASES[0]), buildImage(0x01));
  } finally {
    reader.close();
  }
});

test("S3a: check-only ничего не пишет", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const res = patchSamsung({ inputPath: pool, region: 0x02, checkOnly: true });
  assert.equal(res.rc, 0);
  assert.equal(res.target, null);
  assert.equal(fs.existsSync(`${pool}.patched`), false);
});

test("S3b: патч правит регион в ОБЕИХ копиях и пересчитывает CRC", () => {
  const pool = tmpFile("pool.bin", buildPool(buildImage(0x01)));
  const out = sibling(pool, ".out");
  const res = patchSamsung({ inputPath: pool, outputPath: out, region: 0x02 });
  assert.equal(res.rc, 0);
  assert.equal(res.ok, true);
  const reader = new DumpReader(out);
  try {
    for (const base of ARRAY_BASES) {
      const rec = regionRecordOffset(base);
      assert.equal(reader.read(rec, REC_SIZE)[REC_DATA_A + (REGION_OFF & 0xff)], 0x02);
      assert.equal(recordHealthy(recordState(reader, rec)), true);
    }
    const image = assembleArray(reader, ARRAY_BASES[0]);
    assert.ok(image);
    assert.equal(image[REGION_OFF], 0x02);
    assert.equal(u32(image, IMG_CRC_OFF), crc32c(SEED, image.subarray(0, IMG_CRC_OFF)));
  } finally {
    reader.close();
  }
});

test("S4: повреждённая запись восстанавливается из резервной копии", () => {
  const pool = buildPool(buildImage(0x01));
  const spanRec = regionRecordOffset(ARRAY_BASES[0]);
  pool[spanRec + REC_DATA_A] ^= 0x40; // повреждаем только дорожку данных
  const bad = tmpFile("bad.bin", pool);
  const out = sibling(bad, ".fixed");
  const res = patchSamsung({ inputPath: bad, outputPath: out, region: 0x02 });
  assert.equal(res.rc, 0);
  const reader = new DumpReader(out);
  try {
    assert.equal(recordHealthy(recordState(reader, spanRec)), true);
  } finally {
    reader.close();
  }
});

test("S3c: flat-образ — правятся регион И контрольная сумма, исходник цел", () => {
  const file = tmpFile("image.bin", buildImage(0x01));
  const out = sibling(file, ".patched");
  const res = patchSamsung({ inputPath: file, outputPath: out, region: 0x02 });
  assert.equal(res.rc, 0);
  const patched = fs.readFileSync(out);
  assert.equal(patched[REGION_OFF], 0x02);
  assert.equal(u32(patched, IMG_CRC_OFF), crc32c(SEED, patched.subarray(0, IMG_CRC_OFF)));
  assert.equal(fs.readFileSync(file)[REGION_OFF], 0x01);
});

test("S3d: дамп микросхемы 24C512 (пустое поле суми) — правиться ЛИШЕ байт регіону", () => {
  // Живий факт: у справжньої мікросхеми поле 0xFFFC стерте (0xFFFFFFFF) — так і в
  // еталонному образі апстриму `24_512_20220122_154903.BIN`. Тому «сума не
  // збігається» тут — не дефект дампа, і лякати майстра не можна (вимога власника
  // «менше про пули»): у 24C512 контрольної суми немає взагалі.
  const file = tmpFile("chip.bin", buildChip(0x01));
  const out = sibling(file, ".patched");
  const res = patchSamsung({ inputPath: file, outputPath: out, region: 0x02 });
  assert.equal(res.ok, true);
  assert.equal(res.rc, 0);
  assert.equal(res.changedBytes, 1, "у мікросхемі змінюється рівно один байт — регіон");
  assert.equal(res.changedPlaces, 1);
  assert.equal(res.staleImageCrc, 0, "стерте поле — не «застаріла сума», рахувати її не можна");
  assert.ok(
    !res.log.some(line => /stale|WARNING/i.test(line)),
    "лог не повинен лякати «stale»/«WARNING» на нормальному дампі мікросхеми",
  );

  const patched = fs.readFileSync(out);
  assert.equal(patched.length, IMG_SIZE, "розмір 64 КіБ мусить зберегтися");
  assert.equal(patched[REGION_OFF], 0x02);
  assert.equal(u32(patched, IMG_CRC_OFF), 0xffffffff, "стерте поле не заповнюємо");

  // Повторний патч того ж файлу: робити нічого — «0 змін», а не «1 байт».
  const again = patchSamsung({ inputPath: out, outputPath: sibling(out, ".2"), region: 0x02 });
  assert.equal(again.ok, true);
  assert.equal(again.changedBytes, 0, "повторний патч не має рапортувати зміни");
  assert.equal(again.changedPlaces, 0);
});

test("S3e: справжній слід суми (не стерте поле) — попередження лишається", () => {
  // Регресійний бік S3d: якщо в дампі лежить НЕ 0xFFFFFFFF, це справді чуже/збите
  // значення (наприклад слід наївного однобайтового патча). Його не перезаписуємо
  // в режимі `auto`, але й мовчати не можна — сума є, і вона не сходиться.
  const file = tmpFile("chip-stale-crc.bin", buildChip(0x01, 0xdeadbeef));
  const out = sibling(file, ".patched");
  const res = patchSamsung({ inputPath: file, outputPath: out, region: 0x02 });
  assert.equal(res.ok, true);
  assert.equal(u32(fs.readFileSync(out), IMG_CRC_OFF), 0xdeadbeef, "auto не перезаписує суму");
  assert.ok(
    res.log.some(line => /checksum/i.test(line) && /left as is|does not match/i.test(line)),
    "про наявну, але невалідну суму треба сказати в лозі",
  );
});

test("S6: дамп без отпечатка — rc=2 и внятная причина в логе", () => {
  const file = tmpFile("unsupported.bin", Buffer.alloc(0x10000, 0xff));
  const res = patchSamsung({ inputPath: file, region: 0x02 });
  assert.equal(res.rc, 2);
  assert.equal(res.ok, false);
  assert.ok(res.log.some(line => line.includes("no eeprom region fingerprint")));
});

test("S7: несуществующий файл — rc=1", () => {
  const res = patchSamsung({
    inputPath: path.join(os.tmpdir(), "geo-unlock-missing.bin"),
    region: 2,
  });
  assert.equal(res.rc, 1);
  assert.equal(res.ok, false);
});
