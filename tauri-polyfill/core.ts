/**
 * Полифилл @tauri-apps/api/core → window.fwCloud (Electron IPC мост).
 *
 * Единственное назначение: скопированный 1:1 UI mainline (desktop/src)
 * продолжает импортировать `invoke` из "@tauri-apps/api/core", а здесь мы
 * даём ту же сигнатуру поверх bridge-моста desktop-electron. Исходники UI
 * НЕ правятся — ремап делается через vite alias + tsconfig paths.
 */

/**
 * invoke(cmd, args) — аналог tauri::core.invoke.
 * Маршрутизирует tauri-имя команды (напр. "tdlib_start_runtime", "get_path_info")
 * в мост main, где команда диспетчеризуется (sidecar / Electron main / NOT_IMPLEMENTED).
 * При ok:false бросает Error с текстом (как tauri-rejection).
 */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = (window as unknown as { fwCloud?: { invoke: <R>(c: string, a?: Record<string, unknown>) => Promise<R> } }).fwCloud;
  if (!api) {
    throw new Error("fwCloud bridge недоступен (preload не загрузился?)");
  }
  return api.invoke<T>(cmd, args ?? {});
}
