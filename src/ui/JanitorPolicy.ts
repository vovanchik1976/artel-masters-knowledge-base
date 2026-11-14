/**
 * Политика дворника temp-мусора (BUG-CANCEL-FINAL-001, BUG-SINGLE-INSTANCE-001).
 *
 * Чистая функция без DOM/i18n/FS — тестируется в node:test
 * (tests/janitor-policy.test.ts). Единая точка правды «с каким порогом
 * возраста вызывать Rust-дворник `cleanup_stale_archives`», который чистит:
 *   – `temp/firmware-desktop/*.zip|*.zst` — temp-архивы upload;
 *   – `temp/tdlib_upload_parts/*.part` — слайсы multi-upload `{pid}_{i}.part`.
 *
 * Порог — 0 («любой возраст») для ВСЕХ триггеров, включая `startup`.
 * Исторично на старте порог был 24ч, и бережность защищала ровно один сценарий:
 * рядом работает ВТОРАЯ копия клиента со своими СВЕЖИМИ temp-файлами. С
 * 2026-09-27 вторая копия запрещена на входе (`app.requestSingleInstanceLock`,
 * BUG-SINGLE-INSTANCE-001) — бережность потеряла предмет:
 *   • эксклюзивность подтверждена кодом запуска: замок берётся ДО окна/TDLib;
 *   • остатки мёртвого процесса — всегда мусор: слайсы `{pid}_{i}.part` не
 *     переживают рестарт (новый процесс режет файл заново под своим pid),
 *     temp-архив пересобирается, а готовый скачанный файл лежит в каталоге
 *     пользователя и дворником не трогается.
 *
 * ВАЖНО: `op-end`/`cancel` вызывают дворник ТОЛЬКО после остановки движка —
 * иначе снесут слайсы живой операции. На `startup` движок ещё не запускался,
 * а второй экземпляр невозможен (замок).
 */

/** Порог возраста для дворника: 0 = без порога (остатки любого возраста). */
export const JANITOR_MAX_AGE_SECS = 0;

/** Когда запускается дворник. Идёт в журнал вызывающего кода; политика возраста едина. */
export type JanitorTrigger = "startup" | "op-end" | "cancel";

/**
 * Порог возраста (сек) для `cleanup_stale_archives(max_age_secs)`.
 *
 * @param _trigger момент вызова — фиксируется в журнале; политика едина для
 *                 всех триггеров и живёт здесь.
 */
export function resolveJanitorMaxAge(_trigger: JanitorTrigger): number {
  return JANITOR_MAX_AGE_SECS;
}

/**
 * Запрос к Rust-дворнику `cleanup_stale_archives`.
 *
 * Собирается в одном месте (`buildJanitorRequest`) — Rust не решает сам, что
 * чистить: политика живёт здесь, как и порог возраста.
 */
export interface JanitorRequest {
  /** Порог возраста файла в секундах (0 = без порога, любые остатки). */
  maxAgeSecs: number;
  /**
   * Чистить ли файловый кеш TDLib (Windows:
   * `%LOCALAPPDATA%\firmware-desktop-electron\tdlib_files`, Linux-dev:
   * `/tmp/tdlib_files_electron`) + legacy `temp/tdlib_download_parts`.
   */
  includeTdlibCache: boolean;
}

/**
 * Собрать запрос к Rust-дворнику для конкретного триггера.
 *
 * Порог — 0 для всех триггеров (см. `JANITOR_MAX_AGE_SECS`).
 *
 * Кеш TDLib чистится ТОЛЬКО на `startup`: он общий на TDLib-сессию, а upload и
 * download живут в разных вкладках и могут идти одновременно — операционный
 * свип (`op-end`/`cancel`) снёс бы файлы живой параллельной передачи. На старте
 * передач не существует, и чистка закрывает дыру: иначе кеш подчищался лишь
 * после УСПЕШНОГО download (BUG-UX-001) или вручную кнопкой, и пользователь,
 * который только заливает прошивки, копил его бесконечно (BUG-JANITOR-WIN-001).
 *
 * `otherTransferActive` — защита от гонки: если передача всё-таки активна
 * (например, download уже стартовал), кеш не трогаем даже на `startup`.
 *
 * @param trigger момент вызова дворника;
 * @param otherTransferActive идёт ли прямо сейчас ДРУГАЯ передача.
 */
export function buildJanitorRequest(
  trigger: JanitorTrigger,
  otherTransferActive = false,
): JanitorRequest {
  return {
    maxAgeSecs: resolveJanitorMaxAge(trigger),
    includeTdlibCache: trigger === "startup" && !otherTransferActive,
  };
}

/**
 * Чистить ли файловый кеш TDLib при ОТМЕНЕ операции.
 *
 * Кеш общий для всей клиентской TDLib-сессии (`tdlib_files` +
 * `tdlib_download_parts` + local→remote mapping), а upload и download живут
 * в РАЗНЫХ вкладках и могут идти одновременно. Поэтому при отмене одного
 * потока пург допустим только если параллельная передача НЕ идёт — иначе
 * снос кеша убьёт активный upload (его локальная копия/маппинг исчезнут).
 *
 * Если пург пропущен, мусор отменённой загрузки снимет следующий успешный
 * download (auto-purge после каждой успешной загрузки, BUG-UX-001).
 *
 * @param otherTransferActive идёт ли параллельно ДРУГАЯ передача (upload).
 */
export function shouldPurgeTdlibCacheOnCancel(otherTransferActive: boolean): boolean {
  return !otherTransferActive;
}
