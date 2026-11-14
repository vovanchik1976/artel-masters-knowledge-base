/**
 * TransferMeter — единственный источник оценки скорости и ETA для
 * upload/download (Task 1 «взрослого» ETA, см. docs/ETA_TRANSFER_METER.md).
 *
 * Заменяет три разрозненных расчёта (Rust EMA / медиана мгновенных в
 * ProgressUI / pass-through eta_secs из событий) одним честным измерителем.
 *
 * Принципы:
 *  1. Движок шлёт только сырые счётчики (bytes, время). Вся математика — здесь.
 *  2. Скорость = наклон линейной регрессии (OLS) по скользящему
 *     wall-clock окну (~20с). Паузы между частями (cooldown, getRemoteFile,
 *     merge) принадлежат окну так же, как байты → ETA перестаёт врать.
 *  3. До набора окна — EWMA-сид (tau ~2с), затем средняя с начала передачи.
 *  4. Stall-детекция по wall-clock: нет прироста байт > stallSec → состояние
 *     "stalled" (ETA скрыт, а не заморожен). Работает БЕЗ входящих событий —
 *     snapshot() лениво пересчитывает состояние по текущему времени.
 *  5. Рестарт попытки (bytes уменьшились — resume с частичного offset) сбрасывает
 *     историю, иначе смешение попыток искажает оценку.
 *
 * Часы инъекцируются (now) — детерминированные unit-тесты (tests/).
 */

export type TransferState = "idle" | "running" | "stalled";

export interface TransferMeterOptions {
  /** Часы (ms). По умолчанию performance.now()/Date.now() — для тестов инъекция. */
  now?: () => number;
  /** Длина скользящего окна регрессии, с (default 20). */
  windowSec?: number;
  /** Минимум точек в окне, чтобы доверять OLS (default 3). */
  minWindowPoints?: number;
  /** Минимальный временной размах окна, с (default 2). */
  minWindowSpanSec?: number;
  /** Порог stall: нет прироста байт N с → "stalled" (default 8). */
  stallSec?: number;
  /** Постоянная времени EWMA-сида, с (default 2). */
  ewmaTauSec?: number;
}

export interface MeterSnapshot {
  state: TransferState;
  bytesDone: number;
  bytesTotal: number;
  /** Сглаженная скорость, байт/с (0 — неизвестна). */
  speedBps: number;
  /** Оценка остатка времени, с. null — неизвестна/не применима/stalled. */
  etaSec: number | null;
  elapsedSec: number;
  /** Сырой процент 0..100 (без фазовых маппингов — они на стороне UI). */
  percent: number;
}

interface Sample {
  /** Время отчёта, ms (по инъектированным часам). */
  t: number;
  /** Абсолютные байты на момент отчёта. */
  b: number;
}

const MAX_SAMPLES = 1200; // защита от бесконечной передачи с плотными событиями

export class TransferMeter {
  private readonly nowFn: () => number;
  private readonly windowMs: number;
  private readonly minPoints: number;
  private readonly minSpanMs: number;
  private readonly stallMs: number;
  private readonly ewmaTauSec: number;

  private samples: Sample[] = [];
  private bytesTotal = 0;
  private baseBytes = 0; // offset сессии (startBytes при begin/рестарте)
  private lastBytes = 0;
  private lastTs = 0;
  private startTs = 0;
  private lastProgressTs = 0; // последний прирост байт (для stall)
  private ewmaBps = 0;
  private state: TransferState = "idle";
  private finished = false;

  constructor(options: TransferMeterOptions = {}) {
    this.nowFn =
      options.now ??
      (typeof performance !== "undefined" && performance.now
        ? () => performance.now()
        : () => Date.now());
    this.windowMs = (options.windowSec ?? 20) * 1000;
    this.minPoints = options.minWindowPoints ?? 3;
    this.minSpanMs = (options.minWindowSpanSec ?? 2) * 1000;
    this.stallMs = (options.stallSec ?? 8) * 1000;
    this.ewmaTauSec = options.ewmaTauSec ?? 2;
  }

  /** Начать новую сессию передачи. startBytes — частичный offset (resume). */
  begin(totalBytes: number, startBytes = 0): void {
    this.samples = [];
    this.bytesTotal = Math.max(0, totalBytes);
    this.baseBytes = Math.max(0, startBytes);
    this.lastBytes = this.baseBytes;
    const now = this.nowFn();
    this.startTs = now;
    this.lastTs = now;
    this.lastProgressTs = now;
    this.ewmaBps = 0;
    this.state = "running";
    this.finished = false;
  }

  /** Сброс в начало (новая попытка с нуля). */
  reset(totalBytes = 0): void {
    this.begin(totalBytes, 0);
  }

  /** Терминальное состояние: успешный конец/ошибка/отмена со стороны UI. */
  finish(): void {
    this.finished = true;
    this.state = "idle";
  }

  /**
   * Зарегистрировать текущий абсолютный прогресс (байты). Время берётся из часов.
   * Повторные отчёты с теми же байтами валидны (фиксируют время без прогресса).
   */
  report(bytesDone: number): void {
    if (this.finished) return;
    const now = this.nowFn();

    // Рестарт попытки: байты уменьшились (resume с меньшего offset) или
    // report до begin → чистая новая сессия с этого offset.
    if (this.state === "idle" || bytesDone < this.lastBytes) {
      this.begin(this.bytesTotal, Math.max(0, bytesDone));
      if (bytesDone <= 0) return; // нулевой offset — больше нечего фиксировать
    }

    this.samples.push({ t: now, b: bytesDone });
    this.prune(now);

    const dtSec = (now - this.lastTs) / 1000;
    const dBytes = bytesDone - this.lastBytes;
    if (dtSec > 0 && dBytes > 0) {
      this.lastProgressTs = now;
      const instant = dBytes / dtSec;
      const alpha = 1 - Math.exp(-dtSec / this.ewmaTauSec);
      this.ewmaBps =
        this.ewmaBps === 0
          ? instant
          : this.ewmaBps + alpha * (instant - this.ewmaBps);
    }

    this.lastBytes = bytesDone;
    this.lastTs = now;
  }

  /**
   * Снимок состояния. Ленивый: stall вычисляется по текущему времени,
   * поэтому вызывается UI-таймером и без входящих событий.
   */
  snapshot(): MeterSnapshot {
    const now = this.nowFn();
    this.prune(now);

    let state = this.state;
    if (!this.finished && state === "running") {
      if (now - this.lastProgressTs > this.stallMs) {
        state = "stalled";
      }
    }

    const done = this.lastBytes;
    const percent =
      this.bytesTotal > 0
        ? Math.min(100, Math.max(0, (done / this.bytesTotal) * 100))
        : 0;

    const speedBps = state === "running" ? this.estimateSpeed(now) : 0;

    let etaSec: number | null = null;
    if (state === "running" && this.bytesTotal > 0 && speedBps > 0) {
      const remaining = Math.max(0, this.bytesTotal - done);
      etaSec = remaining / speedBps;
    }

    return {
      state,
      bytesDone: done,
      bytesTotal: this.bytesTotal,
      speedBps,
      etaSec,
      elapsedSec: Math.max(0, (now - this.startTs) / 1000),
      percent,
    };
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────────

  /** Отбросить точки старше окна (и хвост свыше MAX_SAMPLES). */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.samples.length > 0 && this.samples[0].t < cutoff) {
      let i = 0;
      while (i < this.samples.length && this.samples[i].t < cutoff) i++;
      this.samples = this.samples.slice(i);
    }
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.slice(this.samples.length - MAX_SAMPLES);
    }
  }

  /**
   * Оценка скорости (байт/с, >= 0):
   *  1) OLS-наклон по окну (если точек/размах достаточно) — честно включает паузы;
   *  2) EWMA (ранняя фаза);
   *  3) средняя с начала передачи.
   */
  private estimateSpeed(now: number): number {
    const n = this.samples.length;
    if (n >= this.minPoints) {
      const spanMs = this.samples[n - 1].t - this.samples[0].t;
      if (spanMs >= this.minSpanMs) {
        const t0 = this.samples[0].t;
        let st = 0;
        let sb = 0;
        for (const s of this.samples) {
          st += s.t - t0;
          sb += s.b;
        }
        const mt = st / n;
        const mb = sb / n;
        let cov = 0;
        let varT = 0;
        for (const s of this.samples) {
          const dt = s.t - t0 - mt;
          cov += dt * (s.b - mb);
          varT += dt * dt;
        }
        if (varT > 0) {
          const slope = cov / varT; // байт/мс (окно в ms) → переводим в байт/с
          if (Number.isFinite(slope)) return Math.max(0, slope) * 1000;
        }
      }
    }
    if (this.ewmaBps > 0) return this.ewmaBps;
    const elapsedSec = (now - this.startTs) / 1000;
    if (elapsedSec >= 1) {
      const overall = (this.lastBytes - this.baseBytes) / elapsedSec;
      if (Number.isFinite(overall) && overall > 0) return overall;
    }
    return 0;
  }
}
