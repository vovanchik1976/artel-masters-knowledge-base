/**
 * Централизованное состояние авторизации — единый источник истины
 * для всех модулей (DownloadPage, UploadPage, SearchPage, …).
 *
 * ====================================================================
 * ПРИНЦИП: Авторизация один раз при входе в клиент.
 * ====================================================================
 *
 * При входе пользователь проходит TDLib auth (QR/телефон/пароль),
 * после чего создаётся API-сессия (auth.json с Bearer token).
 * Все последующие операции во всех модулях используют ЭТУ ЖЕ сессию.
 *
 * Ни один модуль не имеет собственной авторизации — всё централизовано здесь.
 *
 * Использование:
 *   import { requireAuth, getCurrentTgId } from "../auth";
 *
 *   async startDownload() {
 *     if (!requireAuth(this.log)) return;
 *     const tgId = getCurrentTgId();
 *     ...
 *   }
 *
 * @see App.ts — устанавливает флаг setAppAuthenticated после TDLib auth
 * @see store.ts — управление API токеном (auth.json)
 * @see tdlibAuth.ts — глобальный флаг TDLib user auth
 */

import { store } from "./store";
import { isTdlibUserAuthorized } from "./tdlibAuth";
import { t } from "./i18n";

// ── App-level флаг ────────────────────────────────────────────────────────
// Устанавливается App.ts после успешного прохождения полного цикла TDLib auth.
// Отличается от isTdlibUserAuthorized():
//   - TDLib может быть авторизован технически (бот-токен работает)
//   - App-level флаг — только после полного init() + onTdlibAuthenticated()
let _appAuthenticated = false;

export function setAppAuthenticated(v: boolean): void {
  _appAuthenticated = v;
}

// ── Публичные проверки ────────────────────────────────────────────────────

/**
 * Полная проверка: авторизован ли пользователь на уровне клиента.
 *
 * Возвращает true при двух условиях:
 * 1. App-level флаг — пройден полный цикл TDLib auth (onTdlibAuthenticated)
 * 2. TDLib user auth — TDLib подтвердил authorizationStateReady
 *
 * API-токен (store.isAuthenticated()) НЕ ТРЕБУЕТСЯ — он нужен только
 * для отдельных бэкенд-операций (upload init), но не для базовой
 * авторизации модулей. После TDLib-входа все модули должны работать.
 *
 * Используется модулями, которым нужен TDLib (DownloadPage — Fast Path).
 */
export function isFullyAuthenticated(): boolean {
  return _appAuthenticated && isTdlibUserAuthorized();
}

/**
 * Проверка: есть ли действующий API Bearer token.
 *
 * Достаточно для операций, не требующих TDLib:
 * - SearchPage (только API поиск)
 * - UploadPage (MTProto upload, API uploadInit/part/complete)
 *
 * НЕ достаточно если операция использует TDLib JSON FFI.
 */
export function isApiAuthenticated(): boolean {
  return store.isAuthenticated();
}

/**
 * Универсальная проверка авторизации с логированием.
 *
 * Вызывается в начале каждой операции, требующей полной авторизации.
 * Если авторизация отсутствует — пишет сообщение в лог (через
 * переданную функцию log) и возвращает false.
 *
 * @param log - функция логирования из модуля (this.log)
 * @returns true если авторизован, false если нет
 */
export function requireAuth(log?: (msg: string, type: string) => void): boolean {
  if (isFullyAuthenticated()) return true;
  const msg = t("common.auth_required");
  if (log) {
    log(msg, "error");
  } else {
    console.error("[auth]", msg);
  }
  return false;
}

/**
 * Получить Telegram ID текущего пользователя из сохранённой сессии.
 *
 * @returns tg_id или 0 если пользователь не авторизован
 */
export function getCurrentTgId(): number {
  return store.get()?.tg_id ?? 0;
}
