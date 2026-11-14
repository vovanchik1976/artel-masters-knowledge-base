/**
 * Отмена скачивания = ФИНАЛ (вариант B «финал файлов + retry жив»).
 *
 * Чистая функция-планировщик без DOM/i18n/FS — тестируется в node:test
 * (tests/download-cancel-final.test.ts). Единая точка правды «что делает
 * cancelDownload ПОСЛЕ остановки движка»:
 *
 *   1. Удаляет недокачанные файлы (savePath; для multi/vault — outputPath
 *      склейки, обычно тот же путь). Дедуп: multi пишет в тот же файл.
 *   2. Чистит файловый кеш TDLib (`tdlib_clear_cache`) — раньше purge был
 *      только на успехе (BUG: отмена оставляла мусор в files_dir).
 *   3. Закрывает серверную сессию `complete(false)` (только если известен
 *      downloadId) — retry-семантика БЕЗ refund.
 *   4. Прячет retry-панель и сбрасывает lease-контекст: отмена — финал,
 *      «Повторити безкоштовно» после ОТМЕНЫ не показывается (панель
 *      остаётся только для обрывов/ошибок, где отмены не было).
 *   5. freeRestartHint: если сессия была оплачена (start выполнен) — в лог
 *      печатается, что ПОВТОР ТОГО ЖЕ файла в пределах lease бесплатен
 *      (`reused_active_lease`), а по истечении lease баллы списываются
 *      (write-off, серверный лог «lease expired») + чистится PM-доставка.
 *
 * Сервер НЕ меняется: complete(false) на started оставляет lease живым 24ч —
 * этого достаточно и для «повтор бесплатен», и для «write-off с логом».
 */

/** Входные координаты отменяемой попытки (снимок ДО любых await). */
export interface FinalCancelContext {
  /** Путь сохранения (single/owner/personal) — может быть null, если отмена
   *  пришлась до выбора пути. */
  savePath: string | null;
  /** Путь вывода multi/vault-склейки; обычно равен savePath (дедуп). */
  outputPath: string | null;
  /** Серверная сессия (null — личный/owner-поток без серверной сессии). */
  downloadId: string | null;
  /** start выполнен → баллы списаны (capture) → нужен hint о бесплатном retry. */
  hostStarted: boolean;
}

/** План финальной зачистки отмены. */
export interface FinalCancelPlan {
  /** Уникальные пути недокачанных файлов для удаления (дедуп, без null). */
  removePaths: string[];
  /** Чистить ли файловый кеш TDLib — при отмене ВСЕГДА true. */
  purgeTdlibCache: boolean;
  /** Закрывать ли серверную сессию complete(false) — true при известном id. */
  closeSession: boolean;
  /** Прятать ли retry-панель и сбрасывать lease-контекст — ВСЕГДА true. */
  hideRetryPanel: boolean;
  /** Синоним hideRetryPanel для явности в cancelDownload (см. модуль). */
  resetLeaseContext: boolean;
  /** Оплаченная сессия → напечатать в логе hint о бесплатном повторе. */
  freeRestartHint: boolean;
}

/**
 * Собрать план финальной зачистки при отмене скачивания.
 *
 * @param ctx снимок координат попытки (ДО await — иначе finally/start
 *            обнулит координаты, как в BUG-CANCEL-RESUME-001).
 */
export function buildFinalCancelPlan(ctx: FinalCancelContext): FinalCancelPlan {
  const paths: string[] = [];
  const push = (p: string | null): void => {
    if (p && !paths.includes(p)) paths.push(p);
  };
  push(ctx.savePath);
  push(ctx.outputPath);

  return {
    removePaths: paths,
    purgeTdlibCache: true,
    closeSession: ctx.downloadId !== null && ctx.downloadId !== "",
    hideRetryPanel: true,
    resetLeaseContext: true,
    freeRestartHint: ctx.hostStarted,
  };
}
