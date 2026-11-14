/**
 * Диагностика входа по телефону (BUG-AUTH-CODE-002, 2026-10-13).
 *
 * Собирает текст подсказки для случая «TDLib за 30 с не прислал
 * `authorizationStateWaitCode`». Модуль ЧИСТЫЙ (без DOM, без моста) — так его
 * проверяют `npm run test:ui`; каталог логов приходит параметром, потому что
 * рендерер его не знает: единственный источник правды — main
 * (`invoke("engine.sidecarStatus")` → `log_dir`, он же настраивает
 * `FW_TDLIB_LOG_PATH`, см. [`electron/main.ts`](../../electron/main.ts)
 * `clientLogDir()`).
 *
 * Почему не хардкод пути: до этого фикса подсказка вела в
 * `%LOCALAPPDATA%\firmware-desktop-client\logs` и просила прислать
 * `auth_debug.log` / `tdlib_trace.log` / `tdlib_diag.log` / `tdlib_cpp.log` —
 * наследство снесённой Tauri-линии (`desktop/` → `firmware-tauri-desktop`).
 * Основные логи Electron-порта: `<userData>/logs/tdlib.log` и
 * `<userData>/logs/auth-flow.log` (последний содержит безопасные стадии
 * прямой MTP-передачи, без телефона, кода, пароля или login token).
 * (`%APPDATA%\ARTEL` на Windows, `~/.config/ARTEL` на Linux).
 */

/** Файлы, которые реально пишет Electron-порт в `<userData>/logs`. */
export const AUTH_DIAG_FILES = ["auth-flow.log", "tdlib.log", "main-sidecar.log", "engine-core.log"] as const;

/** Сигнатура i18n-перевода (в рантайме — `tLoose` из `src/i18n`). */
export type AuthDiagTranslate = (key: string, params?: Record<string, string>) => string;

export interface NoCodeDiagnosticsInput {
  /** Каталог логов из main; `null` — мост не ответил (путь НЕ выдумываем). */
  logDir: string | null;
  /** Последнее известное состояние соединения TDLib (для «сеть или нет»). */
  connectionState: string | null;
  /** Перевод (инъекция — модуль не тянет i18n/locale сам). */
  t: AuthDiagTranslate;
}

/** Строка для машинного лога (`authLogUI`): какие файлы просить и откуда. */
export function authDiagFilesList(): string {
  return AUTH_DIAG_FILES.join(", ");
}

/**
 * Текст подсказки: без каталога (`logDir === null`) сообщаем только состояние
 * сети — придуманный путь вернул бы RCA туда же, где он и застрял.
 */
export function buildNoCodeDiagnostics(input: NoCodeDiagnosticsInput): string {
  const parts = [
    input.t("auth.diag_no_code"),
    input.t("auth.diag_net_state", { state: input.connectionState || "unknown" }),
  ];
  if (input.logDir) {
    parts.push(input.t("auth.diag_logs", { dir: input.logDir }));
    parts.push(input.t("auth.diag_send"));
  }
  return parts.join(" ");
}
