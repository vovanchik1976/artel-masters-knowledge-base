/**
 * ProgressUI — универсальный компонент прогресс-бара
 * для upload и download.
 *
 * v3 «взрослый ETA» (см. docs/ETA_TRANSFER_METER.md):
 *  - вся математика скорости/ETA — в TransferMeter (OLS по wall-clock окну);
 *    этот класс ТОЛЬКО рендерит snapshot метра;
 *  - ETA квантуется в корзины (1с/5с/30с/60с) и пишется в DOM только при смене
 *    строки — текст больше не дёргается на каждом emit движка (~200 мс);
 *  - stall-детекция («⏳ З'єднання…») по ленивому snapshot'у метра — ловится
 *    UI-таймером, даже когда события от движка прекратились (cooldown части);
 *  - фазовые проценты (upload 15..90) — через displayRange, байты и процент
 *    всегда согласованы;
 *  - reportBytes/reportNative/setEta удалены: движок шлёт сырые байты,
 *    Rust-eta/speed в UI не показываются как истина.
 */

import { t } from "../i18n";
import { TransferMeter } from "./TransferMeter";
import { formatBytes, formatSpeed, formatEta } from "./format";

export interface ReportOptions {
  /** Фазовый диапазон отображения процента, напр. [15, 90] для upload. */
  displayRange?: [number, number];
  /** Префикс строки (часть/фаза), напр. "Part 2/5". */
  partLabel?: string;
}

/** Период UI-тика: тикающий вниз ETA + своевременный stall. */
const TICK_MS = 500;

export class ProgressUI {
  private containerId: string;
  private fillId: string;
  private textId: string;
  private etaId: string;

  private fillEl!: HTMLElement;
  private textEl!: HTMLElement;
  private etaEl!: HTMLElement;

  private meter = new TransferMeter();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastOpts: ReportOptions | null = null;
  private lastTotal: number = -1;
  /** Последняя отрисованная ETA-строка (DOM пишем только при смене). */
  private lastEtaText: string | null = "";
  /** Индикатор фоновой фазы без событий (scan/pack/unpack): пульс + счётчик секунд. */
  private busy = false;
  private busyMsg = "";
  private busyStart = 0;

  constructor(
    containerId: string,
    fillId: string,
    textId: string,
    etaId: string,
  ) {
    this.containerId = containerId;
    this.fillId = fillId;
    this.textId = textId;
    this.etaId = etaId;
  }

  private ensureEls(): void {
    if (!this.fillEl) {
      this.fillEl = document.getElementById(this.fillId)!;
      this.textEl = document.getElementById(this.textId)!;
      this.etaEl = document.getElementById(this.etaId)!;
    }
  }

  /** Запустить UI-таймер (ETA тикает вниз и ловит stall между событиями). */
  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      this.renderNow(this.lastOpts);
    }, TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * Индикатор живой фоновой фазы (scan/pack/unpack без событий движка).
   * Полоса пульсирует, в ETA-строке тикает счётчик секунд — пользователь
   * видит, что программа работает, а не повисла. Останавливать stopBusy().
   */
  startBusy(msg: string): void {
    this.ensureEls();
    this.busy = true;
    this.busyMsg = msg;
    this.busyStart = Date.now();
    this.fillEl.style.width = "12%";
    this.textEl.textContent = msg;
    this.startTicker();
    this.renderNow(this.lastOpts);
  }

  /** Завершить индикатор фоновой фазы (дальше — обычное состояние прогресса). */
  stopBusy(): void {
    this.busy = false;
    this.stopTicker();
    // Счётчик «⏳ N с» гасим сразу: следующий report()/update() перезапишет
    // строку, но между фазами ETA не должна висеть устаревшей (P7).
    if (this.lastEtaText !== "") {
      this.lastEtaText = "";
      this.etaEl.textContent = "";
    }
  }

  /** Сброс на 0%, полный сброс метра (новая операция). */
  reset(): void {
    this.ensureEls();
    this.stopTicker();
    this.meter.reset(0);
    this.lastOpts = null;
    this.lastTotal = -1;
    this.lastEtaText = "";
    this.fillEl.style.width = "0%";
    this.textEl.textContent = "0%";
    this.etaEl.textContent = "";
  }

  /**
   * Фазовый процент без байт (preparing/finalizing/extracting) — метр не трогает.
   * Для байтового прогресса используйте report().
   */
  update(percent: number, message?: string): void {
    this.ensureEls();
    this.busy = false;
    const pct = Math.min(100, Math.max(0, percent));
    this.fillEl.style.width = pct + "%";
    this.textEl.textContent = message ? `${pct}% · ${message}` : `${pct}%`;
  }

  /**
   * Единственная точка входа для байтового прогресса.
   * bytesTotal=0 (неизвестен) допустим: скорость считается, ETA — нет.
   */
  report(bytesDone: number, bytesTotal: number, opts?: ReportOptions): void {
    this.ensureEls();
    this.busy = false;
    const total = Number.isFinite(bytesTotal) ? Math.max(0, bytesTotal) : 0;
    const done = Math.max(0, bytesDone);
    // Смена total (уточнение размера / другая сессия) → новая сессия метра.
    if (this.lastTotal !== total) {
      this.meter.begin(total, done);
      this.lastTotal = total;
    } else {
      this.meter.report(done);
    }
    this.lastOpts = opts ?? null;
    this.startTicker();
    this.renderNow(this.lastOpts);
  }

  /** Отрисовка snapshot метра (вызывается из report и UI-тика). */
  private renderNow(opts: ReportOptions | null): void {
    this.ensureEls();
    if (this.busy) {
      const elapsed = Math.max(0, Math.floor((Date.now() - this.busyStart) / 1000));
      const unit = t("progress.unit_sec");
      this.fillEl.style.width = 12 + ((elapsed * 13) % 76) + "%";
      this.textEl.textContent = this.busyMsg;
      const etaBusy = `⏳ ${elapsed} ${unit}`;
      if (etaBusy !== this.lastEtaText) {
        this.lastEtaText = etaBusy;
        this.etaEl.textContent = etaBusy;
      }
      return;
    }
    const snap = this.meter.snapshot();

    let pct = snap.percent;
    if (opts?.displayRange) {
      const [lo, hi] = opts.displayRange;
      pct = lo + (pct / 100) * (hi - lo);
    }
    pct = Math.round(Math.min(100, Math.max(0, pct)));

    const bytesPart = `${formatBytes(snap.bytesDone)} / ${formatBytes(snap.bytesTotal)}`;
    const label = opts?.partLabel ? `${opts.partLabel} · ` : "";
    this.fillEl.style.width = pct + "%";
    this.textEl.textContent = `${label}${pct}% · ${bytesPart}`;

    let etaText = "";
    if (snap.state === "stalled") {
      etaText = t("progress.stalled");
    } else {
      const eta = formatEta(snap.etaSec);
      const speed = snap.speedBps > 0 ? formatSpeed(snap.speedBps) : "";
      etaText = [eta ? `⏱ ${eta}` : "", speed].filter(Boolean).join(" · ");
    }
    if (etaText !== this.lastEtaText) {
      this.lastEtaText = etaText;
      this.etaEl.textContent = etaText;
    }
  }


  /** Текстовое сообщение (без процента) */
  setMessage(msg: string): void {
    this.ensureEls();
    this.textEl.textContent = msg;
  }

  /** Завершено (100%) */
  setDone(): void {
    this.ensureEls();
    this.busy = false;
    this.stopTicker();
    this.meter.finish();
    this.fillEl.style.width = "100%";
    this.textEl.textContent = "✅ 100%";
    this.etaEl.textContent = "";
    this.lastEtaText = "";
  }

  /** Ошибка */
  setError(msg: string): void {
    this.ensureEls();
    this.busy = false;
    this.stopTicker();
    this.meter.finish();
    this.textEl.textContent = `❌ ${msg}`;
    this.etaEl.textContent = "";
    this.lastEtaText = "";
  }

  /** Отменено */
  setCancelled(): void {
    this.ensureEls();
    this.busy = false;
    this.stopTicker();
    this.meter.finish();
    this.fillEl.style.width = "0%";
    this.textEl.textContent = t("progress.cancelled");
    this.etaEl.textContent = "";
    this.lastEtaText = "";
  }
}
