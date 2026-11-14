/**
 * Заголовок баланса без мигания (D-BP-5).
 *
 * Правило: «⏳ loading…» показывается ТОЛЬКО пока значение не известно ни разу.
 * Повторные обновления (WS-push, polling 15 c, ретраи после ошибки) текст не
 * трогают — до фикса App.ts писал плейсхолдер первым делом в каждом вызове
 * fetchAndShowBalance, и заголовок мигал между значением и «⏳».
 *
 * Модуль чистый (без DOM/сети) — гейты: tests/header-balance.test.ts (H1–H8)
 * и tests/header-balance-source.test.ts (S1–S4, подключение к App.ts).
 */

export interface HeaderBalanceState {
  /** Последнее известное значение баланса (null — ещё ни разу не показывали). */
  value: number | null;
  /** Идёт GET баланса (дедуп параллельных запросов). */
  inFlight: boolean;
}

export function newHeaderBalance(): HeaderBalanceState {
  return { value: null, inFlight: false };
}

/**
 * Начать запрос баланса.
 *
 * @returns started=false — запрос уже в полёте, параллельный GET не делаем
 *   (вызывающий может запомнить «перезапросить после» — App._refetchQueued).
 */
export function beginHeaderFetch(state: HeaderBalanceState): {
  state: HeaderBalanceState;
  started: boolean;
} {
  if (state.inFlight) return { state, started: false };
  return { state: { ...state, inFlight: true }, started: true };
}

/**
 * Завершить запрос значением: inFlight сбрасывается, значение устанавливается.
 * changed=false — значение не изменилось (текст перерисовывать не нужно).
 */
export function endHeaderFetch(
  state: HeaderBalanceState,
  value: number,
): { state: HeaderBalanceState; changed: boolean } {
  return {
    state: { value, inFlight: false },
    changed: state.value !== value,
  };
}

/**
 * Завершить запрос БЕЗ значения (ошибка/нет user): inFlight сбрасывается,
 * прежнее значение сохраняется — текст не дёргается.
 */
export function settleHeaderFetch(state: HeaderBalanceState): HeaderBalanceState {
  return { ...state, inFlight: false };
}

/**
 * Мгновенное применение push с сервера (WS balance_update) — без GET.
 */
export function applyHeaderPush(
  state: HeaderBalanceState,
  value: number,
): { state: HeaderBalanceState; changed: boolean } {
  if (state.value === value) return { state, changed: false };
  return { state: { ...state, value }, changed: true };
}

/**
 * Что рисовать: "loading" — только пока значение не известно ни разу.
 */
export function headerHint(state: HeaderBalanceState): "loading" | "value" {
  return state.value === null ? "loading" : "value";
}

/** Полный сброс (logout / force-reauth). */
export function resetHeaderBalance(): HeaderBalanceState {
  return newHeaderBalance();
}
