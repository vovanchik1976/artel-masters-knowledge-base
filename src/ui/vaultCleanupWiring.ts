/**
 * Боевая обвязка уборки копии личного файла (паттерн MediaFetchWiring).
 *
 * Вынесено из `vaultCleanup.ts` намеренно: тестируемый модуль не должен тянуть
 * `tauri-polyfill` и `api` (в `tsconfig.tests.json` их нет — node:test упал бы
 * на импорте). Здесь — единственное место, где уборка знает про сервер и TDLib.
 */

import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { ChatCopyRemovalDeps } from "./vaultCleanup";

/**
 * Боевые зависимости уборки: запись личного файла удаляется на сервере,
 * сообщения-документы — клиентом (TDLib `tdlib_delete_messages`; бот не может
 * удалить сообщение в личке юзера — ограничение Telegram).
 */
export function liveChatCopyRemovalDeps(): ChatCopyRemovalDeps {
  return {
    deleteFile: (pfId: number) => api.vaultDelete(pfId),
    deleteMessages: async (chatId: number, messageIds: number[]) => {
      await invoke("tdlib_delete_messages", { chatId, messageIds });
    },
  };
}
