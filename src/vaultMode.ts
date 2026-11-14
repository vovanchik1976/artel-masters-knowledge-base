/**
 * Глобальное состояние режима личного хранилища (Vault).
 *
 * Desktop работает в двух контекстах:
 *   - public  — «Публичное поле» (общий каталог, обычные вкладки);
 *   - personal — «Личный кабинет» (тот же UI, но операции идут по личному реестру).
 *
 * Переключатель в шапке + баннер. Singleton (как auth.ts).
 * SPEC: docs/ARCHITECTURE_VAULT_STORAGE.md §0.5.
 */

export type VaultScope = "public" | "personal";

let _scope: VaultScope = "public";
let _entitled: boolean = false;      // есть ли активный entitlement
let _expiresAt: string | null = null;
let _vaultEnabled: boolean = false;  // сервер подтвердил, что юзер имеет право

const _listeners = new Set<(scope: VaultScope) => void>();

export function getVaultScope(): VaultScope {
  return _scope;
}

export function isPersonalScope(): boolean {
  return _scope === "personal";
}

export function isVaultEntitled(): boolean {
  return _entitled;
}

/** Установить entitlement-статус из /desktop/vault/status. */
export function setVaultEntitlement(status: {
  is_active: boolean;
  expires_at: string | null;
} | null): void {
  _entitled = !!status?.is_active;
  _expiresAt = status?.expires_at ?? null;
  _vaultEnabled = !!status?.is_active;
  // Если доступ пропал — принудительно в публичное поле.
  if (!_entitled && _scope === "personal") {
    setVaultScope("public");
  }
}

/** Переключить режим. Возвращает новый scope (или текущий, если нельзя). */
export function setVaultScope(scope: VaultScope): VaultScope {
  if (scope === "personal" && !_vaultEnabled) {
    // Нет права личного хранилища — не даём войти в личный кабинет.
    return _scope;
  }
  if (_scope === scope) return _scope;
  _scope = scope;
  _listeners.forEach((cb) => cb(_scope));
  return _scope;
}

/** Подписка на смену режима (для перерисовки SearchPage/UploadPage). */
export function subscribeVault(cb: (scope: VaultScope) => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function vaultExpiresAt(): string | null {
  return _expiresAt;
}
