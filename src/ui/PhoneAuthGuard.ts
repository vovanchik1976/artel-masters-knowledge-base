/**
 * Разбор типизированного отказа движка на вход по номеру телефона.
 *
 * # Зачем отдельный модуль
 *
 * TDLib принимает `setAuthenticationPhoneNumber` ТОЛЬКО в
 * `authorizationStateWaitPhoneNumber`. Любой другой момент (холодный старт,
 * отменённый QR, уже отправленный код, 2FA) давал `400 Call to
 * setAuthenticationPhoneNumber unexpected`, и мастер видел на экране входа
 * техотчёт вместо объяснения. Теперь движок не отправляет заведомо провальный
 * запрос, а возвращает машинный код:
 *
 * | код | смысл |
 * |-----|-------|
 * | `PHONE_AUTH_NOT_READY` | TDLib ещё в технической инициализации — повторить |
 * | `PHONE_AUTH_IN_PROGRESS:<state>` | уже идёт шаг входа (`wait_code`, `wait_password`, `wait_other_device`, …) |
 * | `PHONE_AUTH_ALREADY_AUTHORIZED` | TDLib уже Ready |
 *
 * Модуль чистый (без DOM/i18n): разбирает строку и говорит экрану, что делать —
 * показать шаг кода/2FA (`expectsCode`/`expectsPassword`), перезапросить
 * состояние (`resync`) или предложить «Сбросить» (`needsReset`).
 */

export type PhoneAuthGuardKind = "already_authorized" | "auth_in_progress" | "not_ready";

export interface PhoneAuthGuard {
  kind: PhoneAuthGuardKind;
  /** Короткое имя состояния TDLib (`wait_code`, `wait_password`, …) либо "". */
  state: string;
  /** Экран обязан перезапросить состояние: фактический шаг уже другой. */
  resync: boolean;
  /** Telegram уже отправил код — экран ввода кода. */
  expectsCode: boolean;
  /** Запрошен 2FA-пароль. */
  expectsPassword: boolean;
  /** Pending подтверждение (QR и т.п.): без «Сбросить» номер не принять. */
  needsReset: boolean;
}

const IN_PROGRESS = "PHONE_AUTH_IN_PROGRESS";
const NOT_READY = "PHONE_AUTH_NOT_READY";
const ALREADY_AUTHORIZED = "PHONE_AUTH_ALREADY_AUTHORIZED";

/**
 * Состояния, из которых TDLib сам не выйдет: он ждёт подтверждения в другом
 * месте (QR/сканер/регистрация), поэтому нужен явный сброс, а не «повторить».
 */
const RESET_STATES = new Set(["wait_other_device", "wait_qr_code", "wait_registration"]);

function guard(
  kind: PhoneAuthGuardKind,
  state: string,
  flags: Partial<Pick<PhoneAuthGuard, "resync" | "expectsCode" | "expectsPassword" | "needsReset">> = {},
): PhoneAuthGuard {
  return {
    kind,
    state,
    resync: flags.resync ?? false,
    expectsCode: flags.expectsCode ?? false,
    expectsPassword: flags.expectsPassword ?? false,
    needsReset: flags.needsReset ?? false,
  };
}

/**
 * Разобрать текст ошибки `invoke("tdlib_set_phone")`.
 *
 * `null` — это НЕ наш guard-код (обычная ошибка TDLib/моста): вызывающий
 * показывает её как раньше. Хвостовое пояснение после кода не мешает разбору.
 */
export function parsePhoneAuthGuard(raw: string | null | undefined): PhoneAuthGuard | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  if (text.startsWith(ALREADY_AUTHORIZED)) return guard("already_authorized", "ready", { resync: true });
  if (text.startsWith(NOT_READY)) return guard("not_ready", "");
  if (!text.startsWith(IN_PROGRESS)) return null;

  const rest = text.slice(IN_PROGRESS.length);
  const colon = rest.indexOf(":");
  const tail = colon < 0 ? "" : rest.slice(colon + 1);
  const state = tail.match(/^[a-z_]+/)?.[0] ?? "";
  const needsReset = state === "" || RESET_STATES.has(state);
  return guard("auth_in_progress", state, {
    resync: !needsReset,
    expectsCode: state === "wait_code",
    expectsPassword: state === "wait_password",
    needsReset,
  });
}
