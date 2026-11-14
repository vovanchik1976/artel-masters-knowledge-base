/**
 * Samsung Tizen TV "region" (country) byte — headless core.
 *
 * Port of the upstream headless core `tools/eeprom_region_patch.py` from the
 * GEO_Unlock project (`/home/mega/Project/samsung_region`). The Tkinter
 * front-end is deliberately NOT ported: the desktop client is an Electron app,
 * so the core runs in the main process and the renderer only renders the
 * structured report returned here.
 *
 * What the region byte is (verified on BN41-03449A / UE43U8072HUXXH):
 *   * logical offset `0x3E65` of a flat 64 KiB eeprom image;
 *   * the image is stored in several redundant copies — a journal array inside
 *     the NVRAM pool (`/dev/mmcblk0p31`, 256 records x 512 B) and flat images
 *     inside the GPP1 area;
 *   * ONLY the journal array is the live copy: the `tztv-eeprom` driver reads
 *     the region out of the pool, so patching the GPP1 flat images alone changes
 *     nothing on a running TV (upstream `docs/eeprom-format.md` §1, verified on
 *     BN41-03449A). A standalone 64 KiB image is an NVM chip (24C512) read.
 *     That difference is also the paid/free split of the service layer:
 *     `kind: "record"` (eMMC pool) is paid, while a flat image is free ONLY as a
 *     pure 64 KiB NVM-chip dump; a GPP1 area dump is refused by `service.ts`
 *     (decision D-149) — this core stays a generic port of the upstream tool;
 *   * a naive one-byte patch is REJECTED by the firmware: the record CRCs stop
 *     matching and the driver restores the old value from another copy, so
 *     every copy must be patched together with its parity byte / CRC32C.
 *
 * Invariants preserved from the original core (they are the reason the tool
 * works at all — do not "simplify" them):
 *   1. three complementary copy locators are unioned (strict anchor,
 *      generation-tolerant window, structural journal discovery);
 *   2. a fingerprint hit inside the derived tail (parity/CRC/tag lanes) of a
 *      VALID journal record is discarded — those bytes are derived, patching
 *      them corrupts the record instead of the region;
 *   3. a damaged record is rebuilt from the healthy redundant copy of the same
 *      span when one exists, otherwise parity/CRCs are regenerated around the
 *      bytes that are still stored;
 *   4. the image checksum at `0xFFFC` is refreshed only when it currently IS a
 *      valid CRC32C of that image (`auto`), or is forced (`always`);
 *   5. the input file is never modified: the patch always goes to a new file.
 *
 * Exit-code contract of the original `patch()` is kept:
 *   0 — done / verification passed,
 *   1 — error (missing input),
 *   2 — nothing found or verification failed.
 */
import * as fs from "node:fs";

import { crc32c, put32, u32 } from "./crc32c";

/** CRC32C seed used by the `tztv-eeprom` driver. */
export const SEED = 0xaa55aa55;
/** Size of the flat eeprom image (64 KiB). */
export const IMG_SIZE = 0x10000;
/** Offset of the image checksum inside the flat image. */
export const IMG_CRC_OFF = 0xfffc;
/** Logical offset of the region (country) byte. */
export const REGION_OFF = 0x3e65;
/**
 * Значение поля контрольной суммы образа (`0xFFFC`) у «стертого» дампа.
 *
 * У микросхемы NVM 24C512 (и у среза, снятого с чипа программатором) это поле
 * ПУСТОЕ — `0xFFFFFFFF`; так и в эталонном образе апстрима
 * `24_512_20220122_154903.BIN` (регион `0x02`, контрольной суммы нет). Это норма,
 * а не «застарелая сумма»: CRC32C образа относится к плоским копиям раздела
 * eMMC/GPP1, микросхема его не хранит. Без этого различения инструмент пугал
 * мастера предупреждением «stale» и предлагал записать сумму, которой на
 * микросхеме никогда не было.
 */
export const ERASED_CRC = 0xffffffff;
/** Image bytes covered by one journal record. */
export const SPAN_BYTES = 0x100;
/** Bytes per data lane inside a journal record. */
export const LANE = 0x80;

/** Streaming window used by the locators (mirrors the Python CHUNK). */
const CHUNK = 8 << 20;

/** Journal record layout. */
export const REC_SIZE = 0x200;
export const REC_DATA_A = 0x000;
export const REC_DATA_B = 0x080;
export const REC_PARITY = 0x100;
export const REC_CRC_A = 0x180;
export const REC_CRC_B = 0x190;
export const REC_CRC_P = 0x1a0;
export const REC_SPAN = 0x1b4;
export const REC_SEQ = 0x1b8;
export const REC_TAG = 0x1d0;
export const REC_CRC_META = 0x1fc;

/** Strict 5-byte anchor at logical 0x3E60 (original generations). */
const ANCHOR = Buffer.from("0100000100", "hex");
const ANCHOR_OFF = 0x3e60;
/** Window bytes for generations where the strict anchor matches. */
const MASK: ReadonlyMap<number, number> = new Map<number, number>([
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
]);

/**
 * Generation-tolerant window (2026 sets such as QE55QN80HAU keep the region
 * byte in place but differ in the volatile bytes 0x3E62 / 0x3E66 / 0x3E69 /
 * 0x3E6A), so those bytes are dropped and the 0x3E70 marker is used instead.
 */
const TOLERANT: ReadonlyMap<number, number> = new Map<number, number>([
  [0x3e60, 0x01],
  [0x3e61, 0x00],
  [0x3e63, 0x01],
  [0x3e64, 0x00],
  [0x3e67, 0x00],
  [0x3e68, 0x00],
  [0x3e6b, 0x00],
  [0x3e6c, 0x00],
  [0x3e6f, 0x70],
  [0x3e70, 0x17],
]);
/** Cheap scan seed of the tolerant window (logical 0x3E6F/0x3E70). */
const TOLERANT_SEED = Buffer.from("7017", "hex");
const SEED_OFF = 0x3e6f;
const WIN_START = ANCHOR_OFF;
const WIN_LAST = 0x3e70;
const WIN_LEN = WIN_LAST - WIN_START + 1; // 17 bytes

/** Image-checksum refresh policy (`--image-crc` of the original CLI). */
export type ImageCrcMode = "auto" | "always" | "never";

/** CRC/parity state of one 512-byte journal record. */
export interface RecordState {
  crcA: boolean;
  crcB: boolean;
  crcP: boolean;
  meta: boolean;
  parity: boolean;
  span: number;
  seq: number;
  tag: string;
}

/** One located copy of the region byte. */
export interface CopyInfo {
  /** `record` — inside a journal array; `image` — inside a flat eeprom image. */
  kind: "record" | "image";
  /** File offset of the region byte itself. */
  regionPos: number;
  /** Current region byte, `null` when the flat image is truncated. */
  oldRegion: number | null;
  // --- only for kind === "record" ---
  /** File offset of the owning 512-byte record. */
  record?: number;
  /** File offset of the journal array that owns the record. */
  arrayBase?: number;
  /** Image span covered by the record (`0x0000..0xFF00`). */
  span?: number;
  seq?: number;
  tag?: string;
  /** Record CRCs/parity verify. */
  valid?: boolean;
  /** Raw record state. */
  state?: RecordState;
  // --- only for kind === "image" ---
  /** File offset of the flat image base. */
  imageBase?: number;
  crcStored?: number;
  crcCalc?: number;
  /** Flat image checksum currently matches. */
  crcOk?: boolean;
}

/** Result of a scan. */
export interface SamsungScanResult {
  /** `true` when at least one copy was located. */
  ok: boolean;
  copies: CopyInfo[];
  /** Human-readable report lines (English, per repository log conventions). */
  log: string[];
}

/** Options of {@link patchSamsung}. */
export interface SamsungPatchOptions {
  /** Input dump (p31 slice, GPP1 area, whole USER dump — anything with a pool). */
  inputPath: string;
  /** Output file; default `<input>.patched`. Ignored when `inPlace` is set. */
  outputPath?: string;
  /** Patch the input file itself (the caller must warn the operator). */
  inPlace?: boolean;
  /** Region byte to write (0..255). */
  region: number;
  /** Image-checksum policy, default `auto`. */
  imageCrc?: ImageCrcMode;
  /** Report only, write nothing. */
  checkOnly?: boolean;
  /** Name the locator that matched (diagnostics). */
  verbose?: boolean;
  /**
   * Observer called with the located copies BEFORE anything is written.
   *
   * The core stays a pure port of the upstream tool and knows nothing about
   * licensing: the service layer uses this hook to decide whether the operation
   * is the paid one (journal array of the eMMC NVRAM pool) and to refuse before
   * a single byte reaches the target file. Throwing from the hook aborts the
   * patch with no side effects — nothing is written and no output file is
   * created.
   */
  onCopies?: (copies: CopyInfo[]) => void;
}

/** Result of {@link patchSamsung}. */
export interface SamsungPatchResult extends SamsungScanResult {
  /** Exit code of the original core: 0 ok, 1 error, 2 nothing found / failed. */
  rc: number;
  /** File that received the patch (`null` in check-only mode). */
  target: string | null;
  /** Number of changed bytes. */
  changedBytes: number;
  /** Number of changed places (offsets). */
  changedPlaces: number;
  /** Flat images whose checksum was left stale on purpose. */
  staleImageCrc: number;
}

/** Read-only random access to the dump with Python-compatible streaming. */
export class DumpReader {
  private readonly fd: number;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, "r");
  }

  get size(): number {
    return fs.fstatSync(this.fd).size;
  }

  /** Read up to `size` bytes at `off` (short read at EOF, like Python). */
  read(off: number, size: number): Buffer {
    if (size <= 0 || off < 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(size);
    const got = fs.readSync(this.fd, buf, 0, size, off);
    return buf.subarray(0, got);
  }

  /** One byte as a number, `-1` at EOF. */
  byte(off: number): number {
    const b = this.read(off, 1);
    return b.length === 1 ? b[0] : -1;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  /**
   * Stream the file in {@link CHUNK} windows with a `tail` overlap, exactly as
   * the Python locators do. `fn` receives the window plus the absolute file
   * offset of `data[0]`.
   */
  stream(tailSize: number, fn: (data: Buffer, dbase: number) => void): void {
    let base = 0;
    let tail = Buffer.alloc(0);
    for (;;) {
      const chunk = this.read(base, CHUNK);
      if (chunk.length === 0) return;
      const data = tail.length ? Buffer.concat([tail, chunk]) : Buffer.from(chunk);
      const dbase = base - tail.length;
      fn(data, dbase);
      tail = Buffer.from(data.subarray(Math.max(0, data.length - tailSize)));
      base = dbase + data.length;
    }
  }
}

/** Writer tag of a record (`TIFSDaemon`, ...), latin1 up to NUL. */
function tagOf(raw: Buffer): string {
  const slice = raw.subarray(REC_TAG, REC_TAG + 0x20);
  const nul = slice.indexOf(0);
  return (nul < 0 ? slice : slice.subarray(0, nul)).toString("latin1");
}

/** CRC/parity state of the record at file offset `rec`, `null` on short read. */
export function recordState(reader: DumpReader, rec: number): RecordState | null {
  const raw = reader.read(rec, REC_SIZE);
  if (raw.length !== REC_SIZE) return null;
  const a = raw.subarray(REC_DATA_A, REC_DATA_A + LANE);
  const b = raw.subarray(REC_DATA_B, REC_DATA_B + LANE);
  const p = raw.subarray(REC_PARITY, REC_PARITY + LANE);
  let parity = true;
  for (let i = 0; i < LANE; i += 1) {
    if ((a[i] ^ b[i]) !== p[i]) {
      parity = false;
      break;
    }
  }
  return {
    crcA: u32(raw, REC_CRC_A) === crc32c(SEED, a),
    crcB: u32(raw, REC_CRC_B) === crc32c(SEED, b),
    crcP: u32(raw, REC_CRC_P) === crc32c(SEED, p),
    meta: u32(raw, REC_CRC_META) === crc32c(SEED, raw.subarray(REC_CRC_A, REC_CRC_META)),
    parity,
    span: u32(raw, REC_SPAN),
    seq: u32(raw, REC_SEQ),
    tag: tagOf(raw),
  };
}

/** True when every CRC and the XOR parity of the record verify. */
export function recordHealthy(st: RecordState | null): boolean {
  return st !== null && st.crcA && st.crcB && st.crcP && st.meta && st.parity;
}

/** Recompute the CRCs of a record whose data lanes were modified. */
export function fixRecordCrcs(
  rec: Uint8Array,
  dataAChanged: boolean,
  dataBChanged: boolean,
): void {
  if (dataAChanged) {
    put32(rec, REC_CRC_A, crc32c(SEED, rec.subarray(REC_DATA_A, REC_DATA_A + LANE)));
  }
  if (dataBChanged) {
    put32(rec, REC_CRC_B, crc32c(SEED, rec.subarray(REC_DATA_B, REC_DATA_B + LANE)));
  }
  if (dataAChanged || dataBChanged) {
    put32(rec, REC_CRC_P, crc32c(SEED, rec.subarray(REC_PARITY, REC_PARITY + LANE)));
    put32(
      rec,
      REC_CRC_META,
      crc32c(SEED, rec.subarray(REC_CRC_A, REC_CRC_META)),
    );
  }
}

/** True when the image window around `regionPos` carries every mask byte. */
function windowMatches(
  reader: DumpReader,
  regionPos: number,
  mask: ReadonlyMap<number, number>,
): boolean {
  const start = regionPos - (REGION_OFF - WIN_START);
  if (start < 0) return false;
  const win = reader.read(start, WIN_LEN);
  if (win.length !== WIN_LEN) return false;
  for (const [off, val] of mask) {
    if (win[off - WIN_START] !== val) return false;
  }
  return true;
}

/** Locator 1: the strict 5-byte anchor of the original generations. */
function scanAnchor(reader: DumpReader): Set<number> {
  const size = reader.size;
  const found = new Set<number>();
  reader.stream(64, (data, dbase) => {
    let pos = 0;
    for (;;) {
      const i = data.indexOf(ANCHOR, pos);
      if (i < 0) break;
      pos = i + 1;
      // image base = position of logical 0x3E60 minus its logical offset
      const head = dbase + i - ANCHOR_OFF;
      if (head < 0 || head + REGION_OFF + 1 > size) continue;
      found.add(head + REGION_OFF);
    }
  });
  return found;
}

/** Locator 2: the generation-tolerant window, seeded on its 0x3E6F marker. */
function scanTolerant(reader: DumpReader): Set<number> {
  const size = reader.size;
  const delta = SEED_OFF - REGION_OFF; // the seed sits this far after the region byte
  const found = new Set<number>();
  reader.stream(64, (data, dbase) => {
    let pos = 0;
    for (;;) {
      const i = data.indexOf(TOLERANT_SEED, pos);
      if (i < 0) break;
      pos = i + 1;
      const regionPos = dbase + i - delta;
      if (regionPos - (REGION_OFF - WIN_START) < 0) continue;
      if (regionPos + (WIN_LAST - REGION_OFF) + 1 > size) continue;
      found.add(regionPos);
    }
  });
  return found;
}

/**
 * True when `base` starts a journal array of one complete 64 KiB image.
 *
 * Records may be damaged (that is what the redundant copy and the rebuild path
 * are for), but the span map must be complete and at least 3/4 of the records
 * must still verify: 256 records whose spans cover 0x0000..0xFF00 exactly once
 * plus mostly valid CRC32C/parity data cannot occur by coincidence.
 */
function arrayValid(reader: DumpReader, base: number): boolean {
  const total = IMG_SIZE / SPAN_BYTES;
  const spans = new Set<number>();
  let valid = 0;
  for (let k = 0; k < total; k += 1) {
    const st = recordState(reader, base + k * REC_SIZE);
    if (st === null) return false;
    const span = st.span;
    if (span % SPAN_BYTES || span + SPAN_BYTES > IMG_SIZE || spans.has(span)) return false;
    spans.add(span);
    if (recordHealthy(st)) valid += 1;
  }
  return spans.size === total && valid * 4 >= total * 3;
}

/**
 * Locator 3: journal arrays recognised by structure alone (no fingerprint).
 *
 * Needed when the region-byte window itself is unreadable (damaged bytes or a
 * generation whose window is still unknown): the pool is intact, so the region
 * byte stays addressable through the record span map.
 */
function findArrays(reader: DumpReader, verbose: boolean, log: string[]): number[] {
  const size = reader.size;
  const arrayBytes = (IMG_SIZE / SPAN_BYTES) * REC_SIZE;
  const bases: number[] = [];
  reader.stream(REC_SIZE, (data, dbase) => {
    const last = data.length - REC_SPAN - 4;
    for (let i = 0; i <= last; i += REC_SIZE) {
      if (u32(data, i + REC_SPAN) !== 0) continue;
      // writer tag of the span-0 record: real pools always carry one,
      // zero-filled padding does not - and this rejects it in O(1)
      if (i + REC_TAG + 1 > data.length || data[i + REC_TAG] === 0) continue;
      const off = dbase + i;
      if (off < 0 || off % REC_SIZE || off + arrayBytes > size) continue;
      if (bases.includes(off) || !arrayValid(reader, off)) continue;
      bases.push(off);
      if (verbose) log.push(`    journal array at 0x${hex(off)} (structural)`);
    }
  });
  return [...new Set(bases)].sort((a, b) => a - b);
}

/**
 * True when a fingerprint hit sits in the derived tail of a journal record.
 *
 * A record stores its 256-byte image span in the data_a/data_b lanes; the XOR
 * parity lane and the CRC/sequence/tag area are derived and can coincidentally
 * repeat the fingerprint window. Such a hit must never be patched as if it were
 * the region byte.
 */
function derivedLaneArtifact(reader: DumpReader, regionPos: number): boolean {
  const rec = regionPos - (regionPos % REC_SIZE);
  if (regionPos - rec < LANE + LANE) return false; // real data lanes, keep it
  const st = recordState(reader, rec);
  if (st === null) return false;
  return st.span === (REGION_OFF & ~0xff) && recordHealthy(st);
}

/** Window matches either mask and is not a derived lane of a valid record. */
function fingerprintOk(reader: DumpReader, regionPos: number): boolean {
  if (derivedLaneArtifact(reader, regionPos)) return false;
  return windowMatches(reader, regionPos, MASK) || windowMatches(reader, regionPos, TOLERANT);
}

/** `0x3E65` — uppercase hex, the format the core's reports used. */
function hex(value: number): string {
  return value.toString(16).toUpperCase();
}

/**
 * File offsets of the region byte (logical 0x3E65) for every copy.
 *
 * Three complementary locators are unioned, most specific first; each copy is
 * reported exactly once (see the module docblock).
 */
export function findCandidates(
  reader: DumpReader,
  verbose = false,
  log: string[] = [],
): number[] {
  const hits = new Set<number>();
  for (const cand of scanAnchor(reader)) {
    if (!fingerprintOk(reader, cand)) continue;
    hits.add(cand);
    if (verbose) log.push(`    candidate at 0x${hex(cand)} (anchor fingerprint)`);
  }
  for (const cand of scanTolerant(reader)) {
    if (hits.has(cand)) continue;
    if (!fingerprintOk(reader, cand)) continue;
    hits.add(cand);
    if (verbose) log.push(`    candidate at 0x${hex(cand)} (tolerant fingerprint)`);
  }
  const span = REGION_OFF & ~0xff;
  for (const base of findArrays(reader, verbose, log)) {
    const cand = base + (span >> 8) * REC_SIZE + (REGION_OFF & 0xff);
    if (hits.has(cand)) continue;
    hits.add(cand);
    if (verbose) log.push(`    candidate at 0x${hex(cand)} (record span of array @0x${hex(base)})`);
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * Classify the copy owning `regionPos`: journal record or flat image.
 *
 * A journal record slot always starts at a 512-byte aligned offset
 * (`0x3E65 % 0x200` is fixed), but so may a flat image, therefore the slot
 * hypothesis is accepted only when the span field equals the region span and at
 * least one structural marker (XOR parity or a stored CRC) is still present.
 * That keeps damaged records discoverable (with a warning) without misreading
 * flat images.
 */
export function describeCopy(reader: DumpReader, regionPos: number): CopyInfo {
  const rec = regionPos - (REGION_OFF & 0xff);
  const st = rec >= REC_SIZE && rec % REC_SIZE === 0 ? recordState(reader, rec) : null;
  if (st !== null) {
    const crcsOk = st.crcA && st.crcB && st.crcP && st.meta;
    // span must match the region span and at least one structural marker
    // (XOR parity or any stored CRC) must still look like a record
    const slotOk =
      st.span === (REGION_OFF & ~0xff) && (st.parity || st.crcA || st.crcB || st.crcP || st.meta);
    if (slotOk) {
      return {
        kind: "record",
        valid: crcsOk && st.parity,
        regionPos,
        record: rec,
        arrayBase: rec - (st.span >> 8) * REC_SIZE,
        span: st.span,
        seq: st.seq,
        tag: st.tag,
        state: st,
        oldRegion: reader.byte(regionPos) < 0 ? null : reader.byte(regionPos),
      };
    }
  }
  const imageBase = regionPos - REGION_OFF;
  const img = reader.read(imageBase, IMG_SIZE);
  const info: CopyInfo = {
    kind: "image",
    regionPos,
    imageBase,
    oldRegion: img.length === IMG_SIZE ? img[REGION_OFF] : null,
    crcStored: 0,
    crcCalc: 0,
    crcOk: false,
  };
  if (img.length === IMG_SIZE) {
    const stored = u32(img, IMG_CRC_OFF);
    const calc = crc32c(SEED, img.subarray(0, IMG_CRC_OFF));
    info.crcStored = stored;
    info.crcCalc = calc;
    info.crcOk = stored === calc;
  }
  return info;
}

/** Rebuild the 64 KiB image from the 256 journal records of one array. */
export function assembleArray(reader: DumpReader, arrayBase: number): Buffer | null {
  const image = Buffer.alloc(IMG_SIZE);
  const seen: number[] = [];
  for (let k = 0; k < IMG_SIZE / SPAN_BYTES; k += 1) {
    const raw = reader.read(arrayBase + k * REC_SIZE, REC_SIZE);
    if (raw.length !== REC_SIZE) return null;
    const off = u32(raw, REC_SPAN);
    if (off + SPAN_BYTES > IMG_SIZE || off % SPAN_BYTES) return null;
    seen.push(off);
    raw.copy(image, off, REC_DATA_A, REC_DATA_A + LANE);
    raw.copy(image, off + LANE, REC_DATA_B, REC_DATA_B + LANE);
  }
  seen.sort((a, b) => a - b);
  for (let k = 0; k < seen.length; k += 1) {
    if (seen[k] !== k * SPAN_BYTES) return null;
  }
  return image;
}

/** Scan a dump and report every copy of the region byte. */
export function scanSamsung(inputPath: string, verbose = false): SamsungScanResult {
  const log: string[] = [];
  const reader = new DumpReader(inputPath);
  try {
    log.push("=== eeprom region scan ===");
    log.push(`input : ${inputPath} (${reader.size} bytes)`);
    const hits = findCandidates(reader, verbose, log);
    if (hits.length === 0) {
      log.push("ERROR: no eeprom region fingerprint found (unsupported dump?)");
      log.push("       tried: strict anchor, generation-tolerant window, journal-array structure");
      return { ok: false, copies: [], log };
    }
    const copies = hits.map(pos => describeCopy(reader, pos));
    log.push(`copies: ${copies.length}`);
    for (const inf of copies) {
      if (inf.kind === "record" && inf.state) {
        const st = inf.state;
        let icrc = "";
        const image = assembleArray(reader, inf.arrayBase ?? 0);
        if (image === null) {
          icrc = "assembled image INCOMPLETE";
        } else {
          const sc = u32(image, IMG_CRC_OFF);
          const cc = crc32c(SEED, image.subarray(0, IMG_CRC_OFF));
          icrc = `img_crc stored=0x${sc.toString(16).toUpperCase().padStart(8, "0")} ` +
            `calc=0x${cc.toString(16).toUpperCase().padStart(8, "0")} ${sc === cc ? "OK" : "STALE"}`;
        }
        if (!inf.valid) icrc += "   WARNING: damaged record, CRCs will be rebuilt";
        const regionHex = `0x${((inf.oldRegion ?? 0) & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
        log.push(
          `  record@0x${hex(inf.record ?? 0)} array_base=0x${hex(inf.arrayBase ?? 0)} ` +
            `span=0x${(inf.span ?? 0).toString(16).toUpperCase().padStart(4, "0")} ` +
            `seq=0x${(inf.seq ?? 0).toString(16).toUpperCase().padStart(5, "0")} ` +
            `tag=${(inf.tag ?? "").padEnd(14)} region=${regionHex}  ` +
            `rec_crc=${st.crcA && st.crcB ? "OK" : "BAD"} ` +
            `parity=${st.parity ? "OK" : "BAD"} meta=${st.meta ? "OK" : "BAD"}  ${icrc}`,
        );
      } else {
        const old =
          inf.oldRegion === null || inf.oldRegion === undefined
            ? "??"
            : `0x${inf.oldRegion.toString(16).toUpperCase().padStart(2, "0")}`;
        // У дампа микросхемы 24C512 поле в конце образа стерто (0xFFFFFFFF) — это
        // норма, поэтому вместо «MISMATCH» пишем, что суммы в дампе нет вовсе.
        const stored = inf.crcStored ?? 0;
        const crcTxt =
          stored === ERASED_CRC
            ? "img_crc none in this dump (field is empty)"
            : `img_crc stored=0x${stored.toString(16).toUpperCase().padStart(8, "0")} ` +
              `calc=0x${(inf.crcCalc ?? 0).toString(16).toUpperCase().padStart(8, "0")} ` +
              `${inf.crcOk ? "OK" : "MISMATCH"}`;
        log.push(
          `  image @0x${hex(inf.regionPos)} image_base=0x${hex(inf.imageBase ?? 0)} ` +
            `region=${old}  ${crcTxt}`,
        );
      }
    }
    return { ok: true, copies, log };
  } finally {
    reader.close();
  }
}

/** Little-endian u32 as a 4-byte buffer (payload of one edit). */
function le32(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  put32(b, 0, value >>> 0);
  return b;
}

/** Apply `mutate` to a copy of the record and return the changed bytes. */
function recordEdits(
  reader: DumpReader,
  rec: number,
  mutate: (buf: Buffer) => void,
): Map<number, Buffer> {
  const old = reader.read(rec, REC_SIZE);
  const next = Buffer.from(old);
  mutate(next);
  const edits = new Map<number, Buffer>();
  for (let i = 0; i < old.length; i += 1) {
    if (next[i] !== old[i]) edits.set(rec + i, Buffer.from([next[i]]));
  }
  return edits;
}

/** Copy the edits whose offsets fall inside `chunk` onto it (in place). */
function applyEdits(chunk: Buffer, chunkBase: number, edits: Map<number, Buffer>): void {
  for (const [eoff, payload] of edits) {
    if (eoff >= chunkBase && eoff < chunkBase + chunk.length) {
      payload.copy(chunk, eoff - chunkBase);
    }
  }
}

/**
 * Re-read the patched file and check every copy.
 *
 * Reads the WRITTEN file (not the input): assembling the image from the input
 * would "verify" the pre-patch bytes and report a false failure.
 */
function verifyPatched(
  target: string,
  region: number,
  expectCrc: Set<number>,
  log: string[],
): { ok: boolean; stale: number; copies: CopyInfo[] } {
  const verified = scanSamsung(target);
  const reader = new DumpReader(target);
  let ok = true;
  let stale = 0;
  try {
    for (const inf of verified.copies) {
      if (inf.kind !== "record") {
        const good = inf.oldRegion === region;
        const crcOk = inf.crcOk === true;
        const want = expectCrc.has(inf.imageBase ?? 0);
        // Стертое поле (0xFFFFFFFF) = «суммы в этом дампе нет» — так выглядит
        // микросхема 24C512. Это не «left as is» и не повод считать её stale.
        const erased = (inf.crcStored ?? 0) === ERASED_CRC;
        const crcTxt = want
          ? crcOk
            ? "OK"
            : "MISMATCH"
          : erased
            ? "none in this dump"
            : crcOk
              ? "OK"
              : "left as is";
        if (!want && !crcOk && !erased) stale += 1;
        log.push(
          `  image @0x${hex(inf.regionPos)} = 0x${byteHex(inf.oldRegion)} ` +
            `${good ? "OK" : "FAIL"}   image_crc ${crcTxt}`,
        );
        ok = ok && good && (crcOk || !want);
        continue;
      }
      const recOk = recordHealthy(inf.state ?? null);
      const image = assembleArray(reader, inf.arrayBase ?? 0);
      let imgOk = image !== null && image[REGION_OFF] === region;
      const want = expectCrc.has(inf.arrayBase ?? 0);
      let crcTxt = "";
      if (want) {
        if (image === null) {
          imgOk = false;
          crcTxt = " + image_crc FAIL(no image)";
        } else {
          const crcOk = u32(image, IMG_CRC_OFF) === crc32c(SEED, image.subarray(0, IMG_CRC_OFF));
          imgOk = imgOk && crcOk;
          crcTxt = ` + image_crc ${crcOk ? "OK" : "MISMATCH"}`;
        }
      }
      log.push(
        `  record@0x${hex(inf.record ?? 0)} = 0x${byteHex(inf.oldRegion)} ` +
          `${inf.oldRegion === region ? "OK" : "FAIL"}   ` +
          `rec_crc ${recOk ? "OK" : "MISMATCH"}   ` +
          `assembled_image ${imgOk ? "region OK" : "FAIL/incomplete"}${crcTxt}`,
      );
      ok = ok && inf.oldRegion === region && recOk && imgOk;
    }
  } finally {
    reader.close();
  }
  return { ok, stale, copies: verified.copies };
}

/** Two-digit uppercase hex of a byte (`??` when unknown). */
function byteHex(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "??"
    : value.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Patch the region byte in every copy of the eeprom image.
 *
 * The input file is read only; the patch goes to `outputPath` unless `inPlace`
 * is set. Verification re-scans the WRITTEN file, so `rc === 0` means "the
 * patched file was re-read and every copy verifies", not merely "the write did
 * not throw".
 */
export function patchSamsung(opts: SamsungPatchOptions): SamsungPatchResult {
  const log: string[] = [];
  const imageCrc: ImageCrcMode = opts.imageCrc ?? "auto";
  const region = opts.region & 0xff;
  const verbose = opts.verbose === true;
  const checkOnly = opts.checkOnly === true;
  const inPlace = opts.inPlace === true;

  const fail = (rc: number): SamsungPatchResult => ({
    rc,
    ok: false,
    copies: [],
    log,
    target: null,
    changedBytes: 0,
    changedPlaces: 0,
    staleImageCrc: 0,
  });

  if (!fs.existsSync(opts.inputPath)) {
    log.push(`ERROR: no such file: ${opts.inputPath}`);
    return fail(1);
  }
  log.push(
    `region value : 0x${region.toString(16).toUpperCase().padStart(2, "0")}   image crc mode: ${imageCrc}`,
  );

  const initial = scanSamsung(opts.inputPath, verbose);
  log.push(...initial.log);
  if (!initial.ok || initial.copies.length === 0) return fail(2);

  // Gate point: the caller decides paid / free here, BEFORE the check-only
  // answer and before any write. A throw from the hook leaves the input and the
  // target untouched (no output file is created).
  opts.onCopies?.(initial.copies);

  if (checkOnly) {
    log.push("check-only mode: nothing written");
    return {
      rc: 0,
      ok: true,
      copies: initial.copies,
      log,
      target: null,
      changedBytes: 0,
      changedPlaces: 0,
      staleImageCrc: 0,
    };
  }

  const target = inPlace ? opts.inputPath : opts.outputPath ?? `${opts.inputPath}.patched`;
  if (!inPlace) log.push(`writing patched copy -> ${target}`);

  const reader = new DumpReader(opts.inputPath);
  try {
    const edits = new Map<number, Buffer>();
    // image bases / array bases whose 0xFFFC must verify afterwards
    const expectCrc = new Set<number>();
    // healthy records indexed by span: used to rebuild a damaged record from
    // the redundant copy of the journal array (that is why the copy exists)
    const donors = new Map<number, CopyInfo>();
    for (const inf of initial.copies) {
      const span = inf.span ?? 0;
      if (inf.kind === "record" && inf.valid && !donors.has(span)) donors.set(span, inf);
    }

    for (const inf of initial.copies) {
      const rp = inf.regionPos;
      if (inf.kind === "record") {
        const rec = inf.record ?? 0;
        const pos = REGION_OFF & 0xff;
        const donor = inf.valid ? undefined : donors.get(inf.span ?? 0);
        if (!inf.valid) {
          if (donor) {
            log.push(
              `  record@0x${hex(rec)}: broken CRCs/parity, rebuilding data lanes ` +
                `from the redundant copy @0x${hex(donor.record ?? 0)}`,
            );
          } else {
            log.push(
              `  WARNING: record@0x${hex(rec)} has broken CRCs/parity and no healthy ` +
                `copy - parity/CRCs will be regenerated around the stored bytes`,
            );
          }
        }
        const donorRec = donor ? donor.record ?? -1 : -1;

        const mutateRegion = (rb: Buffer): void => {
          if (donorRec >= 0) {
            const src = reader.read(donorRec, REC_SIZE);
            src.copy(rb, REC_DATA_A, REC_DATA_A, REC_DATA_A + LANE);
            src.copy(rb, REC_DATA_B, REC_DATA_B, REC_DATA_B + LANE);
            rb[REC_DATA_A + pos] = region;
            // regenerate the whole parity lane: it is derived, not stored twice
            for (let i = 0; i < LANE; i += 1) {
              rb[REC_PARITY + i] = rb[REC_DATA_A + i] ^ rb[REC_DATA_B + i];
            }
            fixRecordCrcs(rb, true, true);
          } else {
            rb[REC_DATA_A + pos] = region;
            rb[REC_PARITY + pos] = rb[REC_DATA_A + pos] ^ rb[REC_DATA_B + pos];
            fixRecordCrcs(rb, true, false);
          }
        };

        const sub = recordEdits(reader, rec, mutateRegion);
        for (const [off, payload] of sub) edits.set(off, payload);
        const spanTxt = (inf.span ?? 0).toString(16).toUpperCase().padStart(4, "0");
        log.push(
          `  record@0x${hex(rec)} (span 0x${spanTxt}, tag ${inf.tag ?? ""}): ` +
            `${sub.size} bytes changed (region + parity + CRC a/parity/meta)`,
        );

        if (imageCrc === "never") continue;
        const arr = inf.arrayBase ?? 0;
        const image = assembleArray(reader, arr);
        if (image === null) {
          log.push(`    image crc: journal array at 0x${hex(arr)} incomplete, skipped`);
          continue;
        }
        const newImg = Buffer.from(image);
        newImg[REGION_OFF] = region;
        const newCrc = crc32c(SEED, newImg.subarray(0, IMG_CRC_OFF));
        const cur = u32(image, IMG_CRC_OFF);
        const curOk = cur === crc32c(SEED, image.subarray(0, IMG_CRC_OFF));
        if (!(imageCrc === "always" || curOk)) {
          log.push(
            `    image crc left as is: stale 0x${cur.toString(16).toUpperCase().padStart(8, "0")} ` +
              `(not a CRC32C of the assembled image), use image crc "always" to refresh`,
          );
          continue;
        }
        const irec = arr + Math.floor(IMG_CRC_OFF / SPAN_BYTES) * REC_SIZE;
        const laneOff = (IMG_CRC_OFF % SPAN_BYTES) - LANE; // 0xFC -> 0x7C (data_b)
        if (laneOff < 0) throw new Error("image checksum is expected in the data_b lane");

        const mutateImgCrc = (rb: Buffer): void => {
          put32(rb, REC_DATA_B + laneOff, newCrc);
          put32(rb, REC_PARITY + laneOff, u32(rb, REC_DATA_A + laneOff) ^ newCrc);
          fixRecordCrcs(rb, false, true);
        };

        const subCrc = recordEdits(reader, irec, mutateImgCrc);
        for (const [off, payload] of subCrc) edits.set(off, payload);
        expectCrc.add(arr);
        log.push(
          `    image crc 0x${cur.toString(16).toUpperCase().padStart(8, "0")} -> ` +
            `0x${newCrc.toString(16).toUpperCase().padStart(8, "0")} ` +
            `in record@0x${hex(irec)} (${subCrc.size} bytes changed)`,
        );
      } else {
        const imageBase = inf.imageBase ?? 0;
        const stored = inf.crcStored ?? 0;
        // Микросхема NVM 24C512 хранит образ без контрольной суммы: поле 0xFFFC
        // стерто (0xFFFFFFFF). Это НЕ «застарелая сумма» и не повод что-то
        // «лечить» — просто пишем байт региона и оставляем поле как есть (auto).
        const erased = stored === ERASED_CRC;
        let note = "image crc untouched";
        if (imageCrc !== "never" && (inf.crcOk || imageCrc === "always")) {
          const img = Buffer.from(reader.read(imageBase, IMG_SIZE));
          img[REGION_OFF] = region;
          const newCrc = crc32c(SEED, img.subarray(0, IMG_CRC_OFF));
          // Правка добавляется только если значение реально меняется: иначе
          // повторный патч рапортовал «1 изменённый байт» там, где менять нечего.
          if (newCrc !== stored) edits.set(imageBase + IMG_CRC_OFF, le32(newCrc));
          note =
            `image crc 0x${stored.toString(16).toUpperCase().padStart(8, "0")} -> ` +
            `0x${newCrc.toString(16).toUpperCase().padStart(8, "0")}`;
          expectCrc.add(imageBase);
        } else if (imageCrc !== "never") {
          if (erased) {
            note = "no image checksum in this dump - only the region byte is written";
          } else {
            note = "image crc INVALID/left as is";
            log.push(
              `    WARNING: image checksum 0x${stored.toString(16).toUpperCase().padStart(8, "0")} ` +
                `does not match this image; left as is ` +
                `(rerun with image crc "always" to repair)`,
            );
          }
        }
        if (inf.oldRegion !== region) edits.set(rp, Buffer.from([region]));
        log.push(
          `  region byte @0x${hex(rp)} (image @0x${hex(imageBase)}): ` +
            `0x${byteHex(inf.oldRegion)} -> 0x${byteHex(region)}, ${note}`,
        );
      }
    }

    // streamed write: the dump may be several GiB, so it is never loaded whole
    const src = fs.openSync(opts.inputPath, "r");
    const dst = fs.openSync(target, "w");
    try {
      let off = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(CHUNK);
        const got = fs.readSync(src, buf, 0, CHUNK, off);
        if (got === 0) break;
        const chunk = buf.subarray(0, got);
        applyEdits(chunk, off, edits);
        fs.writeSync(dst, chunk, 0, chunk.length);
        off += got;
      }
    } finally {
      fs.closeSync(src);
      fs.closeSync(dst);
    }

    let nbytes = 0;
    for (const payload of edits.values()) nbytes += payload.length;
    log.push(`--- verification of ${target} (${nbytes} bytes changed in ${edits.size} places) ---`);

    const verified = verifyPatched(target, region, expectCrc, log);
    const ok = verified.ok;
    const stale = verified.stale;

    const result: SamsungPatchResult = {
      rc: ok ? 0 : 2,
      ok,
      copies: verified.copies,
      log,
      target,
      changedBytes: nbytes,
      changedPlaces: edits.size,
      staleImageCrc: stale,
    };
    if (ok && stale > 0) {
      log.push(
        `result: OK (region patched in every copy; ${stale} flat-image checksum(s) left ` +
          `stale as is - rerun with image crc "always" to repair them)`,
      );
    } else {
      log.push(`result: ${ok ? "OK" : "FAILED"}`);
    }
    return result;
  } finally {
    reader.close();
  }
}

