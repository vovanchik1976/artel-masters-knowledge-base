/**
 * SingleUploadPolicy — «Умный Single Upload» (BUG-SMART-SINGLE-UPLOAD-001).
 *
 * Решает, что делать с ОДИНОЧНЫМ файлом перед отправкой:
 *  - готовый архив (.zip/.7z/.rar/.tar/.gz/.bz2/…) → НЕ перепаковывать:
 *    верифицируем magic-сигнатуру и грузим как есть (source=bundle);
 *  - сырой файл (.bin/.hex/.dat/.iso/…) → архивировать ОБЯЗАТЕЛЬНО
 *    (чекбокс убран решением владельца); как есть грузим только готовые/чужие архивы.
 *
 * Чистые функции для node-тестов (паритет с UploaderLabel.ts / SearchPolicy.ts):
 * без DOM, без i18n, без FS.
 */

/** Расширения готовых архивов — перепаковка запрещена (skip). */
export const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip",
  "7z",
  "rar",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz2",
  "xz",
  "txz",
  "zst",
  "zstd",
  "tzst",
  "cab",
  "arj",
  "lzh",
  "lha",
  "iso",
  "img",
]);

/** Magic-сигнатуры готовых архивов (первые байты) — верификация skip. */
export const ARCHIVE_MAGICS: ReadonlyArray<{
  format: string;
  bytes: ReadonlyArray<number>;
}> = [
  { format: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04
  { format: "zip", bytes: [0x50, 0x4b, 0x05, 0x06] }, // PK\x05\x06 (empty)
  { format: "zip", bytes: [0x50, 0x4b, 0x07, 0x08] }, // PK\x07\x08 (spanned)
  { format: "7z", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // 7z\xBC\xAF\x27\x1C
  { format: "rar", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // Rar!\x1A\x07
  { format: "gzip", bytes: [0x1f, 0x8b] }, // .gz/.tgz
  { format: "bzip2", bytes: [0x42, 0x5a, 0x68] }, // BZh (.bz2/.tbz2)
  { format: "xz", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }, // .xz/.txz
  { format: "zstd", bytes: [0x28, 0xb5, 0x2f, 0xfd] }, // .zst/.tzst
  { format: "cab", bytes: [0x4d, 0x53, 0x43, 0x46] }, // MSCF
];

/** Расширение имени файла (lowercase, без точки); "" если нет. */
export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Расширение — в skip-списке готовых архивов? */
export function isArchiveExtension(pathOrName: string): boolean {
  return ARCHIVE_EXTENSIONS.has(fileExtension(pathOrName));
}

/** Совпадение заголовка байт с известной archive-magic (peek, не грузит файл). */
export function matchArchiveMagic(header: ReadonlyArray<number>): string | null {
  for (const m of ARCHIVE_MAGICS) {
    if (header.length < m.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (header[i] !== m.bytes[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return m.format;
  }
  return null;
}

export type SingleSource = "bundle" | "ready" | "file";

/** Контейнер архива, который пишем в манифест (совпадает с Rust `ArchiveContainer`). */
export type UploadContainer = "zip" | "tar_zst";

/**
 * Ключ persist выбора «не пакувати» (личное хранилище).
 *
 * Решение владельца (D-182, 2026-11-11): пакуем **по умолчанию**, галочка
 * «не пакувати» доступна только в личном хранилище, но её состояние
 * запоминается между запусками (паритет с `fw_upload_container`).
 */
export const SKIP_PACKING_STORAGE_KEY = "fw_upload_skip_packing";

/**
 * Прочитать сохранённый выбор. Fail-closed: нет значения, мусор или сломанное
 * хранилище → `false` (пакуем — поведение по умолчанию).
 */
export function readSkipPackingPref(get: (key: string) => string | null): boolean {
  try {
    return get(SKIP_PACKING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Запомнить выбор. Ошибка хранилища (приватный режим, квота) НЕ должна ронять
 * загрузку — молча игнорируем, выбор просто не переживёт перезапуск.
 */
export function writeSkipPackingPref(
  set: (key: string, value: string) => void,
  value: boolean,
): void {
  try {
    set(SKIP_PACKING_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}


/**
 * Имя файла выглядит как tar.zst (`.tar.zst` / `.tzst`)?
 *
 * Нужно отдельно от общего archive-списка: zstd-magic без такого имени —
 * это одиночный `.zst` (не tar внутри), распаковать его нашим экстрактором
 * нельзя → такой файл честно уходит как `ready`.
 */
export function isTarZstName(name: string): boolean {
  const lower = (name.split(/[/\\]/).pop() ?? "").toLowerCase();
  return lower.endsWith(".tar.zst") || lower.endsWith(".tzst");
}

/**
 * Решение для одиночного файла.
 *
 * Возвращает:
 *  - source: "bundle" (наш контейнер — распакуем сами) | "ready" (чужой архив:
 *    отдаём валидным файлом, распаковка — архиватором получателя) |
 *    "file" (сырьё);
 *  - shouldArchive: вызывать ли упаковку (сырьё — по умолчанию всегда);
 *  - container: контейнер для манифеста при skip-загрузке готового архива
 *    ("zip" | "tar_zst"), иначе `null` (упаковку делаем мы — контейнер знает UI);
 *  - reason: человекопонятная причина (для лога, EN — логи всегда EN).
 *
 * `allowSkipPacking` (D-182, 2026-11-11): «не пакувати» — ТОЛЬКО личное
 * хранилище (публичный каталог пакует всегда). Включённый флаг отменяет
 * упаковку СЫРЬЯ: файл уходит байт-в-байт, хэш в манифесте остаётся честным
 * (BUG-CABINET-VAULT-SHA-MISMATCH-001). Готовые архивы (`bundle`/`ready`)
 * флагом не затрагиваются — там решение принимают байты.
 *
 * `packRaw` (SP-37/D-189, 2026-11-13): архівування разрешено ТОЛЬКО для
 * «Прошивки» (firmware). `packRaw=false` (kind ≠ firmware) отключает
 * архивирование ПОЛНОСТЬЮ: сырьё уходит байт-в-байт (manifest firmware_file,
 * честный byte_sha256 — путь D-182), а готовый наш архив (ZIP/tar.zst)
 * грузится как ВАЛИДНЫЙ ФАЙЛ (source=ready, container=null) — при скачивании
 * НИЧЕГО не распаковывается: .zip-инсталлятор софта доходит до мастера .zip'ом
 * (фикс live-бага SP-35: готовый .zip софта становился bundle → download
 * распаковывал его в папку).
 */
export function decideSingleSource(opts: {
  fileName: string;
  header: ReadonlyArray<number>;
  allowSkipPacking?: boolean;
  packRaw?: boolean;
}): {
  source: SingleSource;
  shouldArchive: boolean;
  container: UploadContainer | null;
  reason: string;
} {
  const { fileName, header, allowSkipPacking = false, packRaw = true } = opts;
  const extIsArchive = isArchiveExtension(fileName);
  const magic = matchArchiveMagic(header);

  // SP-37/D-189: kind ≠ firmware — НІ архівування, НІ оголошення контейнера.
  // Реальные архивы (magic) уходят как валидный файл (download не
  // распаковывает: firmware_file), сырьё — байтами как есть.
  if (!packRaw) {
    if (magic !== null) {
      return {
        source: "ready",
        shouldArchive: false,
        container: null,
        reason:
          `archive bytes (${magic} magic, .${fileExtension(fileName)}) — kind does not allow archiving, send as-is (no unpack on download)`,
      };
    }
    return {
      source: "file",
      shouldArchive: false,
      container: null,
      reason: "raw file — kind does not allow archiving, bytes as-is",
    };
  }

  // Готовый архив: расширение И magic согласны → skip (двойная страховка).
  // Распаковываем только то, что умеем сами (V3/Фаза 3):
  //  - zip (PK) → bundle, container=zip;
  //  - zstd + имя `.tar.zst`/`.tzst` → bundle, container=tar_zst;
  //  - прочее (.7z/.rar/… или zstd без tar-имени) → ready (валидный файл).
  if (extIsArchive && magic !== null) {
    if (magic === "zip") {
      return {
        source: "bundle",
        shouldArchive: false,
        container: "zip",
        reason: `ready-made ZIP (.${fileExtension(fileName)}, zip magic) — skip repack, we unpack it`,
      };
    }
    if (magic === "zstd" && isTarZstName(fileName)) {
      return {
        source: "bundle",
        shouldArchive: false,
        container: "tar_zst",
        reason: "ready-made tar.zst (zstd magic) — skip repack, we unpack it",
      };
    }
    return {
      source: "ready",
      shouldArchive: false,
      container: null,
      reason: `ready-made foreign archive (.${fileExtension(fileName)}, ${magic} magic) — send valid file as-is`,
    };
  }
  // Расширение «архивное», но magic чужой (переименованный .bin) → это НЕ архив,
  // хотя и называется .zip: сырьё. «Не пакувати» (личное хранилище) — как есть.
  if (extIsArchive && magic === null) {
    if (allowSkipPacking) {
      return {
        source: "file",
        shouldArchive: false,
        container: null,
        reason: "archive-looking extension but no magic — skip packing requested (personal vault)",
      };
    }
    return {
      source: "file",
      shouldArchive: true,
      container: null,
      reason: `archive-looking extension but no magic — raw data, pack it`,
    };
  }
  // Magic архивный, но расширение сырое (dump без расширения):
  //  - zip-magic → bundle (наш, распакуем);
  //  - прочий magic → ready (валидный файл как есть).
  if (!extIsArchive && magic !== null) {
    if (magic === "zip") {
      return {
        source: "bundle",
        shouldArchive: false,
        container: "zip",
        reason: `zip magic with raw extension — trust bytes, skip repack, we unpack it`,
      };
    }
    return {
      source: "ready",
      shouldArchive: false,
      container: null,
      reason: `foreign archive magic (${magic}) with raw extension — send valid file as-is`,
    };
  }
  // Сырой файл. По умолчанию сжатие обязательно (чекбокс удалён, D-182 —
  // только личное хранилище может попросить «не пакувати»).
  if (allowSkipPacking) {
    return {
      source: "file",
      shouldArchive: false,
      container: null,
      reason: "raw file — skip packing requested (personal vault), bytes as-is",
    };
  }
  return {
    source: "file",
    shouldArchive: true,
    container: null,
    reason: "raw file — pack it (compression mandatory)",
  };
}
