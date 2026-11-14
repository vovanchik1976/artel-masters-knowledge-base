/**
 * Shared IPC-контракт (Electron-версия, Win7/8 порт).
 *
 * Мост «окно / fs / диалоги / sidecar / tauri-команды». UI mainline скопирован
 * 1:1 и вызывает tauri-команды (invoke) и события (listen). Чтобы НЕ править
 * скопированный UI, команда — просто строка (имя tauri-команды), а main
 * диспетчеризует её: sidecar (engine.*) / Electron main (fs/dialog/url) /
 * NOT_IMPLEMENTED (TDLib — до рубежа M4).
 *
 * Схема: renderer → window.fwCloud.* (contextBridge в preload) →
 * ipcRenderer.invoke(IPC_CHANNEL, {cmd, args}) → ipcMain.handle в main.
 */

/** Имя канала обобщённого IPC-вызова (main ↔ preload ↔ renderer). */
export const IPC_CHANNEL = "fw:call";

/**
 * Команда моста — произвольная строка (имя tauri-команды mainline).
 * Известные группы (для навигации, не исчерпывающий список):
 *   - fs/scan/hash/archive: get_path_info, read_file_bytes, write_file_bytes,
 *     scan_and_hash, sha256_file, create_archive, extract_archive, ...
 *   - dialog/url: window.showOpenDialog, window.showSaveDialog,
 *     window.showMessageBox, open_url
 *   - TDLib (до M4 → NOT_IMPLEMENTED): tdlib_start_runtime, tdlib_qr_login, ...
 */
export type BridgeCommand = string;

/** Обёртка вызова через IPC. */
export interface BridgeRequest {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Успешный ответ моста (унифицировано под invoke Promise-модель). */
export interface BridgeOk<T = unknown> {
  ok: true;
  value: T;
}

/** Ошибочный ответ моста (имитация tauri error-rejection). */
export interface BridgeErr {
  ok: false;
  error: string;
}

export type BridgeResult<T = unknown> = BridgeOk<T> | BridgeErr;

/** API, который preload экспонирует в window. */
export interface FwCloudApi {
  /** Обобщённый invoke-мост (полифилл tauri::core.invoke). */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Подписка на события (полифилл tauri listen). */
  listen(event: string, cb: (payload: unknown) => void): () => void;
  /** Версия API-моста (для отладки). */
  bridgeVersion: string;
}

/** Каталог имён tauri-команд, которые диспетчеризуются в Electron main (не sidecar). */
export const MAIN_SIDE_COMMANDS = new Set<string>([
  "window.showOpenDialog",
  "window.showSaveDialog",
  "window.showMessageBox",
  "open_url",
  // GEO_Unlock (вкладка «Інструменти»): ядра живут в main-процессе (TypeScript),
  // sidecar для них не нужен — см. electron/geo-unlock/.
  "geo_samsung_scan",
  "geo_samsung_patch",
  "geo_lg_scan",
  "geo_lg_patch",
]);
