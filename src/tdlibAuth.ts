/**
 * Глобальное состояние TDLib user auth.
 *
 * Используется из:
 * - TdlibAuthPage (устанавливает флаг после успешной auth)
 * - DownloadPage (проверяет флаг в Slow Path)
 * - App (сбрасывает флаг при disconnect)
 */

let _authorized = false;

export function isTdlibUserAuthorized(): boolean {
  return _authorized;
}

export function setTdlibUserAuthorized(v: boolean): void {
  _authorized = v;
}
