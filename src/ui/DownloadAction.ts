/**
 * DownloadAction — «Оставить архивом» (keep-packed, V3-добор).
 *
 * Решает, что делать со скачанным bundle ПОСЛЕ склейки:
 *  - unpack: распаковать нашим экстрактором (zip/tar.zst) и удалить архив
 *    (дефолт, паритет BUG-DESKTOP-UI-007);
 *  - keep_archive: оставить архив на диске + подсказка пользователю
 *    (про запас; распаковка — вкладка «Архиватор»).
 *  - keep_file: не наш контейнер (.7z/.rar/…) — только подсказка
 *    «откройте своим архиватором», распаковки нет и быть не может.
 *
 * Чистые функции для node-тестов: без DOM, без i18n, без FS.
 */

export type DownloadContainer = "zip" | "tar_zst" | "foreign" | "plain";

/**
 * Контейнер скачанного по манифесту + имени + magic (байты весомее имени —
 * паритет с SingleUploadPolicy).
 *
 *  - manifestContainer: поле manifest_json.container ("zip" | "tar_zst"),
 *    у старых записей отсутствует;
 *  - fileName: итоговое имя сохранённого файла;
 *  - header: первые байты (peek_file_header, уже есть в DownloadPage).
 */
export function detectDownloadContainer(opts: {
  manifestContainer?: string | null;
  fileName: string;
  header: ReadonlyArray<number>;
}): DownloadContainer {
  const { manifestContainer, fileName, header } = opts;
  if (manifestContainer === "zip" || manifestContainer === "tar_zst") {
    return manifestContainer;
  }
  const lower = fileName.toLowerCase();
  const isZipMagic =
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    header[2] === 0x03 &&
    header[3] === 0x04;
  const isZstdMagic =
    header.length >= 4 &&
    header[0] === 0x28 &&
    header[1] === 0xb5 &&
    header[2] === 0x2f &&
    header[3] === 0xfd;
  if (isZipMagic) return "zip";
  if (isZstdMagic) return "tar_zst";
  if (lower.endsWith(".zip") || lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) {
    // Имя «архивное», но magic чужой/пустой: не наш контейнер — не трогаем
    // байты распаковкой (fail-closed вместо ошибки extract).
    return "foreign";
  }
  return "plain";
}

export type DownloadAction = "unpack" | "keep_archive" | "keep_file";

/**
 * Расширение файла для контейнера (`zip` → `.zip`, `tar_zst` → `.tar.zst`).
 * Для `plain`/`foreign` — пустая строка (имя НЕ трогаем: чужие байты).
 */
export function containerExtension(container: DownloadContainer): string {
  switch (container) {
    case "zip":
      return ".zip";
    case "tar_zst":
      return ".tar.zst";
    default:
      return "";
  }
}

/** Наш контейнер по контейнеру в манифесте либо по расширению имени. */
export function expectedContainerName(
  manifestContainer: string | null | undefined,
  fileName: string,
): "zip" | "tar_zst" | null {
  if (manifestContainer === "zip" || manifestContainer === "tar_zst") {
    return manifestContainer;
  }
  const lower = fileName.toLowerCase();
  // `.tar.zst`/`.tzst` — именно tar.zst (голый `.zst` — одиночный zstd-файл,
  // наш экстрактор его не распакует → не считаем «нашим»).
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) return "tar_zst";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

/**
 * П.4: результат диалога «Оставить архивом?» (Да/нет) поверх persist-чекбокса.
 *
 * Диалог — заметный UX перед вызовом проводника (обе точки входа: Поиск и
 * Передача); его ответ действует ТОЛЬКО на текущую операцию и НЕ переписывает
 * persist `fw_download_keep_packed` (постоянная настройка — чекбокс).
 *
 *  - dialogAnswer !== null → берём ответ диалога;
 *  - dialogAnswer === null (диалог не показывался: не наш контейнер, мост
 *    недоступен, ошибка) → сохраняем persist-значение чекбокса.
 */
export function keepPackedChoice(
  dialogAnswer: boolean | null,
  persisted: boolean,
): boolean {
  return dialogAnswer === null ? persisted : dialogAnswer;
}

/**
 * Действие после склейки.
 *
 *  - container zip/tar_zst + keepPacked=false → unpack (дефолт);
 *  - container zip/tar_zst + keepPacked=true → keep_archive;
 *  - container foreign/plain → keep_file (распаковки нет ни при каком чекбоксе).
 */
export function decideDownloadAction(opts: {
  container: DownloadContainer;
  keepPacked: boolean;
}): DownloadAction {
  const { container, keepPacked } = opts;
  if (container === "zip" || container === "tar_zst") {
    return keepPacked ? "keep_archive" : "unpack";
  }
  return "keep_file";
}
