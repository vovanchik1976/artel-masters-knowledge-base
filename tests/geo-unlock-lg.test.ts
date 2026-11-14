/**
 * GEO_Unlock / LG NVM (24C256) Area Option core — поведенческие тесты.
 *
 * Порт ядра `tools/lg_nvm_core.py` (см. `electron/geo-unlock/lg.ts`). Фикстура
 * повторяет схему оригинального набора апстрима: 32 КиБ образ, три блока NVM
 * (`0x0480`, `0x04E0`, `0x18E0`), строка страны `POL` и значение Area Option
 * 3122 (EU/Польша) по адресу `0x04FC`.
 *
 * Что защищаем:
 *   L1 — упаковка/распаковка Area Option и диапазоны языков совпадают с
 *        таблицами (иначе мастер запишет «чужой регион»);
 *   L2 — эвристика «это LG NVM» не срабатывает на шуме (иначе патч пойдёт по
 *        случайному байту);
 *   L3 — скан находит значение именно в `0x04FC` и ставит его первым;
 *   L4 — патч пишет НОВЫЙ файл и меняет ровно 2 байта, dry-run не пишет;
 *   L5 — `--old` / `--offset` защищают от правки чужого дампа (AreaNotFound).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LG_IMG_SIZE,
  AreaNotFound,
  NotLgNvm,
  decode,
  encode,
  isLgNvm,
  patchLg,
  regionRange,
  scanCandidates,
  scanLg,
} from "../electron/geo-unlock/index";

import { sibling, tmpFile } from "./geo-unlock-fixtures";

/** One LG NVM block: `[id, len, kind, 0x20]` + payload. */
function buildBlock(blockId: number, payload: Buffer, kind = 0x20): Buffer {
  return Buffer.concat([Buffer.from([blockId, payload.length & 0xff, kind, 0x20]), payload]);
}

/** A 32 KiB dump with a plausible LG layout and one Area Option value. */
function buildLgDump(areaValue = 3122, areaOff = 0x04fc, country = "POL", blkStart = 0x04e0): Buffer {
  const img = Buffer.alloc(LG_IMG_SIZE, 0xff);
  const mac = Buffer.from("60:75:6C:25:78:C9\x00\x68\x01", "latin1");
  buildBlock(0x18, mac, 0x19).copy(img, 0x0480);
  // третий блок, чтобы отпечаток NVM был однозначным
  const extraPayload = Buffer.alloc(0x1c);
  for (let i = 0; i < extraPayload.length; i += 1) extraPayload[i] = i;
  buildBlock(0x08, extraPayload, 0x19).copy(img, 0x18e0);
  const payload = Buffer.alloc(0x70);
  Buffer.from([0x8a, 0x08, 0x01, 0x00]).copy(payload, 0x00);
  payload.write("43LR60006LA", 0x40, "latin1");
  payload.write("602TALB27352", 0x58, "latin1");
  payload.write(`${country}\x00`, 0x6c, "latin1");
  const block = buildBlock(0x14, payload);
  const pos = areaOff - blkStart;
  block[pos] = areaValue & 0xff;
  block[pos + 1] = (areaValue >>> 8) & 0xff;
  block.copy(img, blkStart);
  return img;
}

test("L1a: decode совпадает с эталонными значениями апстрима", () => {
  assert.deepEqual(decode(3122), [50, 24, 0]); // EU / POL
  assert.deepEqual(decode(3640), [56, 28, 0]); // CIS
  assert.deepEqual(decode(22282), [10, 14, 5]); // US
  assert.deepEqual(decode(19461), [5, 24, 4]); // EU / KR
});

test("L1b: encode/decode — обратимый обход", () => {
  for (const [ci, lang, hw] of [
    [50, 24, 0],
    [56, 28, 0],
    [10, 14, 5],
  ]) {
    assert.deepEqual(decode(encode(ci, lang, hw)), [ci, lang, hw]);
  }
});

test("L1c: диапазоны регионов совпадают с таблицей", () => {
  assert.deepEqual(regionRange(24), [3072, 3199]); // EU
  assert.deepEqual(regionRange(28), [3584, 3711]); // CIS
  assert.deepEqual(regionRange(0), [0, 127]); // NORDIC
});

test("L2: эвристика «это LG NVM» верна для синтетики и ложна для шума", () => {
  assert.equal(isLgNvm(buildLgDump()), true);
  const noise = Buffer.alloc(LG_IMG_SIZE);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7 + 3) & 0xff;
  assert.equal(isLgNvm(noise), false);
  assert.equal(isLgNvm(Buffer.alloc(LG_IMG_SIZE, 0xff)), false);
  assert.equal(isLgNvm(Buffer.alloc(LG_IMG_SIZE / 2)), false); // не тот размер
});

test("L3: скан находит значение в 0x04FC и ставит его первым", () => {
  const candidates = scanCandidates(buildLgDump(3122, 0x04fc));
  assert.ok(candidates.some(c => c.offset === 0x04fc));
  const top = candidates[0];
  assert.equal(top.offset, 0x04fc);
  assert.equal(top.value, 3122);
  assert.equal(top.lang, 24);
  assert.equal(top.country, "POL");
  assert.deepEqual(decode(top.value), [50, 24, 0]);
});

test("L4a: патч пишет НОВЫЙ файл и меняет ровно 2 байта", () => {
  const file = tmpFile("lg.bin", buildLgDump(3122));
  const out = sibling(file, ".patched.BIN");
  const res = patchLg({ inputPath: file, outputPath: out, newValue: 3640 });
  assert.equal(res.ok, true);
  assert.equal(res.offset, 0x04fc);
  assert.equal(res.oldValue, 3122);
  assert.equal(res.newValue, 3640);
  assert.equal(res.country, "POL");

  const before = fs.readFileSync(file);
  const after = fs.readFileSync(out);
  assert.equal(after.length, before.length);
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed += 1;
  assert.equal(changed, 2);
  assert.equal(after[0x04fc], 3640 & 0xff);
  assert.equal(after[0x04fd], (3640 >>> 8) & 0xff);
  // исходник не тронут
  assert.equal(before[0x04fc], 3122 & 0xff);
});

test("L4b: dry-run не пишет файл", () => {
  const file = tmpFile("lg.bin", buildLgDump(3122));
  const out = sibling(file, ".dry.BIN");
  const res = patchLg({ inputPath: file, outputPath: out, newValue: 3640, dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.target, null);
  assert.equal(fs.existsSync(out), false);
});

test("L5a: чужое ожидаемое значение — AreaNotFound, файл не создан", () => {
  const file = tmpFile("lg.bin", buildLgDump(3122));
  const out = sibling(file, ".nope.BIN");
  assert.throws(
    () => patchLg({ inputPath: file, outputPath: out, newValue: 3640, oldValue: 999 }),
    AreaNotFound,
  );
  assert.equal(fs.existsSync(out), false);
});

test("L5b: явный смещённый offset отвергается", () => {
  const file = tmpFile("lg.bin", buildLgDump(3122));
  assert.throws(
    () => patchLg({ inputPath: file, newValue: 3640, offset: 0x04fd, dryRun: true }),
    AreaNotFound,
  );
});

test("L5c: не-LG образ — NotLgNvm (не патчим случайный файл)", () => {
  const file = tmpFile("noise.bin", Buffer.alloc(LG_IMG_SIZE, 0xaa));
  assert.throws(() => patchLg({ inputPath: file, newValue: 3640, dryRun: true }), NotLgNvm);
});

test("L6: scanLg отдаёт отчёт и код возврата как CLI апстрима", () => {
  const file = tmpFile("lg.bin", buildLgDump(3122));
  const res = scanLg(file);
  assert.equal(res.rc, 0);
  assert.equal(res.ok, true);
  assert.equal(res.looksLikeLgNvm, true);
  assert.ok(res.log.some(line => line.includes("=== LG NVM area scan ===")));
  assert.ok(res.log.some(line => line.includes("score=")));

  const missing = scanLg(path.join(path.dirname(file), "absent.bin"));
  assert.equal(missing.rc, 1);
  assert.equal(missing.ok, false);
});
