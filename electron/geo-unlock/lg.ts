/**
 * LG NVM (24C256 EEPROM) "Area Option" — headless core.
 *
 * Port of the upstream headless core `tools/lg_nvm_core.py` from the GEO_Unlock
 * project (`/home/mega/Project/samsung_region`). The Tkinter front-end is not
 * ported; the Electron main process calls {@link scanLg} / {@link patchLg}.
 *
 * The LG "region" is the Area Option value packed as
 *
 *     area = continentIdx | (languageCountry << 7) | (hwSettingGroup << 12)
 *
 * and stored little-endian in the NVM image. Two layouts are known from the
 * field: `0x04FC` "Standard" (43LR60006LA) and `0x1C58` "LG_NEW_Reg" (older
 * models). Instead of trusting those addresses, {@link scanLg} looks for every
 * u16 that decodes to a plausible Area Option and scores it (field ranges,
 * layout hint, country string in the same dump, position inside a config
 * block). {@link patchLg} then rewrites the best candidate (or an explicitly
 * requested offset) little-endian and NEVER touches the input file.
 *
 * Exit-code contract of the original CLI: 0 ok, 1 error, 2 nothing found.
 */
import * as fs from "node:fs";

/** 24C256 = 32 KiB. */
export const LG_IMG_SIZE = 0x8000;
/** The Area Option is a little-endian u16. */
export const AREA_LEN = 2;

/** `languageCountry` -> region code (from the Area Option tables). */
const LANG_COUNTRY = new Map<number, string>([
  [0, "NORDIC"],
  [1, "NON NORDIC"],
  [2, "EAST EU"],
  [3, "WEST EU"],
  [4, "ETC EU"],
  [5, "AJ"],
  [6, "JA"],
  [7, "IL"],
  [8, "TW"],
  [9, "CO"],
  [10, "PA"],
  [11, "CN"],
  [12, "HK"],
  [13, "KR"],
  [14, "US"],
  [15, "CA"],
  [16, "MX"],
  [17, "HN"],
  [18, "BR"],
  [19, "CL"],
  [20, "PE"],
  [21, "AR"],
  [22, "EC"],
  [23, "JP"],
  [24, "EU"],
  [25, "IR"],
  [26, "PH"],
  [27, "BW"],
  [28, "CS"],
]);
const MAX_LANG = 28;

/** `hwSettingGroup` -> hardware group. */
const HW_GROUP = new Map<number, string>([
  [0, "EU"],
  [1, "AJ JA IL"],
  [2, "TW CO"],
  [3, "CN HK"],
  [4, "KR"],
  [5, "US"],
  [6, "SA"],
  [7, "JP"],
]);
const MAX_HW = 7;

/**
 * Layout hints observed in the field (`offset` -> label). Kept as a scoring
 * bonus only — the scanner does not depend on them.
 */
const LAYOUT_HINTS = new Map<number, string>([
  [0x04fc, "Standard"],
  [0x1c58, "LG_NEW_Reg (old models)"],
]);

/** Country / area tokens that show up next to the Area Option value. */
const COUNTRY_HINTS = [
  "POL", "GBR", "DEU", "FRA", "ITA", "ESP", "NLD", "BEL", "CZE", "SVK",
  "HUN", "ROU", "BGR", "HRV", "SRB", "SWE", "NOR", "DNK", "FIN", "GRC",
  "PRT", "TUR", "RUS", "UKR", "KAZ", "USA", "CAN", "MEX", "BRA", "ARG",
  "CHL", "PER", "JPN", "KOR", "CHN", "TWN", "HKG", "AUS", "NZL", "IND",
  "EU", "CIS",
];

/** No Area Option candidate matched the request. */
export class AreaNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AreaNotFound";
  }
}

/** The image does not look like an LG NVM/EEPROM dump. */
export class NotLgNvm extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotLgNvm";
  }
}

/** One plausible Area Option location inside the image. */
export interface LgCandidate {
  offset: number;
  value: number;
  score: number;
  lang: number;
  hw: number;
  country: string;
  notes: string[];
}

/** Result of {@link scanLg}. */
export interface LgScanResult {
  /** `true` when at least one candidate was found. */
  ok: boolean;
  /** `false` for a file that is not a 32 KiB LG NVM dump. */
  looksLikeLgNvm: boolean;
  candidates: LgCandidate[];
  /** Human-readable report lines (English, per repository log conventions). */
  log: string[];
  /** Exit code of the original core: 0 ok, 1 error, 2 nothing found. */
  rc: number;
}

/** Result of {@link patchLg}. */
export interface LgPatchResult {
  ok: boolean;
  offset: number;
  oldValue: number;
  newValue: number;
  lang: number;
  hw: number;
  country: string;
  /** Written file (`null` for a dry run). */
  target: string | null;
  log: string[];
}

/** Split a packed Area Option into `[continentIdx, languageCountry, hw]`. */
export function decode(value: number): [number, number, number] {
  return [value & 0x7f, (value >> 7) & 0x1f, (value >> 12) & 0xf];
}

/** Pack Area Option fields into one integer. */
export function encode(continentIdx: number, lang: number, hw: number): number {
  return ((continentIdx & 0x7f) | ((lang & 0x1f) << 7) | ((hw & 0xf) << 12)) >>> 0;
}

/** First/last Area Option value of the 128-wide block of one language. */
export function regionRange(lang: number): [number, number] {
  const base = (lang & 0x1f) << 7;
  return [base, base + 127];
}

/** A LG NVM block header: `[id, len, kind, 0x20]`, kind in 0x19/0x20/0x22. */
function looksLikeBlock(data: Buffer, off: number): boolean {
  if (off < 0 || off + 4 > data.length) return false;
  return (
    (data[off + 2] === 0x19 || data[off + 2] === 0x20 || data[off + 2] === 0x22) &&
    data[off + 3] === 0x20 &&
    data[off + 1] > 0 &&
    data[off] !== 0x00 &&
    data[off] !== 0xff
  );
}

/** Offsets of block headers (see {@link looksLikeBlock}). */
function blockOffsets(data: Buffer): number[] {
  const out: number[] = [];
  for (let off = 0; off < data.length - 4; off += 1) {
    if (looksLikeBlock(data, off)) out.push(off);
  }
  return out;
}

/** The first country/area token found as an ASCII string ("" when none). */
export function findCountry(data: Buffer): string {
  for (const tok of COUNTRY_HINTS) {
    const pat = Buffer.from(tok, "latin1");
    const withNul = data.indexOf(Buffer.concat([pat, Buffer.from([0])]));
    const withSpaces = data.indexOf(Buffer.concat([Buffer.from(" "), pat, Buffer.from(" ")]));
    if (withNul >= 0 || withSpaces >= 0) return tok;
  }
  return "";
}

/** Confidence score of one Area Option candidate. */
function scoreCandidate(
  off: number,
  value: number,
  country: string,
  block: boolean,
): { score: number; notes: string[] } {
  const [, lang, hw] = decode(value);
  let score = 0;
  const notes: string[] = [];
  if (off % 4 === 0) {
    score += 3;
    notes.push("4-byte aligned");
  }
  const hint = LAYOUT_HINTS.get(off);
  if (hint !== undefined) {
    score += 4;
    notes.push(`layout hint: ${hint}`);
  }
  if (country) {
    score += 3;
    notes.push(`country ${country}`);
  }
  if (block) {
    score += 2;
    notes.push("inside a NVM block");
  }
  if (lang === 24 && hw === 0) {
    score += 2;
    notes.push("EU group");
  }
  if (HW_GROUP.has(hw)) score += 1;
  const [lo, hi] = regionRange(lang);
  if (lo <= value && value <= hi) score += 1;
  return { score, notes };
}

/**
 * Every plausible Area Option candidate, best first.
 *
 * A candidate is any even-aligned u16 that decodes to a plausible field
 * combination (`languageCountry <= 28`, `hwSettingGroup <= 7`).
 */
export function scanCandidates(data: Buffer): LgCandidate[] {
  if (data.length === 0) return [];
  const country = findCountry(data);
  const blocks = new Set(blockOffsets(data));
  const candidates: LgCandidate[] = [];
  for (let off = 0; off < data.length - 1; off += AREA_LEN) {
    if (data[off] === 0xff && data[off + 1] === 0xff) continue;
    if (data[off] === 0x00 && data[off + 1] === 0x00) continue;
    const value = data[off] | (data[off + 1] << 8);
    const [, lang, hw] = decode(value);
    if (lang > MAX_LANG || hw > MAX_HW) continue;
    let inside = false;
    for (const b of blocks) {
      if (b <= off && off < b + 4) {
        inside = true;
        break;
      }
    }
    const { score, notes } = scoreCandidate(off, value, country, inside);
    candidates.push({ offset: off, value, score, lang, hw, country, notes });
  }
  candidates.sort((a, b) => b.score - a.score || a.offset - b.offset);
  return candidates;
}

/**
 * Heuristic: does the image look like an LG NVM dump?
 *
 * Requires the 32 KiB 24C256 size, at least three block headers and at least
 * one Area Option candidate that also carries a country string.
 */
export function isLgNvm(data: Buffer): boolean {
  if (data.length !== LG_IMG_SIZE) return false;
  let blocks = 0;
  for (let off = 0; off < data.length - 4; off += 1) {
    if (looksLikeBlock(data, off)) blocks += 1;
    if (blocks >= 3) break;
  }
  if (blocks < 3) return false;
  return scanCandidates(data).some(c => c.country !== "");
}

/** Human-readable one-line description of a candidate. */
export function candidateLabel(c: LgCandidate): string {
  const h = (v: number, pad: number): string => v.toString(16).toUpperCase().padStart(pad, "0");
  return (
    `0x${h(c.offset, 4)} = ${c.value} (0x${h(c.value, 4)}) ci=${c.value & 0x7f} ` +
    `lang=${c.lang}/${LANG_COUNTRY.get(c.lang) ?? "?"} ` +
    `hw=${c.hw}/${HW_GROUP.get(c.hw) ?? "?"}` +
    (c.country ? `  [${c.country}]` : "")
  );
}

/** Scan an LG NVM dump and build the CLI-style report. */
export function scanLg(inputPath: string): LgScanResult {
  const log: string[] = [];
  let data: Buffer;
  try {
    data = fs.readFileSync(inputPath);
  } catch (err) {
    log.push(`ERROR: ${(err as Error).message}`);
    return { ok: false, looksLikeLgNvm: false, candidates: [], log, rc: 1 };
  }
  log.push("=== LG NVM area scan ===");
  log.push(`input : ${inputPath} (${data.length} bytes)`);
  const looksLike = isLgNvm(data);
  if (!looksLike) {
    log.push("WARNING: image does not look like an LG NVM dump (expected 32 KiB with NVM blocks)");
  }
  const candidates = scanCandidates(data);
  if (candidates.length === 0) {
    log.push("no Area Option candidate found");
    return { ok: false, looksLikeLgNvm: looksLike, candidates, log, rc: 2 };
  }
  log.push(`candidates: ${candidates.length} (best first)`);
  for (const c of candidates.slice(0, 10)) {
    log.push(`  ${candidateLabel(c)}   score=${c.score} ${c.notes.join("; ")}`);
  }
  return { ok: true, looksLikeLgNvm: looksLike, candidates, log, rc: 0 };
}

/** Options of {@link patchLg}. */
export interface LgPatchOptions {
  inputPath: string;
  /** Output file; default `<input>.patched.BIN`. */
  outputPath?: string;
  /** Target Area Option value. */
  newValue: number;
  /** Expected current value (auto-detected best candidate when omitted). */
  oldValue?: number;
  /** Explicit byte offset (auto-detected when omitted). */
  offset?: number;
  /** Report only, write nothing. */
  dryRun?: boolean;
}

/**
 * Auto-patch the Area Option, writing a NEW file.
 *
 * @throws {NotLgNvm} the image does not look like an LG NVM dump
 * @throws {AreaNotFound} no candidate, or the requested old value / offset is wrong
 */
export function patchLg(opts: LgPatchOptions): LgPatchResult {
  const log: string[] = [];
  const data = Buffer.from(fs.readFileSync(opts.inputPath));
  if (!isLgNvm(data)) {
    throw new NotLgNvm(`${opts.inputPath} does not look like an LG NVM dump`);
  }
  const candidates = scanCandidates(data);
  if (candidates.length === 0) {
    throw new AreaNotFound(`no Area Option candidate in ${opts.inputPath}`);
  }
  let pick: LgCandidate;
  if (opts.offset === undefined) {
    if (opts.oldValue === undefined) {
      pick = candidates[0];
    } else {
      const matches = candidates.filter(c => c.value === opts.oldValue);
      if (matches.length === 0) {
        throw new AreaNotFound(`old area ${opts.oldValue} not found in ${opts.inputPath}`);
      }
      pick = matches[0];
    }
  } else {
    const off = opts.offset;
    if (off % AREA_LEN !== 0 || off + AREA_LEN > data.length) {
      throw new AreaNotFound(
        `bad offset 0x${off.toString(16).toUpperCase()} for ${opts.inputPath}`,
      );
    }
    const value = data[off] | (data[off + 1] << 8);
    // NOTE: the original core assigns `lang, hw, _ = decode(value)` here, which
    // shifts the fields by one. Kept 1:1 so the report matches the old CLI.
    const [ci, lang] = decode(value);
    pick = { offset: off, value, score: 0, lang: ci, hw: lang, country: "", notes: [] };
  }
  if (opts.oldValue !== undefined && pick.value !== opts.oldValue) {
    throw new AreaNotFound(
      `old area ${opts.oldValue} not at 0x${pick.offset.toString(16).toUpperCase()} ` +
        `(found ${pick.value})`,
    );
  }
  const hx4 = (v: number): string => v.toString(16).toUpperCase().padStart(4, "0");
  if (pick.country) log.push(`country hint : ${pick.country}`);
  log.push(
    `  @0x${hx4(pick.offset)}: ${pick.value} -> ${opts.newValue} (LE ` +
      `${hx4(pick.value & 0xffff)} -> ${hx4(opts.newValue & 0xffff)})`,
  );
  const target =
    opts.outputPath && opts.outputPath !== "" ? opts.outputPath : `${opts.inputPath}.patched.BIN`;
  if (opts.dryRun === true) {
    log.push("dry run: no file written");
  } else {
    data[pick.offset] = opts.newValue & 0xff;
    data[pick.offset + 1] = (opts.newValue >>> 8) & 0xff;
    fs.writeFileSync(target, data);
    log.push(`wrote ${target}`);
  }
  return {
    ok: true,
    offset: pick.offset,
    oldValue: pick.value,
    newValue: opts.newValue,
    lang: pick.lang,
    hw: pick.hw,
    country: pick.country,
    target: opts.dryRun === true ? null : target,
    log,
  };
}
