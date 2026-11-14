/**
 * Плеер звуков уведомлений чатов (D-144) — единственная точка воспроизведения.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ТРИ МЕТОДА В `App`:
 *   1. поведение (повтор клика, наложение, autoplay-отказ, стоп при выходе)
 *      проверяется реальными тестами на фейковом `Audio` — DOM в `node:test` нет,
 *      поэтому фабрика элемента инжектится;
 *   2. здесь живёт инвариант, на котором уже обожглись (BUG-CHAT-SOUND-PREVIEW-001):
 *      **`HTMLMediaElement.load()` НЕЛЬЗЯ звать на играющем элементе** — по спеке
 *      он прерывает текущее воспроизведение. Именно так «проба звука» из Настроек
 *      обрывалась через несколько миллисекунд: клик запускал пробу, а сохранение
 *      настроек тут же звало `load()` на том же элементе → владелец видел «через раз».
 *
 * Прогрев выбранного звука делается СОЗДАНИЕМ элемента (`new Audio` + `preload`),
 * а не `load()`: элемент начинает грузиться сам и никого не глушит.
 */
import { DEFAULT_CHAT_SOUND_ID, normalizeChatSoundId, type ChatSoundId } from "../../shared/chatSettings";

/**
 * Минимум от `HTMLAudioElement`, который нужен плееру.
 * Нарочно НЕ включает `load()` — если он понадобится, тест P8 упадёт и заставит
 * сначала объяснить, зачем обрывать воспроизведение.
 */
export interface ChatAudioLike {
  preload: string;
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

/** Как создать элемент для id: боевой `new Audio(chatSoundUrl(id))` или фейк в тестах. */
export type ChatAudioFactory = (id: ChatSoundId) => ChatAudioLike;

export class ChatSoundPlayer {
  private current: ChatSoundId = DEFAULT_CHAT_SOUND_ID;
  /** Один элемент на id: повтор клика перематывает его, а не создаёт новый. */
  private readonly cache = new Map<ChatSoundId, ChatAudioLike>();

  constructor(private readonly createAudio: ChatAudioFactory) {}

  /** Текущий (сохранённый в настройках) звук — им сигналит уведомление. */
  get id(): ChatSoundId {
    return this.current;
  }

  /**
   * Сохранённый звук прочитан/изменён: запоминаем и прогреваем.
   *
   * ВАЖНО: играющее воспроизведение здесь не трогается вообще (ни `pause`, ни
   * `load`). Этим вызовом заканчивается сохранение настроек, то есть он приходит
   * ровно в момент, когда звучит проба выбранного звука.
   */
  apply(id: unknown): void {
    const next = normalizeChatSoundId(id);
    this.current = next;
    this.audio(next); // прогрев: элемент создаётся и грузится сам (preload)
  }

  /**
   * Проиграть звук (по умолчанию — сохранённый).
   *
   * Остальные элементы глушим: быстрый перебор шести звуков иначе звучал бы
   * «хором» и мастер не понял бы, что выбрал.
   */
  play(id: unknown = this.current): void {
    const sound = normalizeChatSoundId(id);
    for (const [other, audio] of this.cache) {
      if (other !== sound) this.silence(audio);
    }
    const audio = this.audio(sound);
    this.rewind(audio);
    // `play()` может быть отвергнут политикой autoplay — это не ошибка мастера,
    // сигнал не критичен: глушим reject, чтобы обработчик клика не падал.
    try {
      const started = audio.play();
      if (started && typeof started.catch === "function") started.catch(() => {});
    } catch {
      /* синхронный отказ (нет источника/не поддерживается) — молчим осознанно */
    }
  }

  /** Выход из аккаунта / стоп мониторинга: всё молчит, включая пробу. */
  stopAll(): void {
    for (const audio of this.cache.values()) this.silence(audio);
  }

  private audio(id: ChatSoundId): ChatAudioLike {
    let audio = this.cache.get(id);
    if (!audio) {
      audio = this.createAudio(id);
      this.cache.set(id, audio);
    }
    return audio;
  }

  private silence(audio: ChatAudioLike): void {
    try {
      audio.pause();
    } catch {
      /* элемент ещё не готов — пауза не нужна */
    }
    this.rewind(audio);
  }

  private rewind(audio: ChatAudioLike): void {
    try {
      audio.currentTime = 0;
    } catch {
      /* метаданные не загружены — сыграет с начала сам */
    }
  }
}
