/**
 * Готовность Telegram-кред (Zero Secrets in Binary: их выдаёт сервер).
 *
 * BUG-FIRST-RUN-002 (2026-09-22): `src/main.ts` получает креды асинхронно, а
 * `TdlibAuthPage.checkAndShow()` стартует параллельно. До этого момента любой
 * TDLib-запрос уходил в sidecar и возвращал `-32000 TDLib runtime not
 * initialized (tdlib_start_runtime)` — в релизе 0.3.0 это выглядело как красная
 * ошибка «Ошибка: sidecar error -32000…» ещё до входа (скрин владельца).
 *
 * Отдельный модуль (а не импорт из main.ts) — чтобы не создавать цикл
 * main → ui/App → ui/TdlibAuthPage → main.
 */

let settled: Promise<void> = Promise.resolve();

/** Зарегистрировать промис «креды получены / попытка завершена». */
export function setCredentialsSettled(p: Promise<void>): void {
  settled = p;
}

/** Дождаться попытки получения кредов — TDLib-команды нельзя слать раньше. */
export function credentialsReady(): Promise<void> {
  return settled;
}
