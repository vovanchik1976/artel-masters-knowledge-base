/**
 * DownloadAction — «Оставить архивом» (keep-packed, V3-добор).
 *
 * Тестируем decision-матрицу после склейки:
 *  - container из манифеста имеет приоритет; без него — magic (байты весомее имени);
 *  - zip/tar.zst + чекбокс OFF → unpack (дефолт, паритет UI-007);
 *  - zip/tar.zst + чекбокс ON → keep_archive;
 *  - чужое/сырое → keep_file при любом чекбоксе (распаковки нет).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  containerExtension,
  decideDownloadAction,
  detectDownloadContainer,
  expectedContainerName,
  keepPackedChoice,
} from "../src/ui/DownloadAction";

test("detect: container из манифеста — приоритет над всем", () => {
  assert.equal(
    detectDownloadContainer({ manifestContainer: "tar_zst", fileName: "x.zip", header: [0x50, 0x4b, 0x03, 0x04] }),
    "tar_zst",
  );
  assert.equal(
    detectDownloadContainer({ manifestContainer: "zip", fileName: "x.bin", header: [0x00] }),
    "zip",
  );
});

test("detect: без манифеста — zip-magic → zip", () => {
  assert.equal(
    detectDownloadContainer({ fileName: "file_512", header: [0x50, 0x4b, 0x03, 0x04] }),
    "zip",
  );
});

test("detect: без манифеста — zstd-magic → tar_zst", () => {
  assert.equal(
    detectDownloadContainer({ fileName: "file_512", header: [0x28, 0xb5, 0x2f, 0xfd] }),
    "tar_zst",
  );
});

test("detect: архивное имя + чужой magic → foreign (fail-closed)", () => {
  assert.equal(
    detectDownloadContainer({ fileName: "dump.zip", header: [0x00, 0x11, 0x22] }),
    "foreign",
  );
  assert.equal(
    detectDownloadContainer({ fileName: "x.tar.zst", header: [] }),
    "foreign",
  );
});

test("detect: сырое имя + сырые байты → plain", () => {
  assert.equal(
    detectDownloadContainer({ fileName: "dump.bin", header: [0x00, 0x11] }),
    "plain",
  );
});

test("decide: наш контейнер + OFF → unpack (дефолт)", () => {
  assert.equal(decideDownloadAction({ container: "zip", keepPacked: false }), "unpack");
  assert.equal(decideDownloadAction({ container: "tar_zst", keepPacked: false }), "unpack");
});

test("decide: наш контейнер + ON → keep_archive", () => {
  assert.equal(decideDownloadAction({ container: "zip", keepPacked: true }), "keep_archive");
  assert.equal(decideDownloadAction({ container: "tar_zst", keepPacked: true }), "keep_archive");
});

test("decide: чужое/сырое → keep_file при любом чекбоксе", () => {
  assert.equal(decideDownloadAction({ container: "foreign", keepPacked: false }), "keep_file");
  assert.equal(decideDownloadAction({ container: "foreign", keepPacked: true }), "keep_file");
  assert.equal(decideDownloadAction({ container: "plain", keepPacked: true }), "keep_file");
});

// ── Фаза 3 (BUG-SMART-SINGLE-UPLOAD-003): контейнер в имени/манифесте ──────

test("containerExtension: расширение нашего контейнера, чужим — пусто", () => {
  assert.equal(containerExtension("zip"), ".zip");
  assert.equal(containerExtension("tar_zst"), ".tar.zst");
  assert.equal(containerExtension("foreign"), "");
  assert.equal(containerExtension("plain"), "");
});

test("expectedContainerName: манифест имеет приоритет над именем", () => {
  assert.equal(expectedContainerName("tar_zst", "dump.zip"), "tar_zst");
  assert.equal(expectedContainerName("zip", "dump.tar.zst"), "zip");
});

test("expectedContainerName: fallback по имени (.tar.zst/.tzst/.zip)", () => {
  assert.equal(expectedContainerName(null, "bundle.tar.zst"), "tar_zst");
  assert.equal(expectedContainerName(undefined, "BUNDLE.TZST"), "tar_zst");
  assert.equal(expectedContainerName(null, "bundle.zip"), "zip");
  // Чужое и сырое — не наш контейнер (распаковки не будет).
  assert.equal(expectedContainerName(null, "image.zst"), null);
  assert.equal(expectedContainerName(null, "dump.7z"), null);
  assert.equal(expectedContainerName(null, "file_512"), null);
});

// ── П.4: диалог «Оставить архивом?» перед проводником ────────────────────────

test("keepPackedChoice: ответ диалога ПЕРЕбивает persist на эту операцию", () => {
  // Пользователь в чекбоксе включил persist «оставить», но в диалоге нажал
  // «Нет» → эта операция распаковывается.
  assert.equal(keepPackedChoice(false, true), false);
  // И наоборот: persist OFF, в диалоге «Да» → архив остаётся.
  assert.equal(keepPackedChoice(true, false), true);
});

test("keepPackedChoice: без диалога (null) → persist-значение чекбокса", () => {
  assert.equal(keepPackedChoice(null, true), true);
  assert.equal(keepPackedChoice(null, false), false);
});
