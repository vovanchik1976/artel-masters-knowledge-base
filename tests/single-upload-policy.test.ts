/**
 * SingleUploadPolicy — «Умный Single Upload» (BUG-SMART-SINGLE-UPLOAD-001).
 *
 * Тестируем decision-матрицу одиночного файла:
 *  - готовый архив (расширение в skip-списке + magic совпал) → bundle, не жмём;
 *  - перевранное расширение (.zip с чужими байтами) → жмём (сырьё!);
 *  - архивный magic с сырым именем → bundle (байты весомее имени);
 *  - сырой файл → архивируем ВСЕГДА (чекбокс «Сжать» удалён решением владельца,
 *    BUG-SMART-SINGLE-UPLOAD-001: поле compressEnabled удалено из API).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideSingleSource,
  fileExtension,
  isArchiveExtension,
  isTarZstName,
  matchArchiveMagic,
  readSkipPackingPref,
  SKIP_PACKING_STORAGE_KEY,
  writeSkipPackingPref,
} from "../src/search/SingleUploadPolicy";

test("fileExtension: нижний регистр, без точки, без пути", () => {
  assert.equal(fileExtension("DUMP.BIN"), "bin");
  assert.equal(fileExtension("C:\\fw\\dump.7Z"), "7z");
  assert.equal(fileExtension("/tmp/archive.tar.gz"), "gz");
  assert.equal(fileExtension("noext"), "");
  assert.equal(fileExtension(".hidden"), "");
  assert.equal(fileExtension("trailing."), "");
});

test("isArchiveExtension: skip-список готовых архивов", () => {
  assert.equal(isArchiveExtension("fw.zip"), true);
  assert.equal(isArchiveExtension("dump.7z"), true);
  assert.equal(isArchiveExtension("x.RAR"), true);
  assert.equal(isArchiveExtension("x.tar.gz"), true);
  assert.equal(isArchiveExtension("x.iso"), true);
  assert.equal(isArchiveExtension("fw.bin"), false);
  assert.equal(isArchiveExtension("fw.hex"), false);
  assert.equal(isArchiveExtension("fw.dat"), false);
  assert.equal(isArchiveExtension("noext"), false);
});

test("matchArchiveMagic: zip/7z/rar/gzip по первым байтам", () => {
  assert.equal(matchArchiveMagic([0x50, 0x4b, 0x03, 0x04, 0x99]), "zip");
  assert.equal(
    matchArchiveMagic([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    "7z",
  );
  assert.equal(
    matchArchiveMagic([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
    "rar",
  );
  assert.equal(matchArchiveMagic([0x1f, 0x8b, 0x08]), "gzip");
  assert.equal(matchArchiveMagic([0xff, 0xd8, 0xff, 0xe0]), null);
  assert.equal(matchArchiveMagic([0x50, 0x4b]), null); // короче сигнатуры
});

test("decide: готовый архив (.zip + PK) → bundle, не архивируем", () => {
  const r = decideSingleSource({
    fileName: "fw.zip",
    header: [0x50, 0x4b, 0x03, 0x04],
  });
  assert.equal(r.source, "bundle");
  assert.equal(r.shouldArchive, false);
});

test("decide: готовый .7z (расширение + magic) → ready, не архивируем", () => {
  const r = decideSingleSource({
    fileName: "dump.7z",
    header: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
});

test("decide: готовый .rar (расширение + magic) → ready, не архивируем", () => {
  const r = decideSingleSource({
    fileName: "dump.rar",
    header: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
});

test("decide: перевранное расширение (.zip с чужими байтами) → жмём", () => {
  const r = decideSingleSource({
    fileName: "dump.zip",
    header: [0xff, 0xd8, 0xff, 0xe0, 0x00],
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, true);
});

test("decide: архивный magic с сырым именем → bundle (байты весомее)", () => {
  const r = decideSingleSource({
    fileName: "dump",
    header: [0x50, 0x4b, 0x03, 0x04],
  });
  assert.equal(r.source, "bundle");
  assert.equal(r.shouldArchive, false);
});

test("decide: чужой magic (7z) с сырым именем → ready (байты весомее)", () => {
  const r = decideSingleSource({
    fileName: "dump",
    header: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
});

test("decide: сырой .bin → архивируем ВСЕГДА (сжатие обязательно)", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x11, 0x22, 0x33],
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, true);
});

// RED-фиксация П.1: legacy-флаг «сжатие выключено» больше не влияет на
// решение — сырьё пакуется даже при compressEnabled:false (вызывается с
// cast, т.к. поле удалено из публичного типа).
test("decide: legacy compressEnabled:false игнорируется — сырьё ВСЕГДА пакуем", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x11, 0x22, 0x33],
    compressEnabled: false,
  } as Parameters<typeof decideSingleSource>[0]);
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, true, "сжатие обязательно — флаг OFF не отключает упаковку");
});

test("decide: сырой .zip без magic → ВСЕГДА пакуем (compressEnabled удалён)", () => {
  const r = decideSingleSource({
    fileName: "dump.zip",
    header: [0xff, 0xd8, 0xff, 0xe0],
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, true);
});

// ── Фаза 3 (BUG-SMART-SINGLE-UPLOAD-003): tar.zst — наш контейнер ──────────

test("isTarZstName: .tar.zst/.tzst распознаются, голый .zst — нет", () => {
  assert.equal(isTarZstName("bundle.tar.zst"), true);
  assert.equal(isTarZstName("C:\\dumps\\BUNDLE.TAR.ZST"), true);
  assert.equal(isTarZstName("bundle.tzst"), true);
  // Одиночный zstd-файл (не tar) — не наш контейнер (fail-closed).
  assert.equal(isTarZstName("image.zst"), false);
  assert.equal(isTarZstName("dump.bin"), false);
});

test("decide: готовый .tar.zst (zstd magic) → bundle с container=tar_zst", () => {
  const r = decideSingleSource({
    fileName: "bundle.tar.zst",
    header: [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00],
  });
  assert.equal(r.source, "bundle");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, "tar_zst");
});

test("decide: готовый .tzst → bundle с container=tar_zst", () => {
  const r = decideSingleSource({
    fileName: "bundle.tzst",
    header: [0x28, 0xb5, 0x2f, 0xfd],
  });
  assert.equal(r.source, "bundle");
  assert.equal(r.container, "tar_zst");
});

test("decide: голый .zst (zstd без tar-имени) → ready, не обещаем распаковку", () => {
  const r = decideSingleSource({
    fileName: "image.zst",
    header: [0x28, 0xb5, 0x2f, 0xfd],
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null);
});

test("decide: готовый ZIP → container=zip (манифест честный)", () => {
  const r = decideSingleSource({
    fileName: "fw.zip",
    header: [0x50, 0x4b, 0x03, 0x04],
  });
  assert.equal(r.container, "zip");
});

test("decide: сырьё (упаковываем мы) → container не задан решением", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x11],
  });
  assert.equal(r.shouldArchive, true);
  assert.equal(r.container, null, "контейнер выбирает UI (radio), а не policy");
});

// ── BUG-CABINET-VAULT-SHA-MISMATCH-001: «не пакувати» в личном хранилище ────

test("decide: без allowSkipPacking сырьё пакуется (публичное поле — как раньше)", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x11],
  });
  assert.equal(r.shouldArchive, true, "дефолт обязан остаться «пакуем»");
});

test("decide: allowSkipPacking=true → сырьё уходит как есть, контейнера нет", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x11],
    allowSkipPacking: true,
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, false, "мастер попросил не паковать — не пакуем");
  assert.equal(r.container, null, "у неупакованного файла контейнера нет");
});

test("decide: allowSkipPacking=true и «перевранное» расширение (.zip без magic)", () => {
  const r = decideSingleSource({
    fileName: "dump.zip",
    header: [0xff, 0xd8, 0xff, 0xe0],
    allowSkipPacking: true,
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, false, "это сырьё — флаг действует и здесь");
});

test("decide: allowSkipPacking=true НЕ ломает готовые архивы", () => {
  const zip = decideSingleSource({
    fileName: "fw.zip",
    header: [0x50, 0x4b, 0x03, 0x04],
    allowSkipPacking: true,
  });
  assert.equal(zip.source, "bundle");
  assert.equal(zip.container, "zip", "готовый ZIP по-прежнему распакуем сами");

  const foreign = decideSingleSource({
    fileName: "dump.7z",
    header: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    allowSkipPacking: true,
  });
  assert.equal(foreign.source, "ready");
  assert.equal(foreign.container, null);
});

// ── Persist «запоминать прошлый выбор» (fork 1в) ─────────────────────────────

test("skipPackingPref: чтение fail-closed (мусор/пусто → пакуем)", () => {
  assert.equal(SKIP_PACKING_STORAGE_KEY, "fw_upload_skip_packing");
  assert.equal(readSkipPackingPref(() => "1"), true);
  assert.equal(readSkipPackingPref(() => "0"), false);
  assert.equal(readSkipPackingPref(() => null), false);
  assert.equal(readSkipPackingPref(() => "yes"), false, "неизвестное значение → пакуем");
  assert.equal(readSkipPackingPref(() => { throw new Error("boom"); }), false);
});

test("skipPackingPref: запись кладёт 1/0 и не бросает при ошибке хранилища", () => {
  const store = new Map<string, string>();
  writeSkipPackingPref((k, v) => void store.set(k, v), true);
  assert.equal(store.get(SKIP_PACKING_STORAGE_KEY), "1");
  writeSkipPackingPref((k, v) => void store.set(k, v), false);
  assert.equal(store.get(SKIP_PACKING_STORAGE_KEY), "0");
  // Приватный режим/запрет localStorage не должны ронять загрузку.
  assert.doesNotThrow(() =>
    writeSkipPackingPref(() => {
      throw new Error("QuotaExceededError");
    }, true),
  );
});


// ═══ SP-37/D-189: packRaw=false (kind ≠ firmware) ═══════════════════════
// Власник: архівування при upload тільки для «Прошивки». Для інших kind байти
// йдуть як є (manifest firmware_file, container=null) — при скачуванні нічого
// не розпаковується: .zip-інсталятор софту має лишитись .zip (фікс live-бага
// SP-35: готовий .zip софту ставав bundle → download розпаковував його).

test("SP-37: packRaw=false — сырой файл → file, не пакуем, container=null", () => {
  const r = decideSingleSource({
    fileName: "IMG_4021.jpg",
    header: [0xff, 0xd8, 0xff, 0xe0], // JPEG — не архив
    packRaw: false,
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, false, "власник: архівування не для не-firmware");
  assert.equal(r.container, null);
});

test("SP-37: packRaw=false — готовый .zip (PK) → ready, НЕ bundle (не распаковываем при скачивании)", () => {
  const r = decideSingleSource({
    fileName: "ponyprog.zip",
    header: [0x50, 0x4b, 0x03, 0x04],
    packRaw: false,
  });
  assert.equal(r.source, "ready", "софт-зип має дійти до майстра як .zip");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null, "container=null → manifest firmware_file");
});

test("SP-37: packRaw=false — готовый tar.zst (zstd magic) → ready, container=null", () => {
  const r = decideSingleSource({
    fileName: "set.tar.zst",
    header: [0x28, 0xb5, 0x2f, 0xfd],
    packRaw: false,
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null);
});

test("SP-37: packRaw=false — чужой .7z → ready (как и раньше)", () => {
  const r = decideSingleSource({
    fileName: "x.7z",
    header: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    packRaw: false,
  });
  assert.equal(r.source, "ready");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null);
});

test("SP-37: packRaw=false — переименованный .zip без magic → file, не пакуем", () => {
  const r = decideSingleSource({
    fileName: "renamed.zip",
    header: [0x00, 0x01, 0x02, 0x03],
    packRaw: false,
  });
  assert.equal(r.source, "file");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null);
});

test("SP-37: packRaw=false — zip-magic с сырым именем → ready (НЕ bundle)", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x50, 0x4b, 0x03, 0x04],
    packRaw: false,
  });
  assert.equal(r.source, "ready", "zip-байты как есть, распаковки при скачивании нет");
  assert.equal(r.shouldArchive, false);
  assert.equal(r.container, null);
});

test("SP-37: packRaw по умолчанию true — поведение firmware не меняется", () => {
  const r = decideSingleSource({
    fileName: "dump.bin",
    header: [0x00, 0x01],
  });
  assert.equal(r.shouldArchive, true, "прошивки пакуются как и раньше");
});
