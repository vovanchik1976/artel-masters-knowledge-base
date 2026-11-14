/**
 * Electron preload — мост между renderer (изолированный мир) и main.
 *
 * Экспонирует window.fwCloud (см. shared/ipc.ts: FwCloudApi). Renderer НЕ имеет
 * прямого доступа к Node — только через contextBridge.
 *
 * invoke(cmd, args) → ipcRenderer.invoke(IPC_CHANNEL, {cmd, args}) → main-диспетчер;
 * ok:false → бросок (имитация tauri-rejection).
 * listen(event, cb) → подписка на события из main (доставка событий sidecar — M1+);
 * возвращает unlisten.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNEL, type FwCloudApi, type BridgeResult } from "../shared/ipc";

/** Обёртка над ipcRenderer.invoke с имитацией tauri: ok:false → reject. */
async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const res = (await ipcRenderer.invoke(IPC_CHANNEL, { cmd, args: args ?? {} })) as BridgeResult<T>;
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

/**
 * Подписка на события. main шлёт события через webContents.send(`fw:event:${name}`, payload);
 * здесь маршрутизируем по имени в соответствующие обработчики.
 */
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on("fw:event", (_evt: IpcRendererEvent, name: string, payload: unknown) => {
  const set = eventHandlers.get(name);
  if (set) for (const cb of set) cb(payload);
});

function listen(event: string, cb: (payload: unknown) => void): () => void {
  if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
  eventHandlers.get(event)!.add(cb);
  return () => {
    eventHandlers.get(event)?.delete(cb);
  };
}

const api: FwCloudApi = {
  invoke,
  listen,
  bridgeVersion: "0.1.0",
};

contextBridge.exposeInMainWorld("fwCloud", api);
