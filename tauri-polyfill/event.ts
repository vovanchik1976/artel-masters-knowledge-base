/**
 * Полифилл @tauri-apps/api/event → window.fwCloud.listen.
 *
 * mainline UI слушает события (tdlib-auth-state, tdlib-download-progress и т.д.)
 * через listen(event, handler). Здесь мы поверх моста: подписка регистрируется
 * в main (EventEmitter), а события от sidecar/UI доставляются через
 * webContents.send → preload.on → handler.
 */

/** Тип события, совместимый с tauri Event<T>. */
export interface Event<T = unknown> {
  event: string;
  id: number;
  payload: T;
}

export type UnlistenFn = () => void;

/**
 * listen(event, handler) → Promise<UnlistenFn>.
 * В M3 (копия интерфейса) подписка регистрируется через window.fwCloud.listen,
 * доставка событий появится вместе с sidecar-событиями (M1-протокол).
 */
export async function listen<T = unknown>(event: string, handler: (e: Event<T>) => void): Promise<UnlistenFn> {
  const api = (window as unknown as { fwCloud?: { listen: (ev: string, cb: (payload: unknown) => void) => () => void } }).fwCloud;
  if (!api) {
    // Если моста нет — возвращаем noop, чтобы UI не падал при старте.
    console.warn(`[tauri-polyfill/event] fwCloud недоступен, listen("${event}") — noop`);
    return () => {};
  }
  const unlisten = api.listen(event, (payload) => {
    handler({ event, id: 0, payload: payload as T });
  });
  return unlisten;
}
