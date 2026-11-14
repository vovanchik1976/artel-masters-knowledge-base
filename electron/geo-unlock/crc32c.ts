/**
 * CRC32C (Castagnoli, reflected) exactly as the Tizen `tztv-eeprom` driver
 * computes it: a seeded table CRC with no final xor.
 *
 * This is a 1:1 port of `crc32c()` from the upstream headless core
 * (`tools/eeprom_region_patch.py`), which is the authority for the checksum
 * the TV firmware verifies. Any change here breaks the whole GEO_Unlock
 * feature, therefore the implementation is covered by byte-level tests
 * (`tests/geo-unlock-crc.test.ts`) that pin known vectors.
 */

/** 256-entry reflection table for the Castagnoli polynomial 0x1EDC6F41. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      // 0x82F63B78 is the reflected form of the Castagnoli polynomial.
      c = c & 1 ? ((c >>> 1) ^ 0x82f63b78) >>> 0 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Seeded CRC32C.
 *
 * @param seed initial crc value (the eeprom driver uses `0xAA55AA55`)
 * @param data bytes to digest
 * @returns unsigned 32-bit checksum
 */
export function crc32c(seed: number, data: Uint8Array): number {
  let crc = seed >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    crc = ((crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/** Little-endian unsigned 32-bit read at `off`. */
export function u32(buf: Uint8Array, off: number): number {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

/** Little-endian unsigned 32-bit write at `off`. */
export function put32(buf: Uint8Array, off: number, value: number): void {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >>> 8) & 0xff;
  buf[off + 2] = (value >>> 16) & 0xff;
  buf[off + 3] = (value >>> 24) & 0xff;
}
