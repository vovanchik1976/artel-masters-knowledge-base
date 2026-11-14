/**
 * Уборка копии личного файла из чата с ботом — после успешного скачивания
 * (решение владельца 2026-11-10, вариант «Б»).
 *
 * Зачем: личное хранилище ARTEL — это указатели на документы в личке с ботом
 * (сервер байты не хранит). Когда юзер забрал файл на диск, копия в чате
 * больше не нужна для «своего» сценария, и чат с ботом превращается в свалку
 * (для файлов >2 ГБ там десятки сообщений-частей). Поэтому после загрузки
 * ARTEL предлагает убрать копию одним тапом.
 *
 * Что при этом происходит (честно):
 *   * запись личного файла удаляется из реестра (`personal_files.is_deleted`) —
 *     файл пропадает из ARTEL (как при кнопке «Удалить из личного»);
 *   * сообщения-документы удаляются из PM самим клиентом (TDLib
 *     `tdlib_delete_messages`) — бот не может удалить сообщение в личке
 *     юзера (это ограничение Telegram: удалять может участник чата);
 *   * повторно скачать такой файл уже нельзя — копии нет ни в чате, ни в ARTEL.
 *
 * Тестируемый модуль намеренно НЕ тянет сетевой/tauri-мост (в
 * `tsconfig.tests.json` их нет — node:test упал бы на импорте): боевые
 * зависимости вынесены в `vaultCleanupWiring.ts` (паттерн MediaFetchWiring).
 */

/** Координаты PM-сообщений для self-delete (ответ `POST /desktop/vault/files/{id}/delete`). */
export interface VaultPmDelete {
  chat_id: number;
  message_ids: number[];
}

/** Внешние эффекты уборки (внедряются — так тест не ходит в сеть). */
export interface ChatCopyRemovalDeps {
  /** Удалить запись личного файла на сервере; сервер вернёт pm_delete. */
  deleteFile: (pfId: number) => Promise<{
    pm_delete?: VaultPmDelete | null;
    /** BUG-PERSONAL-DELETE-001: «уже удалено» (идемпотентный повтор/призрак). */
    already_deleted?: boolean;
  }>;
  /** Удалить сообщения в PM клиентом (TDLib). */
  deleteMessages: (chatId: number, messageIds: number[]) => Promise<void>;
}

/** Итог уборки копии. */
export interface ChatCopyRemovalResult {
  /** true — запись в ARTEL убрана (файл больше не в списке). */
  removed: boolean;
  /** Сколько сообщений удалено из чата. */
  messages: number;
  /** Текст ошибки, если что-то пошло не так. */
  error?: string;
}

function _errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e ?? "unknown");
}

/**
 * Убрать копию личного файла: запись в ARTEL + сообщения в чате с ботом.
 *
 * Порядок именно такой: сначала сервер (реестр), затем клиент (PM-сообщения).
 * Если удаление сообщений не удалось — запись в ARTEL всё равно убрана, а
 * ошибка возвращается наружу (пользователю покажем честное сообщение).
 */
export async function removePersonalChatCopy(
  pfId: number,
  deps: ChatCopyRemovalDeps,
): Promise<ChatCopyRemovalResult> {
  let pmDelete: VaultPmDelete | null = null;
  try {
    const resp = await deps.deleteFile(pfId);
    if (resp?.already_deleted) {
      // Запись уже удалена (идемпотентный повтор) — убирать нечего (BUG-PERSONAL-DELETE-001).
      return { removed: true, messages: 0 };
    }
    pmDelete = resp?.pm_delete ?? null;
  } catch (e) {
    if ((e as { status?: number })?.status === 404) {
      // Сервер: записи уже нет («призрак» индекса / повтор) — это успех.
      return { removed: true, messages: 0 };
    }
    return { removed: false, messages: 0, error: _errText(e) };
  }

  if (!pmDelete || !pmDelete.chat_id || !pmDelete.message_ids?.length) {
    // Копии в чате нет (или сервер её не отдал) — запись уже убрана, всё чисто.
    return { removed: true, messages: 0 };
  }

  try {
    await deps.deleteMessages(pmDelete.chat_id, pmDelete.message_ids);
  } catch (e) {
    return { removed: false, messages: 0, error: _errText(e) };
  }
  return { removed: true, messages: pmDelete.message_ids.length };
}

/** Параметры модалки «убрать копию из чата». */
export interface RemoveChatCopyPromptOptions {
  /** Текст предупреждения (уже переведённый). */
  text: string;
  /** Подпись кнопки «убрать». */
  removeLabel: string;
  /** Подпись кнопки «оставить». */
  keepLabel: string;
  /** Нажали «убрать». */
  onRemove: () => void;
  /** Нажали «оставить» / закрыли. */
  onKeep: () => void;
}

/**
 * Модалка «убрать копию из чата с ботом?».
 *
 * Показывается сразу после успешного скачивания. Кнопка «Оставить» запоминается
 * вызывающим (файл больше не спрашиваем в этой сессии).
 */
export function promptRemoveChatCopy(opts: RemoveChatCopyPromptOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "vault-chat-copy-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;" +
    "align-items:center;justify-content:center;z-index:9999;";
  overlay.innerHTML = `
    <div style="background:var(--bg,#12121a);border:1px solid var(--border);border-radius:12px;
                padding:16px;max-width:420px;width:92%;">
      <div style="font-weight:600;margin-bottom:8px;">🧹</div>
      <div style="font-size:13px;line-height:1.45;margin-bottom:14px;">${opts.text}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary vault-chat-copy-keep">${opts.keepLabel}</button>
        <button class="btn btn-primary vault-chat-copy-remove">${opts.removeLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay
    .querySelector(".vault-chat-copy-remove")
    ?.addEventListener("click", () => {
      close();
      opts.onRemove();
    });
  overlay.querySelector(".vault-chat-copy-keep")?.addEventListener("click", () => {
    close();
    opts.onKeep();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
      opts.onKeep();
    }
  });
}
