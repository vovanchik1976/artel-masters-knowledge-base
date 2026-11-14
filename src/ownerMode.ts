/**
 * Глобальный флаг «текущий пользователь = владелец (OWNER_ID)».
 *
 * Отдельный от vaultMode (public/personal) и от auth: owner-backdoor — это НЕ
 * третий режим личного хранилища, а независимый скрытый инструмент владельца.
 * Устанавливается App.ts из /desktop/app-state → user.is_owner.
 *
 * SPEC: docs/ARCHITECTURE_VAULT_STORAGE.md §0.9/§6.1; T6.4;
 *       docs/ARCHITECTURE_VAULT_OWNER_DESKTOP_UI.md.
 */

let _isOwner = false;

/** Является ли текущий аутентифицированный пользователь владельцем. */
export function isOwner(): boolean {
  return _isOwner;
}

/** Установить флаг владельца (из app-state user.is_owner). */
export function setOwner(v: boolean): void {
  _isOwner = v;
}
