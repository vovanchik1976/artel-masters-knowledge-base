/**
 * Настройки чатов — локальный файл на компьютере (`userData/chat-settings.json`).
 *
 * `version` остаётся **1** намеренно: `sound_id` добавлен АДДИТИВНО (2026-10-31,
 * поручение владельца «добавляем выбор озвучки»). Совместимость в обе стороны:
 *   • старый клиент на новом файле читает два флага и игнорирует звук;
 *   • новый клиент на старом файле берёт звук по умолчанию.
 * Поэтому бамп версии/миграция не нужны, а флаги мастера не теряются.
 *
 * Звук — только из закрытого набора `CHAT_SOUND_IDS`. Неизвестный/битый id ВСЕГДА
 * приводится к дефолту (`normalizeChatSoundId`): тишина вместо сигнала — дефект,
 * а не «безопасность» (мастер пропускает сообщения).
 */
export const CHAT_SOUND_IDS = ['drop','chime','ping','knock','triple','alert'] as const;
export type ChatSoundId = typeof CHAT_SOUND_IDS[number];
export const DEFAULT_CHAT_SOUND_ID: ChatSoundId = 'drop';

export interface ChatSettings { version:1; sound_enabled:boolean; notifications_enabled:boolean; sound_id:ChatSoundId }
export const DEFAULT_CHAT_SETTINGS:Readonly<ChatSettings> = Object.freeze({version:1,sound_enabled:true,notifications_enabled:true,sound_id:DEFAULT_CHAT_SOUND_ID});

export function isChatSoundId(value:unknown): value is ChatSoundId {
  return typeof value==='string' && (CHAT_SOUND_IDS as readonly string[]).includes(value);
}
/** Неизвестный/отсутствующий id → дефолт: уведомление обязано звучать. */
export function normalizeChatSoundId(value:unknown): ChatSoundId {
  return isChatSoundId(value)?value:DEFAULT_CHAT_SOUND_ID;
}

export function validChatFlags(value:unknown): value is Pick<ChatSettings,'sound_enabled'|'notifications_enabled'> {
  if(!value || typeof value!=='object') return false;
  const flags=value as Record<string,unknown>;
  return typeof flags.sound_enabled==='boolean' && typeof flags.notifications_enabled==='boolean';
}

