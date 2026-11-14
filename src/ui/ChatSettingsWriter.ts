/**
 * Очередь записи настроек чата (D-144) — «последнее намерение побеждает».
 *
 * ЗАЧЕМ (BUG-CHAT-SOUND-PREVIEW-001, репорт владельца «через раз и неправильно»):
 *   • страница писала прямо из обработчика клика и защищалась флагом `busy`,
 *     поэтому ВТОРОЙ клик по звуку молча терялся, пока шла запись первого —
 *     а мастер как раз перебирает шесть звуков на слух;
 *   • два параллельных `chat_settings_set` переставляются местами: значение
 *     в `this.value` определял ответ, пришедший ПОСЛЕДНИМ, а не последний клик.
 *
 * Здесь одна точка записи: изменения накапливаются, уходят по одному, а всё,
 * что нажали во время записи, схлопывается в следующий шаг. Никаких «тихих»
 * потерь клика и никакой гонки ответов.
 */
import type { ChatSettings } from "../../shared/chatSettings";

/** Что нужно очереди от страницы настроек (DOM сюда не протекает — тестируется без браузера). */
export interface ChatSettingsWriterPort {
  /** Текущее известное значение (то, от чего считаем патч). */
  current(): ChatSettings;
  /** Записать и вернуть то, что реально сохранено (сервер — источник истины). */
  save(next: ChatSettings): Promise<ChatSettings>;
  /** Запись удалась: значение можно применять в UI/звуке. */
  applied(value: ChatSettings): void;
  /** Запись не удалась: UI обязан показать честный статус, а не делать вид, что сохранил. */
  failed(): void;
}

/** Сравниваем только реально записываемые поля: иначе «пустая» запись уходила бы на диск. */
function sameValue(a: ChatSettings, b: ChatSettings): boolean {
  return (
    a.sound_enabled === b.sound_enabled &&
    a.notifications_enabled === b.notifications_enabled &&
    a.sound_id === b.sound_id
  );
}

export class ChatSettingsWriter {
  private pending: Partial<ChatSettings> | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly port: ChatSettingsWriterPort) {}

  /**
   * Поставить изменение в очередь. Возвращает промис завершения (можно не ждать
   * из обработчика клика — важно лишь, чтобы ошибки не всплывали наружу).
   */
  async submit(patch: Partial<ChatSettings>): Promise<void> {
    // Патчи склеиваем: повторные клики по разным звукам не дают шесть записей.
    this.pending = { ...(this.pending ?? {}), ...patch };
    if (this.running) {
      await this.whenIdle();
      return;
    }
    await this.drain();
  }

  /** Дождаться, пока очередь опустеет (тесты и честная индикация «сохраняю»). */
  whenIdle(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending) {
        const patch = this.pending;
        this.pending = null;
        const next: ChatSettings = { ...this.port.current(), ...patch };
        if (sameValue(next, this.port.current())) continue;
        try {
          this.port.applied(await this.port.save(next));
        } catch {
          // Отказ записи: очередь не крутим дальше по этому намерению и честно
          // сообщаем наверх. Следующий клик снова попробует записать.
          this.pending = null;
          this.port.failed();
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
