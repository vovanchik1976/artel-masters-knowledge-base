/**
 * GEO_Unlock — headless cores for the desktop client "TOOLS" tab.
 *
 * Two independent tools, both pure Node (no Python runtime, no native addons,
 * nothing that breaks the Win7/8 import gate):
 *
 *   * `samsung` — Tizen eeprom "region" byte at logical 0x3E65, patched in every
 *     redundant copy together with its parity byte and CRC32C;
 *   * `lg` — LG NVM (24C256) "Area Option" (country/region), located by an
 *     auto-scan instead of a hard-coded address.
 *
 * Both cores are 1:1 ports of the upstream standalone tools
 * (`eeprom_region_patch.py` / `lg_nvm_core.py`), which stay the authority for
 * the byte layout. The renderer never touches the filesystem: the main process
 * calls these functions and returns the structured report + log lines.
 */
export {
  AREA_LEN,
  AreaNotFound,
  LG_IMG_SIZE,
  NotLgNvm,
  candidateLabel,
  decode,
  encode,
  findCountry,
  isLgNvm,
  patchLg,
  regionRange,
  scanCandidates,
  scanLg,
} from "./lg";
export type { LgCandidate, LgPatchOptions, LgPatchResult, LgScanResult } from "./lg";

export {
  DumpReader,
  ERASED_CRC,
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
  assembleArray,
  describeCopy,
  findCandidates,
  fixRecordCrcs,
  patchSamsung,
  recordHealthy,
  recordState,
  scanSamsung,
} from "./samsung";
export type {
  CopyInfo,
  ImageCrcMode,
  RecordState,
  SamsungPatchOptions,
  SamsungPatchResult,
  SamsungScanResult,
} from "./samsung";

export { crc32c, put32, u32 } from "./crc32c";
