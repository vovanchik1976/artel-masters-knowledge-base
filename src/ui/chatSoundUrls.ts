/**
 * Звуковые файлы уведомлений: id → URL в сборке.
 *
 * `?url` заставляет Vite положить wav в `dist-renderer/assets` с хешем и вернуть
 * ОТНОСИТЕЛЬНЫЙ путь. Это важно: релизный renderer открывается через `file://`,
 * и абсолютный путь («/audio/ping.wav») указал бы в корень диска
 * (BUG-ELECTRON-ASSET-001 — так уже пропадали 3D-иконки).
 *
 * `Record<ChatSoundId, string>` — инвариант полноты: добавили id в `CHAT_SOUND_IDS`,
 * но забыли файл/импорт → падает СБОРКА, а не наступает тишина у мастера.
 */
import dropUrl from "../../public/audio/water-drop.wav?url";
import chimeUrl from "../../public/audio/chime.wav?url";
import pingUrl from "../../public/audio/ping.wav?url";
import knockUrl from "../../public/audio/knock.wav?url";
import tripleUrl from "../../public/audio/triple.wav?url";
import alertUrl from "../../public/audio/alert.wav?url";
import { DEFAULT_CHAT_SOUND_ID, isChatSoundId, type ChatSoundId } from "../../shared/chatSettings";

const URLS: Record<ChatSoundId, string> = {
  drop: dropUrl,
  chime: chimeUrl,
  ping: pingUrl,
  knock: knockUrl,
  triple: tripleUrl,
  alert: alertUrl,
};

/** URL звука по id; неизвестный id → дефолт (сигнал обязан звучать). */
export function chatSoundUrl(id: unknown): string {
  return URLS[isChatSoundId(id) ? id : DEFAULT_CHAT_SOUND_ID];
}
