/**
 * Общие фикстуры тестов GEO_Unlock.
 *
 * Синтетические дампы построены по той же схеме, что в оригинальных наборах
 * `tools/test_eeprom_region_patch.py` / `tools/test_lg_nvm_core.py` апстрима,
 * поэтому тесты проверяют перенос ядер, а не «похожесть» поведения: реальные
 * многогигабайтные дампы для прогона не нужны.
 *
 * Файл НЕ является тестом (нет суффикса `.test.ts`) — это разделяемый хелпер.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  IMG_CRC_OFF,
  IMG_SIZE,
  LANE,
  REC_CRC_A,
  REC_CRC_B,
  REC_CRC_META,
  REC_CRC_P,
  REC_DATA_A,
  REC_DATA_B,
  REC_PARITY,
  REC_SEQ,
  REC_SIZE,
  REC_SPAN,
  REC_TAG,
  REGION_OFF,
  SEED,
  SPAN_BYTES,
  crc32c,
  put32,
} from "../electron/geo-unlock/index";

/** Strict fingerprint anchor at logical 0x3E60. */
const ANCHOR = Buffer.from("0100000100", "hex");

/** Mask bytes of the window around the region byte (generation <= 2025). */
const MASK_BYTES: Array<[number, number]> = [
  [0x3e60, 0x01],
  [0x3e61, 0x00],
  [0x3e62, 0x00],
  [0x3e63, 0x01],
  [0x3e64, 0x00],
  [0x3e66, 0x01],
  [0x3e67, 0x00],
  [0x3e68, 0x00],
  [0x3e69, 0x00],
  [0x3e6b, 0x00],
  [0x3e6c, 0x00],
  [0x3e6e, 0x00],
  [0x3e6f, 0x70],
];

/** 64 KiB eeprom image with the fingerprint window and a valid checksum. */
export function buildImage(region = 0x01): Buffer {
  const img = Buffer.alloc(IMG_SIZE);
  for (let i = 0; i < IMG_SIZE; i += 1) img[i] = (i * 7 + 3) & 0xff;
  ANCHOR.copy(img, 0x3e60);
  for (const [off, val] of MASK_BYTES) img[off] = val;
  img[REGION_OFF] = region;
  put32(img, IMG_CRC_OFF, crc32c(SEED, img.subarray(0, IMG_CRC_OFF)));
  return img;
}

/** 2026-generation window: volatile bytes differ, region byte stays in place. */
const VARIANT_WINDOW = Buffer.from("0100010100010000000000000000007017", "hex");

export function buildImageVariant(region = 0x01): Buffer {
  const img = Buffer.alloc(IMG_SIZE);
  for (let i = 0; i < IMG_SIZE; i += 1) img[i] = (i * 7 + 3) & 0xff;
  VARIANT_WINDOW.copy(img, 0x3e60);
  img[REGION_OFF] = region;
  put32(img, IMG_CRC_OFF, crc32c(SEED, img.subarray(0, IMG_CRC_OFF)));
  return img;
}

/**
 * Дамп микросхемы NVM 24C512 (64 КиБ) — ровно так, как его читает программатор.
 *
 * Ключевое отличие от плоской копии в области раздела: поле контрольной суммы в
 * конце образа (`0xFFFC`) у микросхемы ПУСТОЕ — `0xFFFFFFFF`. Так в эталонном
 * образе апстрима `24_512_20220122_154903.BIN` (регион `0x02`, CRC нет), и это
 * норма, а не «устаревшая сумма»: CRC32C образа считает только драйвер/область
 * GPP1, к 24C512 он отношения не имеет.
 *
 * @param region байт региона (логический `0x3E65`)
 * @param crcField значение поля `0xFFFC` (по умолчанию — стёртое `0xFFFFFFFF`)
 */
export function buildChip(region = 0x01, crcField = 0xffffffff): Buffer {
  const img = buildImage(region);
  put32(img, IMG_CRC_OFF, crcField >>> 0);
  return img;
}

/** One journal record holding the image span `span` in its two data lanes. */
export function buildRecord(span: number, image: Buffer, seq = 0x100, tag = "test"): Buffer {
  const rec = Buffer.alloc(REC_SIZE);
  image.copy(rec, REC_DATA_A, span, span + LANE);
  image.copy(rec, REC_DATA_B, span + LANE, span + SPAN_BYTES);
  for (let i = 0; i < LANE; i += 1) {
    rec[REC_PARITY + i] = rec[REC_DATA_A + i] ^ rec[REC_DATA_B + i];
  }
  put32(rec, REC_CRC_A, crc32c(SEED, rec.subarray(REC_DATA_A, REC_DATA_A + LANE)));
  put32(rec, REC_CRC_B, crc32c(SEED, rec.subarray(REC_DATA_B, REC_DATA_B + LANE)));
  put32(rec, REC_CRC_P, crc32c(SEED, rec.subarray(REC_PARITY, REC_PARITY + LANE)));
  put32(rec, REC_SPAN, span);
  put32(rec, REC_SEQ, seq);
  rec.write(tag, REC_TAG, "latin1");
  put32(rec, REC_CRC_META, crc32c(SEED, rec.subarray(REC_CRC_A, REC_CRC_META)));
  return rec;
}

/** Real pool layout: entry header @0x40000, live array @0x40200, copy @0x60200. */
export const ARRAY_BASES = [0x40200, 0x60200];

/** Плоские копии в дампе раздела: образ за заголовком на каждом из смещений. */
export const FLAT_IMAGE_BASES = [0x40200, 0x140200];

/**
 * Дамп раздела eMMC с ПЛОСКИМИ копиями образа (2 МиБ).
 *
 * Такой файл — не дамп микросхемы (не 64 КиБ и образ не с нуля), поэтому для
 * инструмента он дамп раздела: платно. Копии лежат за 512-байтовыми заголовками
 * `eeprom`, ровно как в реальном срезе области.
 */
export function buildFlatAreas(image: Buffer): Buffer {
  const dump = Buffer.alloc(0x200000);
  const hdr = Buffer.alloc(REC_SIZE);
  hdr.write("eeprom", 0, "latin1");
  put32(hdr, REC_CRC_META, crc32c(SEED, hdr.subarray(REC_CRC_A, REC_CRC_META)));
  for (const base of FLAT_IMAGE_BASES) {
    hdr.copy(dump, base - REC_SIZE);
    image.copy(dump, base);
  }
  return dump;
}

/** A 2 MiB NVRAM pool slice with both journal array copies. */
export function buildPool(image: Buffer): Buffer {
  const pool = Buffer.alloc(0x200000);
  const hdr = Buffer.alloc(REC_SIZE);
  hdr.write("eeprom", 0, "latin1");
  put32(hdr, REC_CRC_META, crc32c(SEED, hdr.subarray(REC_CRC_A, REC_CRC_META)));
  hdr.copy(pool, 0x40000);
  for (const base of ARRAY_BASES) {
    for (let k = 0; k < IMG_SIZE / SPAN_BYTES; k += 1) {
      buildRecord(k * SPAN_BYTES, image).copy(pool, base + k * REC_SIZE);
    }
  }
  return pool;
}

/** Record offset of the region span inside one journal array. */
export function regionRecordOffset(arrayBase: number): number {
  return arrayBase + ((REGION_OFF & ~0xff) / SPAN_BYTES) * REC_SIZE;
}

const createdDirs: string[] = [];
process.on("exit", () => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Temp file in its own directory; the directory is removed at process exit. */
export function tmpFile(name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-unlock-"));
  createdDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

/** Path next to `base` (same temp directory) for patch output. */
export function sibling(base: string, suffix: string): string {
  return `${base}${suffix}`;
}
