/**
 * DownloadStallWatchdog — страховка UI от «вечного ⏳ Соединение…»
 * (BUG-DOWNLOAD-049).
 *
 * Зачем: движок может замолчать надолго (обрыв сети во время
 * `downloadFile{synchronous:true}`, зависший воркер) — тогда события
 * `tdlib-multi-download-progress` прекращаются, TransferMeter уходит в
 * «stalled», а промис загрузки ждёт терминального события бесконечно.
 * Этот класс решает ровно одну задачу: «пора автоматически повторить
 * загрузку (в рамках оплаченного lease) или показать панель retry».
 *
 * Принципы:
 *  1. Часы инъекцируются (`now`) — детерминированные unit-тесты.
 *  2. Прогресс (`progress()`) пере-взводит окно, но НЕ обнуляет счётчик
 *     попыток: иначе «мигающая» сеть давала бы бесконечный auto-retry.
 *  3. Без сети (`connectionStateWaitingForNetwork`) retry бессмыслен —
 *     пере-качка части всё равно ждёт сеть; ждём `connectionStateReady`.
 *  4. Состояние соединения неизвестно (событие не приходило) → считаем
 *     «онлайн»: страховка не должна зависеть от наличия события.
 *  5. `give-up` латчится: панель «Повторити безкоштовно» показывается один раз.
 *
 * Канон поведения: [`docs/BUGS.md`](../../BUGS.md) → BUG-DOWNLOAD-049.
 */

export type StallAction = "wait" | "retry" | "give-up";

export interface DownloadStallWatchdogOptions {
  /** Порог обрыва, мс (default 90000 — с запасом над Rust-watchdog'ом 60с). */
  stallMs?: number;
  /** Максимум авто-retry за операцию (default 3). */
  maxAttempts?: number;
  /** Часы (ms). По умолчанию performance.now()/Date.now(). */
  now?: () => number;
}

/** Состояние TDLib-соединения, при котором сеть работоспособна. */
const CONNECTION_READY = "connectionStateReady";

export class DownloadStallWatchdog {
  private readonly nowFn: () => number;
  private readonly stallMs: number;
  private readonly maxAttempts: number;

  /** Время последнего сигнала прогресса (ms). */
  private lastProgressAt = 0;
  private _attempts = 0;
  private _exhausted = false;
  /** Последнее состояние соединения от TDLib ("" — событие не приходило). */
  private _connState = "";

  constructor(options: DownloadStallWatchdogOptions = {}) {
    this.nowFn =
      options.now ??
      (typeof performance !== "undefined" && performance.now
        ? () => performance.now()
        : () => Date.now());
    this.stallMs = options.stallMs ?? 90_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.lastProgressAt = this.nowFn();
  }

  /** Сколько авто-retry уже сделано (для логов и тестов). */
  get attempts(): number {
    return this._attempts;
  }

  /** true — TDLib со сетью (retry осмыслен). Неизвестное состояние → true. */
  get online(): boolean {
    return this._connState === "" || this._connState === CONNECTION_READY;
  }

  /** Новая операция: окно заново, счётчик и латч `give-up` сброшены. */
  reset(): void {
    this.lastProgressAt = this.nowFn();
    this._attempts = 0;
    this._exhausted = false;
  }

  /** Сигнал прогресса: байты/событие от движка. Окно пере-взводится. */
  progress(): void {
    this.lastProgressAt = this.nowFn();
  }

  /** Состояние соединения из receive-loop (`tdlib-connection-state`). */
  connectionState(state: string): void {
    this._connState = state ?? "";
  }

  /**
   * Проверка по таймеру. Возвращает:
   *  - `retry`   — обрыв дольше окна: пере-запустить загрузку (lease-повтор);
   *  - `give-up` — попытки исчерпаны: показать панель retry пользователю;
   *  - `wait`    — обрыва нет / нет сети / уже отдали панель.
   */
  check(): StallAction {
    if (this._exhausted) return "wait";
    if (!this.online) return "wait";
    const now = this.nowFn();
    if (now - this.lastProgressAt <= this.stallMs) return "wait";
    if (this._attempts >= this.maxAttempts) {
      this._exhausted = true;
      return "give-up";
    }
    this._attempts += 1;
    // Следующий retry — только после нового полного окна без прогресса.
    this.lastProgressAt = now;
    return "retry";
  }
}
