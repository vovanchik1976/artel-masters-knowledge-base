/**
 * DownloadPage — ввод file_id, скачивание прошивок.
 *
 * v9: Только Zero-Stitch download. Legacy multipart удалён.
 *     HF Hub удалён полностью.
 *
 *     Поток:
 *       1. downloadInit() -> получить метаданные (MTProto)
 *       2. Выбрать путь сохранения
 *       3. downloadContext() -> Zero-Stitch (единственный download path)
 *       4. downloadComplete()
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save, ask } from "@tauri-apps/plugin-dialog";
import type {
  DownloadInitResponse,
  DownloadStartResponse,
  VolumeMeta,
} from "../api";
import { api } from "../api";
import { ProgressUI } from "./Progress";
import { requireAuth } from "../auth";
import { t } from "../i18n";
import { DownloadStallWatchdog } from "./DownloadStallWatchdog";
import {
  containerExtension,
  decideDownloadAction,
  detectDownloadContainer,
  expectedContainerName,
  keepPackedChoice,
} from "./DownloadAction";
import { buildFinalCancelPlan } from "./DownloadCancelFinal";
import { shouldPurgeTdlibCacheOnCancel } from "./JanitorPolicy";
import {
  appendDownloadRca,
  buildMultiPartDescriptors,
  buildOwnerPartDescriptors,
  buildOwnerResolveParams,
  isTdlibRemoteFileId,
  type MultiPartDescriptor,
} from "./downloadParts";
import { buildVaultPartDescriptors, hasDownloadAnchor } from "./vaultShare";

// ══════════════════════════════════════════════════════════════════════════
// TDLib JSON FFI Download — TypeScript интерфейсы (зеркало Rust struct'ов)
// ══════════════════════════════════════════════════════════════════════════

/** Состояние соединения TDLib из receive-loop (`updateConnectionState`). */
interface TdlibConnectionStateEvent {
  /** Напр. `connectionStateReady` / `connectionStateWaitingForNetwork`. */
  state: string;
}

/** Прогресс download из Rust tdlib_download.rs :: TdlibDownloadProgress */
interface TdlibFfiDownloadProgress {
  file_id: number;
  downloaded: number;
  total: number;
  percent: number;
  speed_bytes_per_sec: number;
  eta_secs: number;
  completed: boolean;
  cancelled: boolean;
  error: string | null;
  local_path: string | null;
  file_name: string | null;
}

/** Статус composite download из Rust tdlib_download.rs :: TdlibCompositeStatus */
interface TdlibFfiCompositeStatus {
  download_id: string;
  completed_parts: number;
  total_parts: number;
  downloaded_bytes: number;
  total_bytes: number;
  all_completed: boolean;
  output_path?: string;
  file_name?: string;
}

/** Событие merged (финальный файл готов) */
interface TdlibFfiDownloadMerged {
  download_id: string;
  output_path: string;
}

/** Статус TDLib JSON FFI runtime */
interface TdlibFfiRuntimeStatus {
  ready: boolean;
  authorization_state: string;
  download_manager: boolean;
}

/** Remote part descriptor для composite download (зеркало Rust RemotePartDescriptor) */
interface TdlibFfiRemotePartDescriptor {
  tg_file_id: string;
  part_index: number;
  expected_sha256: string | null;
  expected_size: number | null;
  chat_id?: number;
}

/** Прогресс multi-download */
interface TdlibFfiMultiDownloadProgress {
  download_id: string;
  current_part_index: number;
  total_parts: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bytes_per_sec: number;
  eta_secs: number;
  completed: boolean;
  error: string | null;
}


export class DownloadPage {
  // TDLib JSON FFI event unlisteners (для cleanup при cancel)
  private _unlistenTdlibFfi: UnlistenFn[] = [];
  /**
   * Колбэк «личный файл скачан» (решение владельца 2026-11-10): приложение
   * предлагает убрать копию файла из чата с ботом.
   */
  onPersonalDownloaded?: (pfId: number, fileName: string) => void;
  private progress: ProgressUI;

  // DOM refs
  private fileIdInput!: HTMLInputElement;
  private startBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private fileInfo!: HTMLElement;
  private fileNameEl!: HTMLElement;
  private fileSizeEl!: HTMLElement;
  private partsCountEl!: HTMLElement;
  private downloadPriceEl!: HTMLElement;
  private progressContainer!: HTMLElement;
  private logEl!: HTMLElement;

  // Host-Mediation PM-Lease (ADR 2026-09-06): подтверждение цены + retry
  private priceConfirmPanel!: HTMLElement;
  private downloadConfirmPriceText!: HTMLElement;
  private downloadConfirmYesBtn!: HTMLButtonElement;
  private downloadConfirmNoBtn!: HTMLButtonElement;
  private retryPanel!: HTMLElement;
  private downloadRetryBtn!: HTMLButtonElement;
  private downloadRetryLeaseText!: HTMLElement;
  /** Активная (оплаченная) download-сессия для бесплатного retry в пределах lease. */
  private _leaseDownloadId: string | null = null;
  private _leaseFileId: number | null = null;
  private _leaseExpiresAt: string | null = null;
  private _retrySavePath: string | null = null;
  private _retryResolvedName: string | null = null;
  private _retryIsBundle: boolean = false;
  /** true — если файл уже оплачен (start выполнен); отмена/обрыв → retry, НЕ refund. */
  private _hostStarted: boolean = false;

  // Cancel support
  private abortController: AbortController | null = null;
  private cancelled: boolean = false;
  /**
   * Поколение операции (BUG-CANCEL-RESUME-001).
   *
   * Каждый старт/отмена/новый download увеличивает `_epoch`. Все await-и
   * и TDLib-события проверяют, что их поколение всё ещё актуально, иначе
   * поздний результат отменённой попытки попадал в следующую (оплаченный
   * lease оставался «живым», требовался рестарт клиента).
   */
  private _epoch: number = 0;
  /** true, пока идёт закрытие отменённой операции — блокирует новый старт/retry. */
  private _cancelling: boolean = false;
  /** Активная передача (для чипа-индикатора на SearchPage, гибридный старт Phase 3). */
  private _transferActive: boolean = false;
  /** download_id текущей попытки (для явного серверного закрытия при Cancel). */
  private _currentDownloadId: string | null = null;
  /** download_id, уже закрытые через Cancel — защита от двойного complete(false). */
  private _closedByCancel: Set<string> = new Set();
  /**
   * Путь недокачанного файла текущей попытки (BUG-CANCEL-FINAL-001).
   *
   * Снимается в cancelDownload ДО любых await и удаляется по плану
   * buildFinalCancelPlan — отмена есть финал: частичный файл не остаётся
   * на диске. Сбрасывается в finally (владелец поколения) и после зачистки.
   */
  private _activeSavePath: string | null = null;
  /** Вывод multi/vault-склейки (обычно = savePath; дедуп в плане отмены). */
  private _activeOutputPath: string | null = null;
  /** Текущий file_id для отмены Zero-Stitch download через CANCEL_REGISTRY */
  private _currentFileId: number | null = null;
  /** TDLib-внутренний file_id (получен через getRemoteFile).
   *  Используется для FFI download/cancel — ОТЛИЧАЕТСЯ от _currentFileId
   *  (который является DB primary key). */
  private _currentTdlibFileId: number | null = null;
  /**
   * BUG-CANCEL-RESUME-002: Rust-идентификатор активной multi/vault-загрузки
   * (`multi_registry` в tdlib_download.rs). Уникален НА ПОПЫТКУ — в него
   * входит epoch, поэтому зомби-события отменённой попытки не могут совпасть
   * с событиями новой (раньше id был производным от download_id, который
   * повторно используется сервером при retry в пределах оплаченного lease).
   */
  private _currentMultiId: string | null = null;

  /**
   * BUG-DOWNLOAD-049: watchdog обрыва UI. Если движок перестал слать прогресс
   * (обрыв сети / зависший `downloadFile{synchronous}` до 6ч), TransferMeter
   * уходит в «⏳ Соединение…», а промис загрузки ждёт терминального события
   * бесконечно. Watchdog пере-запускает загрузку в рамках оплаченного lease
   * (до 3 раз, без повторного списания), после чего отдаёт панель retry.
   */
  private _stallWd: DownloadStallWatchdog | null = null;
  private _stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Последнее состояние соединения TDLib (для логов/диагностики). */
  private _connState: string = "";
  private _unlistenConnState: UnlistenFn | null = null;

  // Cache cleanup UI elements
  private clearCacheBtn!: HTMLButtonElement;
  private clearCacheResult!: HTMLElement;

  // Keep-packed: «Оставить архивом» (default OFF, persist localStorage).
  // Показывается только для bundle (наш ZIP / tar.zst): checked → архив
  // остаётся на диске + подсказка (Архиватор / Проводник / свой архиватор).
  private keepPackedRow!: HTMLElement;
  private keepPackedCheckbox!: HTMLInputElement;
  private keepPackedLabel!: HTMLElement;
  /**
   * П.4: ответ диалога «Оставить архивом?» на ТЕКУЩУЮ операцию
   * (null = диалог не показывался → берётся persist-чекбокс). Сбрасывается
   * при новом старте скачивания.
   */
  private _keepPackedDialogAnswer: boolean | null = null;

  // TDLib JSON FFI runtime state
  private tdlibFfiStatusDot!: HTMLElement;
  private tdlibFfiStatusText!: HTMLElement;
  /** Флаг: TDLib JSON FFI runtime готов (устанавливается _checkTdlibFfiStatus) */
  private _tdlibFfiReady: boolean = false;

  // ── Debug / Trace (сквозное логирование) ──
  /** Уникальный trace_id для каждого download — связывает логи фронтенда, Rust и бэка */
  private _traceId: string = "";
  /** DOM-элемент debug-панели */
  private _debugPanel!: HTMLElement;
  private _debugTraceIdEl!: HTMLElement;
  private _debugContentEl!: HTMLElement;
  /** Очередь сообщений для batch-рендера (неблокирующее логирование) */
  private _debugQueue: string[] = [];
  private _debugRafScheduled: boolean = false;

  /** Callback для получения текущего tg_id (из App.ts) */
  private getTgId: () => number;
  /** Callback для уведомления App.ts об изменении баланса */
  private onBalanceChanged?: () => void;

  constructor(
    getTgId: () => number,
    onBalanceChanged?: () => void,
    /**
     * BUG-CANCEL-FINAL-001: идёт ли параллельная передача в ДРУГОЙ вкладке
     * (Upload). Кеш TDLib общий, поэтому пург при отмене пропускается, если
     * параллельная передача активна (иначе снесём её local→remote маппинг).
     */
    private otherTransferActive?: () => boolean,
  ) {
    this.getTgId = getTgId;
    this.onBalanceChanged = onBalanceChanged;
    this.progress = new ProgressUI(
      "downloadProgress", "downloadProgressFill",
      "downloadProgressText", "downloadProgressEta",
    );
  }

  bindEvents(): void {
    this.fileIdInput = document.getElementById("downloadFileId") as HTMLInputElement;
    this.startBtn = document.getElementById("startDownloadBtn") as HTMLButtonElement;
    this.cancelBtn = document.getElementById("cancelDownloadBtn") as HTMLButtonElement;
    this.fileInfo = document.getElementById("downloadFileInfo")!;
    this.fileNameEl = document.getElementById("downloadFileName")!;
    this.fileSizeEl = document.getElementById("downloadFileSize")!;
    this.partsCountEl = document.getElementById("downloadPartsCount")!;
    this.downloadPriceEl = document.getElementById("downloadPrice")!;
    this.progressContainer = document.getElementById("downloadProgress")!;
    this.logEl = document.getElementById("downloadLog")!;

    // Host-Mediation PM-Lease (ADR 2026-09-06)
    this.priceConfirmPanel = document.getElementById("downloadPriceConfirmPanel")!;
    this.downloadConfirmPriceText = document.getElementById("downloadConfirmPriceText")!;
    this.downloadConfirmYesBtn = document.getElementById("downloadConfirmYesBtn") as HTMLButtonElement;
    this.downloadConfirmNoBtn = document.getElementById("downloadConfirmNoBtn") as HTMLButtonElement;
    this.retryPanel = document.getElementById("downloadRetryPanel")!;
    this.downloadRetryBtn = document.getElementById("downloadRetryBtn") as HTMLButtonElement;
    this.downloadRetryLeaseText = document.getElementById("downloadRetryLeaseText")!;
    this.downloadConfirmYesBtn.addEventListener("click", () => this._confirmPrice(true));
    this.downloadConfirmNoBtn.addEventListener("click", () => this._confirmPrice(false));
    this.downloadRetryBtn.addEventListener("click", () => this._retryDownload());
    this._debugPanel = document.getElementById("debugPanel")!;
    this._debugTraceIdEl = document.getElementById("debugTraceId")!;
    this._debugContentEl = document.getElementById("debugContent")!;
    // TDLib JSON FFI runtime status indicator
    this.tdlibFfiStatusDot = document.getElementById("tdlibFfiStatusDot")!;
    this.tdlibFfiStatusText = document.getElementById("tdlibFfiStatusText")!;

    // 🧹 Очистка кеша TDLib
    this.clearCacheBtn = document.getElementById("clearDownloadCacheBtn") as HTMLButtonElement;
    this.clearCacheResult = document.getElementById("clearDownloadCacheResult")!;
    this.clearCacheBtn.addEventListener("click", () => this.clearTdlibCache());

    // Keep-packed: «Оставить архивом» (default OFF, persist — как чекбокс
    // сжатия в Upload). Видимостью управляет _refreshKeepPackedRow() после
    // резолва strategy (только bundle); текст — applyLang()/ветка keep.
    this.keepPackedRow = document.getElementById("downloadKeepPackedRow")!;
    this.keepPackedCheckbox = document.getElementById("downloadKeepPackedCheckbox") as HTMLInputElement;
    this.keepPackedLabel = document.getElementById("downloadKeepPackedLabel")!;
    try {
      this.keepPackedCheckbox.checked = localStorage.getItem("fw_download_keep_packed") === "1";
      // default OFF: отсутствие ключа → unchecked (разметка).
    } catch { /* ignore */ }
    this.keepPackedCheckbox.addEventListener("change", () => {
      try {
        localStorage.setItem("fw_download_keep_packed", this.keepPackedCheckbox.checked ? "1" : "0");
      } catch { /* ignore */ }
    });

    // ⚙️ Download strategy: TDLib JSON FFI (primary) → Zero-Stitch MTProto (fallback) → Server Transit (ultima ratio).
    // TDLib Local Bot API (HTTP на порту 8081) полностью удалён — см. BUG-DOWNLOAD-006 / Local Bot API removal.
    // Проверка готовности: TDLib JSON FFI runtime status (authorizationStateReady).

    // TDLib JSON FFI runtime status check (fire-and-forget)
    this._checkTdlibFfiStatus().catch(() => {});

    this.startBtn.addEventListener("click", () => this.startDownload());
    this.cancelBtn.addEventListener("click", () => { void this.cancelDownload(); });

    // Enter in the input field
    this.fileIdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startDownload();
    });

    // BUG-DOWNLOAD-049: состояние сети TDLib. Нужно watchdog'у (без сети
    // авто-retry бессмыслен) и для честного лога «сеть упала / вернулась» —
    // раньше обрыв сети выглядел как вечный «⏳ Соединение…» без объяснения.
    void listen<TdlibConnectionStateEvent>("tdlib-connection-state", (e) => {
      this._onConnectionState(e.payload?.state ?? "");
    })
      .then((fn) => {
        this._unlistenConnState = fn;
      })
      .catch(() => {
        /* runtime мог ещё не подняться — событие просто не придёт */
      });

  }

  private log(msg: string, type: string = "info"): void {
    const icons: Record<string, string> = {
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
      success: "✅",
    };
    const icon = icons[type] || "ℹ️";
    const div = document.createElement("div");
    div.className = `log-${type}`;
    div.textContent = `[${this._fmtTime(new Date())}] ${icon} ${msg}`;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    // Download-RCA в файл (Linux-dev, e2e-prod32): зеркало ключевых строк
    // вкладки — стратегия/priority/ошибка дословно. Best-effort (no-op в тестах).
    appendDownloadRca({ source: "ui", op: this._rcaOp, level: type, msg });
  }

  /** Текущая операция для RCA-зеркала (выставляется в startDownload/ветках). */
  private _rcaOp = "unknown";

  /** Формат времени HH:MM:SS для меток в логе окна скачивания. */
  private _fmtTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Человекочитаемая длительность из миллисекунд (мм с / с). */
  private _formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const minUnit = t("progress.unit_min");
    const secUnit = t("progress.unit_sec");
    return m > 0
      ? `${m} ${minUnit} ${String(sec).padStart(2, "0")} ${secUnit}`
      : `${sec} ${secUnit}`;
  }

  // ── Сквозное логирование (неблокирующее) ──────────────────────────────────

  /** Сгенерировать UUID v4 для trace_id */
  private _generateTraceId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /**
   * Неблокирующее логирование в debug-панель.
   * Ставит сообщение в очередь и рендерит через requestAnimationFrame (batch).
   */
  private _debugLog(stage: string, data: unknown): void {
    const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = `[${timestamp}] [${stage}]\n${JSON.stringify(data, null, 2)}`;
    this._debugQueue.push(line);

    // Batch-рендер через requestAnimationFrame — не блокируем поток
    if (!this._debugRafScheduled) {
      this._debugRafScheduled = true;
      requestAnimationFrame(() => {
        this._debugRafScheduled = false;
        const batch = this._debugQueue.splice(0, this._debugQueue.length);
        if (batch.length === 0) return;
        this._debugContentEl.textContent = batch.join("\n\n") + "\n\n" + (this._debugContentEl.textContent ?? "");
        const lines = this._debugContentEl.textContent ?? "";
        const lineCount = lines.split("\n").length;
        if (lineCount > 1000) {
          const trimmed = lines.split("\n").slice(0, 1000).join("\n");
          this._debugContentEl.textContent = trimmed + "\n...(truncated)";
        }
      });
    }
  }

  /**
   * Отменить текущий download.
   *
   * ПОРЯДОК ВАЖЕН (BUG-CANCEL-RESUME-001):
   *   1) инвалидируем поколение (поздние await/события отменённой попытки
   *      больше не влияют на UI и не идут в /complete);
   *   2) разблокируем UI сразу (пользователь не ждёт сеть);
   *   3) останавливаем передачу (abort + TDLib cancel) и ОТПИСЫВАЕМ слушатели
   *      прогресса — иначе события «мёртвой» попытки попадают в следующую;
   *   4) ЯВНО закрываем серверную сессию (`complete(false)`) — иначе на сервере
   *      остаётся `started`-lease, и следующий init отдаёт старый download_id,
   *      из-за чего требовался перезапуск клиента.
   *
   * Пока закрытие не завершено, `_cancelling = true` блокирует старт/retry.
   */
  private async cancelDownload(): Promise<void> {
    if (this._cancelling) return;
    this._cancelling = true;

    // 1. Новое поколение: всё, что уже запущено, становится устаревшим.
    this._epoch++;
    this.cancelled = true;
    // BUG-DOWNLOAD-049: отменённая операция не должна авто-retry'иться.
    this._stopStallWatchdog();

    // 2. UI разблокируем немедленно — сеть догонит асинхронно.
    this.startBtn.disabled = false;
    this.fileIdInput.disabled = false;
    this.cancelBtn.style.display = "none";
    this.cancelBtn.disabled = true;
    this.log("Stop by user request", "warn");
    this.progress.setCancelled();

    // Снимок координат ДО любых await (startDownload.finally их обнуляет).
    const downloadId = this._currentDownloadId;
    const tdlibFileId = this._currentTdlibFileId;
    const dbFileId = this._currentFileId;
    const multiId = this._currentMultiId;
    // BUG-CANCEL-FINAL-001: снимок путей И lease-статуса ДО await — план
    // финальной зачистки строится из этих координат.
    const savePath = this._activeSavePath;
    const outputPath = this._activeOutputPath;
    const hostStarted = this._hostStarted;
    const plan = buildFinalCancelPlan({
      savePath,
      outputPath,
      downloadId,
      hostStarted,
    });

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 3. Отписка от событий прогресса (если зарегистрированы общие слушатели):
    //    поздние события отменённой попытки не должны попадать в UI новой.
    //    Per-call слушатели (tdlibFfiDownload/Multi/VaultSelf) отписываются сами
    //    по проверке поколения (см. _isCurrent в их обработчиках).
    this._unlistenAllTdlibFfi();

    // 3a. BUG-CANCEL-RESUME-002: multi/vault-загрузку отменяем ОТДЕЛЬНОЙ
    //     командой по Rust-id контекста. `tdlib_cancel_download` здесь
    //     бесполезен: он принимает TDLib file_id, который для multi-ветки
    //     клиенту неизвестен (там N частей со своими file_id). Без этого
    //     конвейер продолжал качать в фоне и «убивал» следующую попытку
    //     событием "Download cancelled for part[0]".
    if (multiId) {
      try {
        await invoke<string>("tdlib_cancel_multi_download", { downloadId: multiId });
        this.log(`Multi-download cancelled in engine: ${multiId}`, "info");
      } catch (e: any) {
        this.log(`Multi-download cancel error: ${e?.message ?? e}`, "warn");
      }
    }

    // TDLib JSON FFI cancel — ждём ответа, чтобы Rust успел отправить
    // cancelDownloadFile по актуальному file_id (после await — новый старт).
    if (dbFileId && !multiId) {
      await this.tdlibFfiCancel(tdlibFileId ?? dbFileId).catch(() => {});
    }

    // 4. Серверное закрытие отменённой сессии (retry-семантика, НЕ refund).
    //    Закрываем ЯВНО: иначе на сервере остаётся started-lease, следующий init
    //    вернёт старый download_id, и клиент «залипал» до перезапуска.
    if (plan.closeSession && downloadId) {
      const closed = await this._closeSessionOnce(downloadId);
      this._debugLog("download:cancelled_by_user", {
        trace_id: this._traceId,
        download_id: downloadId,
        file_id: dbFileId,
        session_closed: closed,
        removed_paths: plan.removePaths,
        purged_cache: plan.purgeTdlibCache,
      });
      if (closed) this.log(`Server session closed: ${downloadId}`, "info");
    }

    // 5. BUG-CANCEL-FINAL-001: финал-зачистка по плану.
    //    5а. недокачанные файлы (savePath / вывод multi-склейки);
    //    5б. файловый кеш TDLib (раньше purge был только на успехе);
    //    5в. retry-панель + lease-контекст — отмена есть финал, панели нет;
    //        lease на сервере живёт → следующий старт того же файла бесплатен
    //        (reused_active_lease), по истечении — write-off с серверным логом.
    for (const p of plan.removePaths) {
      try {
        await invoke("delete_file", { path: p });
        this.log(`🗑 Partial file removed: ${p}`, "info");
      } catch (e: any) {
        // best-effort: файла может уже не быть (move/upload не начался).
        this.log(
          `⚠️ Partial file removal skipped (${p}): ${e?.message ?? String(e)}`,
          "warn",
        );
      }
    }
    // Пург кеша TDLib — общий ресурс сессии: пропускаем, если в другой вкладке
    // (Upload) идёт активная передача, иначе снесём её local→remote маппинг.
    const otherActive = this.otherTransferActive?.() === true;
    if (plan.purgeTdlibCache && shouldPurgeTdlibCacheOnCancel(otherActive)) {
      try {
        const res = await invoke<string>("tdlib_clear_cache");
        this.log(`🧹 TDLib cache purged after cancel: ${res}`, "info");
      } catch (e: any) {
        this.log(`⚠️ TDLib cache purge failed: ${e?.message ?? String(e)}`, "warn");
      }
    } else if (plan.purgeTdlibCache) {
      this.log(
        "ℹ️ TDLib cache purge skipped: another transfer is active (cache is shared)",
        "warn",
      );
    }
    if (plan.hideRetryPanel && this.retryPanel) {
      this.retryPanel.style.display = "none";
    }
    if (plan.resetLeaseContext) {
      this._hostStarted = false;
      this._leaseDownloadId = null;
      this._leaseFileId = null;
      this._leaseExpiresAt = null;
      this._retrySavePath = null;
      this._retryResolvedName = null;
      this._retryIsBundle = false;
    }
    if (plan.freeRestartHint) {
      // Баллы списаны (capture) — отмена их НЕ возвращает, но повтор того же
      // файла в пределах lease бесплатен; после lease — write-off (серверный
      // лог «lease expired», PM-доставка чистится фоновым GC).
      this.log(
        "💡 Points kept (capture): re-downloading the same file within the lease is free",
        "info",
      );
    }

    // Сброс координат текущей попытки + снятие блокировки старта.
    this._currentDownloadId = null;
    this._currentTdlibFileId = null;
    this._currentMultiId = null;
    this._activeSavePath = null;
    this._activeOutputPath = null;
    this.cancelled = false;
    this._cancelling = false;
  }

  /** true, если операция с данным поколением всё ещё актуальна (не отменена). */
  private _isCurrent(epoch: number): boolean {
    return epoch === this._epoch;
  }

  /**
   * Прервать устаревшую попытку.
   *
   * Вызывается после каждого await в цепочке операции: если поколение
   * изменилось (пользователь нажал Cancel или начал новый download), старая
   * цепочка обязана прекратиться и не трогать UI/сервер.
   */
  private _throwIfStale(epoch: number): void {
    if (!this._isCurrent(epoch)) {
      throw new Error("Download cancelled by user");
    }
  }

  /**
   * Закрыть серверную сессию скачивания ровно один раз (retry-семантика).
   *
   * `complete(false)` на started-сессии НЕ возвращает баллы и НЕ убивает lease
   * (сервер: «НЕ refund, retry-семантика») — поэтому оплаченный повтор остаётся
   * бесплатным. На initiated-сессии сервер помечает её cancelled (списания не было).
   */
  private async _closeSessionOnce(downloadId: string | null): Promise<boolean> {
    if (!downloadId) return false;
    if (this._closedByCancel.has(downloadId)) return true;
    try {
      await api.downloadComplete(downloadId, false);
      this._closedByCancel.add(downloadId);
      return true;
    } catch (e: any) {
      this.log(`Session close failed: ${e?.message ?? String(e)}`, "warn");
      return false;
    }
  }

  /**
   * Прервать устаревшую попытку + закрыть её серверную сессию.
   *
   * Используется на чекпоинтах после await: если пользователь отменил загрузку
   * (или запустил новую), устаревшая цепочка закрывает свою сессию и падает в
   * catch как «cancelled» — она не должна доходить до complete(true).
   */
  private async _abortIfStale(epoch: number, downloadId: string | null): Promise<void> {
    if (this._isCurrent(epoch) && !this.cancelled) return;
    await this._closeSessionOnce(downloadId);
    throw new Error("Download cancelled by user");
  }

  /** Зарегистрировать слушатели событий TDLib JSON FFI */
  private async _listenTdlibFfiEvents(
    onProgress: (p: TdlibFfiDownloadProgress) => void,
    onComposite: (p: TdlibFfiCompositeStatus) => void,
    onMerged: (p: TdlibFfiDownloadMerged) => void,
  ): Promise<void> {
    this._unlistenTdlibFfi.push(
      await listen<TdlibFfiDownloadProgress>("tdlib-download-progress", (e) => {
        onProgress(e.payload);
      }),
    );
    this._unlistenTdlibFfi.push(
      await listen<TdlibFfiCompositeStatus>("tdlib-composite-progress", (e) => {
        onComposite(e.payload);
      }),
    );
    this._unlistenTdlibFfi.push(
      await listen<TdlibFfiDownloadMerged>("tdlib-download-merged", (e) => {
        onMerged(e.payload);
      }),
    );
  }

  /** Отписаться от всех событий TDLib JSON FFI */
  private _unlistenAllTdlibFfi(): void {
    for (const fn of this._unlistenTdlibFfi) {
      fn();
    }
    this._unlistenTdlibFfi = [];
  }

  /**
   * Проверить статус TDLib JSON FFI runtime.
   * Вызывается при старте download для определения стратегии.
   */
  private async _checkTdlibFfiStatus(): Promise<boolean> {
    try {
      const status = await invoke<TdlibFfiRuntimeStatus>("tdlib_runtime_status");

      this._tdlibFfiReady = status.ready && status.download_manager;

      const dot = this.tdlibFfiStatusDot;
      const text = this.tdlibFfiStatusText;
      if (!dot || !text) return this._tdlibFfiReady;

      dot.className = "status-dot";
      if (status.ready && status.download_manager) {
        dot.classList.add("green");
        text.textContent = "TDLib JSON FFI Ready";
      } else {
        dot.classList.add("red");
        text.textContent = `TDLib: ${status.authorization_state || "not ready"}`;
      }
      return this._tdlibFfiReady;
    } catch {
      this._tdlibFfiReady = false;
      const dot = this.tdlibFfiStatusDot;
      const text = this.tdlibFfiStatusText;
      if (dot) dot.className = "status-dot red";
      if (text) text.textContent = "TDLib JSON FFI unavailable";
      return false;
    }
  }

  // ── BUG-DOWNLOAD-049: watchdog обрыва (UI-страховка) ─────────────────────

  /** Запустить watchdog обрыва на активную передачу. */
  private _startStallWatchdog(): void {
    this._stopStallWatchdog();
    this._stallWd = new DownloadStallWatchdog();
    if (this._connState) this._stallWd.connectionState(this._connState);
    this._stallTimer = setInterval(() => this._tickStallWatchdog(), 5000);
  }

  /** Остановить watchdog (успех/ошибка/отмена/новый старт). */
  private _stopStallWatchdog(): void {
    if (this._stallTimer !== null) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
    this._stallWd = null;
  }

  /** Тик watchdog'а: авто-retry в пределах lease либо панель retry. */
  private _tickStallWatchdog(): void {
    const wd = this._stallWd;
    // BUG-DOWNLOAD-050: передача уже не идёт (успех/ошибка/отмена) —
    // запоздалый тик не должен стартовать повторный download.
    if (!wd || this._cancelling || !this._transferActive) return;
    const action = wd.check();
    if (action === "retry") {
      // Авто-retry возможен только в пределах оплаченного lease: сервер вернёт
      // тот же download_id (`reused_active_lease`) и баллы НЕ спишутся повторно.
      if (this._leaseFileId == null || this._retrySavePath == null) {
        this.log("Stall detected, but there is no paid session to retry — waiting", "warn");
        return;
      }
      this.log(`Stall detected — auto-retrying download (attempt ${wd.attempts})...`, "warn");
      this._debugLog("download:stall_auto_retry", {
        trace_id: this._traceId,
        attempt: wd.attempts,
        download_id: this._currentDownloadId,
      });
      // Останавливаем ДО retry: новый старт поднимет watchdog заново
      // (счётчик попыток новой попытки — свой).
      this._stopStallWatchdog();
      void this._retryDownload();
    } else if (action === "give-up") {
      this.log("Stall persists after auto-retries — manual retry required", "error");
      this._debugLog("download:stall_give_up", {
        trace_id: this._traceId,
        attempts: wd.attempts,
        download_id: this._currentDownloadId,
      });
      this._stopStallWatchdog();
      if (this._leaseFileId != null && this._retrySavePath != null) {
        this.progress.setMessage(t("download.msg.progress_error_paid"));
        this._showRetryPanel();
      }
    }
  }

  /** Состояние соединения TDLib из receive-loop (логируем переходы). */
  private _onConnectionState(state: string): void {
    if (!state || state === this._connState) return;
    const prev = this._connState;
    this._connState = state;
    this._stallWd?.connectionState(state);
    if (state === "connectionStateWaitingForNetwork") {
      this.log("TDLib connection lost — waiting for network", "warn");
    } else if (state === "connectionStateReady" && prev !== "") {
      // Окно watchdog'а НЕ сбрасываем: если движок не возобновил часть,
      // авто-retry должен сработать сразу после возврата сети.
      this.log("TDLib connection restored", "success");
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // TDLib JSON FFI Download — TypeScript клиент
  // ══════════════════════════════════════════════════════════════════════

  /**
   * TDLib JSON FFI single-part download.
   * Возвращает Promise, который резолвится при завершении download.
   *
   * BUG-DOWNLOAD-027 / BUG-DOWNLOAD-034:
   * - joinChat перед getRemoteFile для уверенности, что TDLib состоит в чате
   * - getMessage перед downloadFile для преодоления прав доступа
   * - timeout 20s на первый updateFile (TDLib default 10s + буфер)
   */
  private async tdlibFfiDownload(
    fileId: number,
    priority: number,
    offset: number,
    limit: number,
    savePath: string | null,
    chatId: number | null,
    messageId: number | null,
    timeoutMs: number = 20000,
    /** Поколение операции: события отменённой попытки игнорируются. */
    epoch: number = this._epoch,
  ): Promise<TdlibFfiDownloadProgress> {
    return new Promise<TdlibFfiDownloadProgress>((resolve, reject) => {
      let unlistenProgress: UnlistenFn | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let started = false;

      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        if (unlistenProgress) unlistenProgress();
        // BUG-DOWNLOAD-049: передача завершилась (успех/ошибка/отмена) —
        // watchdog больше не нужен (иначе авто-retry поверх завершённой операции).
        this._stopStallWatchdog();
      };

      this._startStallWatchdog();

      listen<TdlibFfiDownloadProgress>("tdlib-download-progress", (e) => {
        const p = e.payload;
        if (p.file_id !== fileId) return;
        // Отменённая/устаревшая попытка: событие не должно трогать UI и висеть.
        if (!this._isCurrent(epoch)) {
          cleanup();
          reject(new Error("Download cancelled by user"));
          return;
        }

        // Cancellation event — reject немедленно, до обновления прогресса
        if (p.cancelled) {
          cleanup();
          reject(new Error("Download cancelled"));
          return;
        }

        // Пользователь нажал Отмена — не обновляем прогресс и ждём cancelled event
        if (this.cancelled) return;

        // Первый updateFile получен — сбрасываем таймаут
        if (!started && (p.downloaded > 0 || p.total > 0 || p.completed || p.error)) {
          started = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        }

        // Обновляем UI — report сам отрисует downloaded/total, ETA и скорость
        // (TransferMeter считает по сырым байтам; Rust-eta/speed не истина)
        this.progress.report(Number(p.downloaded), Number(p.total));
        // Байты/событие пришли — окно watchdog'а обрыва пере-взведено.
        this._stallWd?.progress();

        // Логируем ошибки
        if (p.error) {
          this.log(`TDLib JSON FFI error: ${p.error}`, "error");
        }

        // Завершение (success или error)
        if (p.completed || p.error) {
          cleanup();
          if (p.error) {
            reject(new Error(p.error));
          } else {
            resolve(p);
          }
        }
      }).then((fn) => {
        unlistenProgress = fn;

        // BUG-DOWNLOAD-027: Таймаут на первый updateFile
        // Если TDLib не прислал updateFile в течение timeoutMs — reject,
        // чтобы не висеть вечно и дать шанс MTProto Slow Path.
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `TDLib download timeout: no progress for ${(timeoutMs / 1000).toFixed(0)}s (file_id=${fileId}). ` +
            `The file may be in a storage chat not joined by the user TDLib client.` +
            (chatId ? ` chat_id=${chatId}` : "") +
            (messageId ? ` message_id=${messageId}` : "")
          ));
        }, timeoutMs);

        // Запускаем downloadFile в TDLib
        const args: Record<string, unknown> = {
          fileId,
          priority,
          offset,
          limit,
        };
        if (savePath) args.savePath = savePath;
        if (chatId) args.chatId = chatId;
        if (messageId) args.messageId = messageId;

        invoke<string>("tdlib_start_download", args).catch((e: any) => {
          cleanup();
          reject(e);
        });
      }).catch((e: any) => {
        reject(e);
      });
    });
  }

  /**
   * TDLib JSON FFI composite download (sequential parts → assemble).
   * Используется для bundle-файлов (несколько tg_file_id).
   *
   * Каждый tg_file_id резолвится в TDLib file_id через getRemoteFile.
   * Части скачиваются последовательно, дописываются в output файл.
   */
  private async tdlibFfiCompositeDownload(
    downloadId: string,
    parts: TdlibFfiRemotePartDescriptor[],
    outputPath: string,
    fileName: string | null,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let unlisten: UnlistenFn[] = [];

      // BUG-DOWNLOAD-049: страховка от «вечного ⏳ Соединение…» (composite).
      this._startStallWatchdog();

      const onComposite = (p: TdlibFfiCompositeStatus) => {
        if (p.download_id !== downloadId) return;

        // BUG-DOWNLOAD-048: текст частей передаём как partLabel — иначе
        // setMessage() затирал строку «N% · байты», оставляя бар без процента.
        this.progress.report(Number(p.downloaded_bytes), Number(p.total_bytes), {
          partLabel: t("download.composite_parts", {
            current: p.completed_parts,
            total: p.total_parts,
          }),
        });
        // BUG-DOWNLOAD-049: байты composite-ветки — обрыва нет.
        this._stallWd?.progress();

        if (p.all_completed) {
          for (const fn of unlisten) fn();
          this._stopStallWatchdog();
          resolve(p.output_path ?? outputPath);
        }
      };

      const onMerged = (p: TdlibFfiDownloadMerged) => {
        if (p.download_id !== downloadId) return;
        this.log(`Composite merged: ${p.output_path}`, "success");
        this._stopStallWatchdog();
        resolve(p.output_path);
      };

      const onError = (err: TdlibFfiDownloadProgress) => {
        if (!err.error) return;
        for (const fn of unlisten) fn();
        this._stopStallWatchdog();
        reject(new Error(err.error));
      };

      // Регистрируем слушатели ДО вызова команды
      Promise.all([
        listen<TdlibFfiCompositeStatus>("tdlib-composite-progress", (e) => onComposite(e.payload)),
        listen<TdlibFfiDownloadMerged>("tdlib-download-merged", (e) => onMerged(e.payload)),
        listen<TdlibFfiDownloadProgress>("tdlib-download-progress", (e) => onError(e.payload)),
      ]).then((fns) => {
        unlisten = fns;
        // parts — массив RemotePartDescriptor с tg_file_id.
        // Rust сторона резолвит каждый tg_file_id через getRemoteFile.
        invoke<string>("tdlib_start_composite_download", {
          downloadId,
          parts,
          outputPath,
          fileName,
        }).catch((e: any) => {
          for (const fn of unlisten) fn();
          this._stopStallWatchdog();
          reject(e);
        });
      }).catch((e: any) => {
        this._stopStallWatchdog();
        reject(e);
      });
    });
  }

  /**
   * Sequential Part Accumulator (multi-download) через TDLib JSON FFI.
   *
   * Скачивает части последовательно с SHA-256 верификацией каждой части
   * и потоковым переносом в целевой файл.
   */
  private async tdlibFfiMultiDownload(
    downloadId: string,
    parts: MultiPartDescriptor[],
    outputPath: string,
    fileName: string | null,
    /** Поколение операции: события отменённой попытки игнорируются. */
    epoch: number = this._epoch,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let unlisten: UnlistenFn[] = [];

      const stop = (): void => {
        for (const fn of unlisten) fn();
        // BUG-DOWNLOAD-049: часть/задание завершились — watchdog не нужен.
        this._stopStallWatchdog();
      };

      const onProgress = (p: TdlibFfiMultiDownloadProgress) => {
        if (p.download_id !== downloadId) return;
        // Отменённая попытка: не пишем прогресс в UI (там уже новая операция).
        if (!this._isCurrent(epoch)) {
          stop();
          reject(new Error("Download cancelled by user"));
          return;
        }
        
        // Сырые байты → TransferMeter; ETA/скорость рендерит UI по своей оценке
        this.progress.report(Number(p.downloaded_bytes), Number(p.total_bytes), {
          partLabel: `Part ${p.current_part_index + 1}/${p.total_parts}`,
        });
        // BUG-DOWNLOAD-049: движок прислал байты — обрыва нет.
        this._stallWd?.progress();

        // BUG-CANCEL-RESUME-002: «cancelled by user» приходит от Rust-отмены
        // (cancel_multi_download). Это НЕ ошибка скачивания — не показываем
        // пользователю красный error и не путаем с реальным сбоем.
        const isCancel = p.error ? /cancelled by user/i.test(p.error) : false;

        // Логируем ошибки
        if (p.error) {
          this.log(
            isCancel
              ? `TDLib multi-download cancelled: ${p.error}`
              : `TDLib multi-download error: ${p.error}`,
            isCancel ? "warn" : "error",
          );
        }

        // Завершение (success или error)
        if (p.completed || p.error) {
          stop();
          if (p.error) {
            // Нормализуем в «Download cancelled by user» — outer catch уже
            // трактует это как отмену, а не как сбой.
            reject(new Error(isCancel ? "Download cancelled by user" : p.error));
          } else {
            resolve(outputPath);
          }
        }
      };

      // Регистрируем слушатели ДО вызова команды
      this._startStallWatchdog();
      listen<TdlibFfiMultiDownloadProgress>("tdlib-multi-download-progress", (e) => onProgress(e.payload))
      .then((fn) => {
        unlisten = [fn];
        invoke<string>("tdlib_start_multi_download", {
          downloadId,
          parts,
          outputPath,
          fileName,
        }).catch((e: any) => {
          for (const f of unlisten) f();
          this._stopStallWatchdog();
          reject(e);
        });
      }).catch((e: any) => {
        this._stopStallWatchdog();
        reject(e);
      });
    });
  }

  /** Очистить файловый кеш TDLib (/tmp/tdlib_files и /tmp/tdlib_download_parts). */
  private async clearTdlibCache(): Promise<void> {
    this.clearCacheBtn.disabled = true;
    this.clearCacheResult.textContent = t("download.cache_clearing");
    try {
      await invoke<string>("tdlib_clear_cache");
      this.clearCacheResult.textContent = t("download.cache_cleared");
    } catch (e: any) {
      this.clearCacheResult.textContent = `❌ ${e?.message ?? e}`;
    } finally {
      this.clearCacheBtn.disabled = false;
    }
  }

  /** Отменить TDLib JSON FFI download. */
  private async tdlibFfiCancel(fileId: number): Promise<void> {
    try {
      await invoke<string>("tdlib_cancel_download", { fileId });
      this.log(`TDLib JSON FFI download cancelled (file_id=${fileId})`, "info");
    } catch (e: any) {
      this.log(`TDLib JSON FFI cancel error: ${e?.message ?? e}`, "warn");
    }
  }

  /** Получить список активных TDLib JSON FFI download'ов */
  private async tdlibFfiGetDownloads(): Promise<TdlibFfiDownloadProgress[]> {
    try {
      return await invoke<TdlibFfiDownloadProgress[]>("tdlib_get_downloads");
    } catch {
      return [];
    }
  }

  /** Форматировать скорость — утилита из ui/format (единое форматирование). */

  /**
   * Вызвать Tauri invoke с таймаутом.
   * Используется для getRemoteFile и joinChat (могут висеть при network issues).
   */
  private async _invokeWithTimeout<T>(
    cmd: string,
    args: Record<string, unknown>,
    timeoutMs: number = 15000,
  ): Promise<T> {
    // Используем Promise.race для таймаута
    const result = await Promise.race([
      invoke<T>(cmd, args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Invoke timeout: ${cmd} (${timeoutMs}ms)`)), timeoutMs)
      ),
    ]);
    return result;
  }

  /** Проверить, является ли tg_file_id TDLib-совместимым (base64 remote_file_id). */
  private _isTdlibRemoteFileId(tg_file_id: string): boolean {
    // TDLib remote_file_id — это base64-строка (не число).
    // MTProto numeric ID — это строка из цифр (единый предикат — downloadParts).
    return isTdlibRemoteFileId(tg_file_id);
  }

  /**
   * Single-part: remote-file резолв с учётом PM-Lease.
   *
   * BUG-DOWNLOAD-051: для pm_lease `tg_file_id` — Vault-якорь (bot-side file_id),
   * который сессия юзера не резолвит (`getRemoteFile → 400 Invalid remote file
   * identifier`). Если сервер отдал PM-якорь доставки (`pm_delivery`) —
   * резолвим document СВОЕГО PM-сообщения (паритет с owner-download:
   * `tdlib_get_message_file` → getMessage + fallback getChatHistory).
   *
   * BUG-DOWNLOAD-052: доставка идёт по bot-side id (TDLib клиента = `real << 20`)
   * и в PM живут посторонние документы (свои upload-сообщения) — передаём
   * `uniqueId`/`expectedSize`, тогда Rust резолвит СТРОГО (никакого «самого
   * свежего документа» вместо своей части).
   */
  private async _resolveSingleRemoteInfo(
    remotePart: MultiPartDescriptor,
    serverPart:
      | { pm_delivery?: { chat_id?: number; message_id?: number; unique_id?: string | null } }
      | undefined,
    chatId: number | null,
  ): Promise<{ file_id: number; size: number }> {
    const pmChatId = serverPart?.pm_delivery?.chat_id ?? null;
    const pmMessageId = serverPart?.pm_delivery?.message_id ?? null;
    const pmUniqueId =
      serverPart?.pm_delivery?.unique_id ?? remotePart.pm_unique_id ?? null;
    const expectedSize = remotePart.expected_size ?? null;
    if (pmChatId && pmMessageId) {
      try {
        const resolved = await this._invokeWithTimeout<{
          file_id: number; size: number; file_name?: string;
        }>(
          "tdlib_get_message_file",
          {
            chatId: pmChatId,
            messageId: pmMessageId,
            uniqueId: pmUniqueId ?? undefined,
            expectedSize: expectedSize ?? undefined,
          },
          15000,
        );
        if (resolved && resolved.file_id) {
          this._debugLog("tdlib:fastpath:pm_delivery:resolved", {
            trace_id: this._traceId,
            pm_chat_id: pmChatId,
            pm_message_id: pmMessageId,
            file_id: resolved.file_id,
            size: resolved.size,
          });
          return { file_id: resolved.file_id, size: resolved.size };
        }
        this.log("TDLib PM-delivery resolve returned no file_id — getRemoteFile fallback", "warn");
      } catch (pmErr: any) {
        const pmMsg = pmErr?.message ?? String(pmErr ?? "unknown");
        this.log(`TDLib PM-delivery resolve failed: ${pmMsg} — getRemoteFile fallback`, "warn");
        this._debugLog("tdlib:fastpath:pm_delivery:error", {
          trace_id: this._traceId,
          pm_chat_id: pmChatId,
          pm_message_id: pmMessageId,
          error: pmMsg,
        });
      }
    }
    return await this._invokeWithTimeout<{ file_id: number; size: number }>(
      "tdlib_get_remote_file",
      {
        remoteFileId: remotePart.tg_file_id,
        chatId: chatId,
      },
      15000,  // 15s timeout (TDLib internal timeout is 10s, add 5s buffer)
    );
  }

  /**
   * Выполнить Fast Path: TDLib JSON FFI single/multi download.
   *
   * @throws Error если Fast Path не удался (fallback на MTProto)
   */
  private async _executeTdlibFastPath(
    dlInit: DownloadInitResponse,
    downloadId: string,
    savePath: string,
    resolvedName: string,
    /** Поколение операции (Cancel инвалидирует попытку). */
    epoch: number,
  ): Promise<void> {
    const rawTgFileId = dlInit.parts[0]?.tg_file_id;
    // BUG-DOWNLOAD-027: Извлекаем tg_chat_id из mtproto первой части (для getChat)
    const firstPartMtproto = dlInit.parts[0]?.mtproto;
    const chatId: number | null = firstPartMtproto?.mtproto_chat_id ?? null;
    // BUG-DOWNLOAD-034: Извлекаем message_id для getMessage перед downloadFile
    const messageId: number | null = firstPartMtproto?.mtproto_message_id ?? null;

    this._debugLog("tdlib:fastpath:start", {
      trace_id: this._traceId,
      parts_count: dlInit.parts.length,
      strategy: dlInit.download_strategy,
      tg_file_id_present: !!rawTgFileId,
      tg_file_id_length: rawTgFileId?.length ?? 0,
      tg_file_id_preview: rawTgFileId ? rawTgFileId.slice(0, 20) : null,
      is_tdlib_compatible: rawTgFileId ? this._isTdlibRemoteFileId(rawTgFileId) : false,
      chat_id: chatId,       // BUG-DOWNLOAD-027
      message_id: messageId, // BUG-DOWNLOAD-034
    });

    // ═══════════════════════════════════════════════════════════════════
    // ║  Вариант А: joinChat — присоединиться к storage чату           ║
    // ║  TDLib должен быть участником чата, чтобы получить remote file ║
    // ╚══════════════════════════════════════════════════════════════════╝
    let joinChatSucceeded = true;   // BUG-DOWNLOAD-030: если joinChat не был вызван (нет chatId), считаем успехом
    // Host-Mediation (ADR): файл уже доставлен ботом в PM юзера (host_delivery) —
    // join/warmup storage-чата НЕ нужен и вреден (PM с ботом — не канал -100).
    const isHostDelivery = (dlInit as any)?.host_delivery === true;
    if (chatId && !isHostDelivery) {
      try {
        await this._invokeWithTimeout(
          "tdlib_join_chat",
          { chatId },
          15000,
        );
        this._debugLog("tdlib:fastpath:join_chat:ok", {
          trace_id: this._traceId,
          chat_id: chatId,
        });
      } catch (joinErr: any) {
        const joinMsg = joinErr?.message ?? String(joinErr ?? "unknown");
        this._debugLog("tdlib:fastpath:join_chat:error", {
          trace_id: this._traceId,
          chat_id: chatId,
          error: joinMsg,
        });
        this.log(`⚠️ TDLib joinChat: ${joinMsg}`, "warn");

        // ═══════════════════════════════════════════════════════════════════
        // BUG-CROSS-USER-DOWNLOAD-002: fallback joinChatByInviteLink
        // ═══════════════════════════════════════════════════════════════════
        // Если joinChat не удался (Chat not found для private supergroup),
        // пробуем присоединиться через invite link из download init response.
        // Это позволяет скачивать файлы из private storage чатов, куда
        // пользователь ещё не присоединился.
        if (dlInit.storage_chat_invite_link) {
          try {
            this._debugLog("tdlib:fastpath:join_chat_by_invite_link:try", {
              trace_id: this._traceId,
              chat_id: chatId,
            });
            // BUG-CROSS-USER-DOWNLOAD-004: Передаём chat_id для getChat warmup.
            // Rust tdlib_join_chat_by_invite_link после успешного join (или
            // USER_ALREADY_PARTICIPANT) вызывает getChat с этим chat_id, чтобы
            // принудительно закешировать чат в TDLib. Без этого downloadFile
            // не может определить размер файла (total=0).
            await this._invokeWithTimeout(
              "tdlib_join_chat_by_invite_link",
              {
                inviteLink: dlInit.storage_chat_invite_link,
                chatId: chatId,
              },
              15000,
            );
            this._debugLog("tdlib:fastpath:join_chat_by_invite_link:ok", {
              trace_id: this._traceId,
              chat_id: chatId,
            });
            this.log("✅ Joined the storage chat via invite link", "success");
            joinChatSucceeded = true;
          } catch (inviteErr: any) {
            const inviteMsg = inviteErr?.message ?? String(inviteErr ?? "unknown");
            this._debugLog("tdlib:fastpath:join_chat_by_invite_link:error", {
              trace_id: this._traceId,
              error: inviteMsg,
            });
            this.log(`⚠️ TDLib joinChatByInviteLink: ${inviteMsg}`, "warn");
            // joinChatSucceeded остаётся false — используем короткий таймаут
          }
        } else {
          // BUG-DOWNLOAD-030: joinChat не удался и нет invite link —
          // TDLib не сможет скачать файл из этого чата.
          // Пробуем Fast Path с коротким таймаутом (10s), чтобы быстро упасть на proxy.
          joinChatSucceeded = false;
        }
      }
    }

    const remoteParts: MultiPartDescriptor[] = buildMultiPartDescriptors(
      dlInit.parts as any,
      chatId,
    );

    if (remoteParts.length === 0) {
      this._debugLog("tdlib:fastpath:no_tdlib_id", {
        trace_id: this._traceId,
        reason: rawTgFileId && !this._isTdlibRemoteFileId(rawTgFileId)
          ? "tg_file_id is MTProto numeric, not TDLib base64 — skipping Fast Path"
          : "No tg_file_id at all",
        raw_tg_file_id: rawTgFileId ?? null,
      });
      this.log("TDLib JSON FFI: no TDLib-compatible tg_file_id, falling back to MTProto...", "warn");
      throw new Error("No TDLib-compatible remote_file_id");
    }

    if (dlInit.download_strategy === "single") {
      // ═══ Single-part — прямой TDLib download ═══
      this._rcaOp = "single";
      this.log("Trying TDLib JSON FFI direct download (single strategy)...", "info");

      this._debugLog("tdlib:fastpath:get_remote_file", {
        trace_id: this._traceId,
        tg_file_id_preview: remoteParts[0].tg_file_id.slice(0, 30),
        expected_size: remoteParts[0].expected_size,
      });

      let remoteInfo: { file_id: number; size: number };
      try {
        // BUG-CROSS-USER-DOWNLOAD-005 + BUG-DOWNLOAD-051: pm_lease → резолв
        // СВОЕГО PM-сообщения (Vault-якорь в сессии юзера не резолвится),
        // иначе обычный getRemoteFile(chat_id-подсказка).
        remoteInfo = await this._resolveSingleRemoteInfo(
          remoteParts[0], dlInit.parts[0], chatId,
        );
      } catch (invokeErr: any) {
        const errMsg = invokeErr?.message ?? String(invokeErr ?? "unknown");
        this._debugLog("tdlib:fastpath:get_remote_file:error", {
          trace_id: this._traceId,
          error: errMsg,
          tg_file_id_preview: remoteParts[0].tg_file_id.slice(0, 30),
        });
        this.log(`TDLib getRemoteFile failed: ${errMsg}`, "warn");
        throw invokeErr;  // пробрасываем в startDownload() → catch → fallback
      }

      // BUG-DOWNLOAD-045: Сохраняем TDLib internal file_id для cancelDownload
      // getRemoteFile возвращает TDLib-внутренний file_id, который ОТЛИЧАЕТСЯ
      // от DB primary key (_currentFileId). Без этого cancelDownload() отправляет
      // cancelDownloadFile с неверным file_id, cancelled event не доходит до
      // tdlibFfiDownload listener, промис зависает навсегда, кнопка не разблокируется.
      this._currentTdlibFileId = remoteInfo.file_id;

      this._debugLog("tdlib:fastpath:get_remote_file:ok", {
        trace_id: this._traceId,
        file_id: remoteInfo.file_id,
        size: remoteInfo.size,
        chat_id: chatId,       // BUG-DOWNLOAD-027
      });

      // BUG-DOWNLOAD-030: если joinChat не удался — используем короткий таймаут (10s),
      // чтобы быстро упасть на proxy download вместо ожидания 20s
      const fastPathTimeout = joinChatSucceeded ? 20000 : 10000;
      this.log(`⏱ Download actually started: ${this._fmtTime(new Date())}`, "info");
      await this.tdlibFfiDownload(
        remoteInfo.file_id, 32, 0, 0, savePath, chatId, messageId, fastPathTimeout, epoch,
      );
      this.log(`⏱ Download actually finished: ${this._fmtTime(new Date())}`, "success");
      this.log("TDLib JSON FFI download completed", "success");
    } else {
      // ═══ Multi-part — sequential part accumulator ═══
      // BUG-CANCEL-RESUME-002: id включает epoch → он УНИКАЛЕН на попытку.
      // Сервер при retry в пределах оплаченного lease возвращает тот же
      // download_id, поэтому старый `multi_${downloadId}` совпадал у зомби- и
      // новой попытки: событие об ошибке зомби проходило фильтр
      // `p.download_id === downloadId` и мгновенно убивало новую загрузку.
      const multiId = `multi_${downloadId}_${epoch}`;
      this._currentMultiId = multiId;
      this._rcaOp = "multi";
      this.log(`Trying TDLib JSON FFI multi-download (${remoteParts.length} parts, multi strategy)...`, "info");

      this.log(`⏱ Download actually started: ${this._fmtTime(new Date())}`, "info");
      await this.tdlibFfiMultiDownload(
        multiId,
        remoteParts,
        savePath,
        resolvedName,
        epoch,
      );
      this.log(`⏱ Download actually finished: ${this._fmtTime(new Date())}`, "success");
      this.log("TDLib JSON FFI multi-download completed", "success");
    }
  }

  /**
   * Host-Mediation PM-Lease (ADR 2026-09-06): резолвер панели подтверждения цены.
   * Пока кнопка не нажата — startDownload приостановлена (await).
   */
  private _priceConfirmResolver: ((ok: boolean) => void) | null = null;

  /** Показать панель подтверждения цены; resolve(true) — кнопка «Скачать». */
  private async _askPriceConfirm(cost: number): Promise<boolean> {
    if (cost <= 0) return true; // self/free — подтверждение не требуется
    return new Promise<boolean>((resolve) => {
      this._priceConfirmResolver = resolve;
      this.downloadConfirmPriceText.textContent = `${cost} ⭐`;
      this.priceConfirmPanel.style.display = "block";
    });
  }

  /** Обработчик кнопок панели подтверждения (bindEvents). */
  private _confirmPrice(ok: boolean): void {
    this.priceConfirmPanel.style.display = "none";
    const r = this._priceConfirmResolver;
    this._priceConfirmResolver = null;
    if (r) r(ok);
  }

  /**
   * П.4: диалог «Оставить архивом? ДА/НЕТ» перед вызовом проводника.
   *
   * Показывается ТОЛЬКО для нашего контейнера (bundle: zip/tar.zst) — чужой
   * архив и сырьё и так не распаковываются. Ответ действует на ЭТУ операцию
   * (`_keepPackedDialogAnswer`, не трогает persist) и применяется в решении
   * `decideDownloadAction` через `keepPackedChoice()`. Ошибка моста → null
   * (тихо берём persist-чекбокс — скачивание не должно рушиться из-за диалога).
   *
   * Вызывается в обеих точках входа (public Поиск / personal Передача) ДО save().
   */
  private async _askKeepPackedDialog(isBundle: boolean): Promise<void> {
    this._keepPackedDialogAnswer = null;
    if (!isBundle) return;
    try {
      this._keepPackedDialogAnswer = await ask(t("download.keep_ask_msg"), {
        title: t("download.keep_ask_title"),
        okLabel: t("download.keep_ask_yes"),
        cancelLabel: t("download.keep_ask_no"),
      });
    } catch (e) {
      console.warn("keep-packed dialog failed:", e);
      this._keepPackedDialogAnswer = null;
    }
  }

  /** Эффективный keepPacked для текущей операции: диалог > persist-чекбокс. */
  private _effectiveKeepPacked(): boolean {
    return keepPackedChoice(this._keepPackedDialogAnswer, this.keepPackedCheckbox.checked);
  }

  /** Скрыть/сбросить lease-панели (вызывается при новом download / cancel). */
  private _resetLeaseUI(): void {
    this.priceConfirmPanel.style.display = "none";
    this.retryPanel.style.display = "none";
    // Новый (не retry) старт: watchdog прошлой операции не должен тикать.
    this._stopStallWatchdog();
    const resolver = this._priceConfirmResolver;
    this._priceConfirmResolver = null;
    if (resolver) resolver(false);
    this._hostStarted = false;
    this._leaseDownloadId = null;
    this._leaseFileId = null;
    this._leaseExpiresAt = null;
    this._retrySavePath = null;
    this._retryResolvedName = null;
    this._retryIsBundle = false;
  }

  /**
   * UI «Повторить бесплатно» (ADR §3/§4): обрыв/complete(false) ПОСЛЕ start.
   * Повторный init/start того же file_id возвращает активный lease (download_id
   * тот же, списание НЕ повторяется) — повторяем поток с тем же файлом.
   */
  /** Показать панель «Повторити безкоштовно» (ADR §3 — обрыв после оплаченного start). */
  private _showRetryPanel(): void {
    if (!this.retryPanel) return;
    this._refreshRetryLease();
    this.retryPanel.style.display = "block";
  }

  /** Пересчёт текста лизинга на панели retry (общий для показа и смены языка). */
  private _refreshRetryLease(): void {
    if (!this.downloadRetryLeaseText) return;
    if (this._leaseExpiresAt) {
      let mins = 0;
      try {
        mins = Math.max(0, Math.floor((new Date(this._leaseExpiresAt).getTime() - Date.now()) / 60000));
      } catch { /* ignore */ }
      this.downloadRetryLeaseText.textContent = mins > 0
        ? t("download.msg.lease_min", { mins })
        : "";
    } else {
      this.downloadRetryLeaseText.textContent = "";
    }
  }

  /**
   * Перерисовать user-facing состояние после смены языка.
   *
   * Статика (карточки, кнопки) покрыта applyStaticI18n; здесь обновляются
   * динамические тексты, которые были выставлены в момент события:
   * срок лизинга на retry-панели. Выполняется даже для неактивной вкладки —
   * иначе текст «залипает» на старом языке.
   */
  applyLang(): void {
    this._refreshRetryLease();
    // Keep-packed: подпись чекбокса — на новом языке, форму не трогаем.
    if (this.keepPackedLabel) {
      this.keepPackedLabel.textContent = t("download.keep_packed_label");
    }
  }

  /**
   * Keep-packed: видимость чекбокса «Оставить архивом».
   *
   * Показываем ТОЛЬКО для bundle (isBundle по манифесту/magic уже резолвнут):
   * для чужого/сырого — скрыт (распаковки нет ни при каком чекбоксе).
   * i18n-правило: только display, без пересоздания.
   */
  private _refreshKeepPackedRow(isBundle: boolean): void {
    if (!this.keepPackedRow) return;
    this.keepPackedRow.style.display = isBundle ? "flex" : "none";
  }

  /**
   * Keep-packed: первые N байт сохранённого файла (peek_file_header) для
   * детекта контейнера (ZIP `PK` vs zstd `28 B5 2F FD`). Не грузит файл
   * целиком — важно для бандлов 4+ GiB. Ошибка → пустой заголовок (fail-open:
   * дальше решает имя, чужое — fail-closed в keep_file).
   */
  private async _peekHeader(path: string, n = 8): Promise<number[]> {
    try {
      return await invoke<number[]>("peek_file_header", { path, n });
    } catch {
      return [];
    }
  }

  /**
   * Повтор загрузки в пределах оплаченного lease (бесплатно).
   *
   * Не стартует, пока идёт закрытие отменённой операции (`_cancelling`) и
   * пока есть подтверждённый сервером lease-контекст (`_leaseFileId` +
   * путь). Иначе «Повторить» запускало новую сессию поверх висящего job.
   */
  private async _retryDownload(): Promise<void> {
    if (this._cancelling) {
      this.log("Cancel is still in progress — retry is not possible yet", "warn");
      return;
    }
    if (this._leaseFileId == null || this._retrySavePath == null) {
      this.retryPanel.style.display = "none";
      this.log("No active paid session — start a new download", "warn");
      return;
    }
    this.retryPanel.style.display = "none";
    this.fileIdInput.value = String(this._leaseFileId);
    this.log("Repeated download (within the lease, no charge)...", "info");
    await this.startDownload({ retry: true });
  }

  /**
   * Запустить скачивание файла.
   *
   * @param opts.retry — повтор в рамках уже оплаченного lease: НЕ сбрасывает
   *   lease-контекст (иначе «Повторить бесплатно» теряло savePath/имя/isBundle)
   *   и переиспользует download_id, который вернёт сервер (`reused_active_lease`).
   */
  private async startDownload(opts?: { retry?: boolean }): Promise<void> {
    // Отменённая операция ещё закрывается — новый старт поверх неё запрещён.
    if (this._cancelling) {
      this.log("Cancel is still in progress — try again in a moment", "warn");
      return;
    }
    // ═══════════════════════════════════════════════════════════════════
    //  Единая проверка авторизации (централизованный auth.ts)
    //  Все модули используют ОДИН И ТОТ ЖЕ механизм — auth происходит
    //  один раз при входе в клиент и работает для всех модулей.
    // ═══════════════════════════════════════════════════════════════════
    if (!requireAuth(this.log)) return;

    const fileIdStr = this.fileIdInput.value.trim();
    if (!fileIdStr) return;

    const fileId = parseInt(fileIdStr, 10);
    if (isNaN(fileId)) {
      this.log("Enter a numeric file ID", "error");
      return;
    }

    // ── Новое поколение операции + сброс состояния + trace_id ──
    const epoch = ++this._epoch;
    this.cancelled = false;
    this._currentFileId = fileId;
    this._currentTdlibFileId = null;  // сбрасываем для нового download
    this._currentMultiId = null;
    this.abortController = new AbortController();
    this._transferActive = true; // гибридный старт из поиска: чип на SearchPage

    // Новый download (не retry) — lease-контекст прошлого файла больше не валиден.
    // Без сброса «Повторить бесплатно» могло уйти в lease ДРУГОГО файла.
    if (!opts?.retry) {
      this._resetLeaseUI();
    }
    this._currentDownloadId = null;

    this.startBtn.disabled = true;
    this.fileIdInput.disabled = true;
    this.cancelBtn.style.display = "inline-flex";
    this.cancelBtn.disabled = false;
    this.progressContainer.style.display = "block";
    this.progress.reset();
    this.logEl.innerHTML = "";
    this.fileInfo.style.display = "none";

    this._traceId = this._generateTraceId();
    this._debugContentEl.textContent = "";
    this._debugTraceIdEl.textContent = this._traceId;

    let downloadId: string | null = null;

    try {
      api.setTraceId(this._traceId);

      this._debugLog("downloadInit:request", {
        trace_id: this._traceId,
        file_id: fileId,
        method: "POST",
        url: "/desktop/downloads/init",
        body: { file_id: fileId },
      });

      let dlInit: DownloadInitResponse;
      try {
        dlInit = await api.downloadInit(fileId);
      } catch (initErr: any) {
        const initMsg = initErr?.message ?? String(initErr ?? "unknown");
        this._debugLog("downloadInit:error", {
          trace_id: this._traceId,
          file_id: fileId,
          error: initMsg,
          hint: initMsg.includes("API ")
            ? "Server returned an HTTP error — check the error field in the response body"
            : "Network error — server unreachable or not responding",
        });
        // Settlement при выдаче (ADR §0.1): сервер может отклонить init по балансу
        if (/^API 402/.test(initMsg)) {
          throw new Error(t("download.msg.insufficient_points"));
        }
        throw initErr;
      }
      downloadId = dlInit.download_id;
      this._currentDownloadId = downloadId;

      this._debugLog("downloadInit", {
        trace_id: this._traceId,
        file_id: fileId,
        download_id: downloadId,
        parts_count: dlInit.parts.length,
        parts: dlInit.parts.map((p) => ({
          index: p.index,
          name: p.name,
          size: p.size,
          mtproto_present: p.mtproto !== undefined,
        })),
        manifest: dlInit.manifest
          ? { original_name: dlInit.manifest.original_name, size_bytes: dlInit.manifest.size_bytes, type: dlInit.manifest.type }
          : null,
      });

      // Cancellation checkpoint: пользователь мог нажать Отмена во время downloadInit
      await this._abortIfStale(epoch, downloadId);

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  Проверка доступа (checkAccess) — без списания баллов               ║
      // ║  Списание (chargePoints) выполняется ПОСЛЕ успешного TDLib download ║
      // ║  (Вариант Б: перенос списания после download)                       ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      const userTgId = this.getTgId();
      if (!userTgId) {
        throw new Error("Worker API: no tg_id — cannot check file access");
      }

      this.log("Checking access...", "info");
      const accessCheck = await api.checkAccess(fileId);

      if (!accessCheck.allow) {
        const reason = accessCheck.reason || t("download.msg.access_denied");
        const balanceInfo = accessCheck.balance !== undefined
          ? t("download.msg.balance_note", { balance: accessCheck.balance })
          : "";
        throw new Error(t("download.msg.access_denied_full", { reason, balance: balanceInfo }));
      }

      this.log("Access granted", "info");

      // Cancellation checkpoint: пользователь мог нажать Отмена во время checkAccess
      await this._abortIfStale(epoch, downloadId);

      // ⚡ BUG-FILENAME-001: трёхуровневый fallback original_name
      const resolvedName = (
        dlInit.manifest?.original_name
        || (dlInit.manifest?.brand && dlInit.manifest?.model
          ? `${dlInit.manifest.brand}_${dlInit.manifest.model}_${dlInit.manifest.version || ''}.zip`
          : null)
        || `file_${fileId}`
      );

      // BUG-DESKTOP-UI-005: isBundle считается ПОСЛЕ resolvedName — fallback
      // для записей, где type потерян на сервере (расширение .zip/.tar.zst).
      // Основной источник — type из download-манифеста.
      // Фаза 3: контейнер ожидаем по манифесту (`container`) или по имени —
      // tar.zst-бандлы больше не «теряются» (раньше проверялся только `.zip`).
      const expectedContainer = expectedContainerName(dlInit.manifest?.container, resolvedName);
      let isBundle =
        dlInit.manifest?.type === "firmware_bundle" ||
        expectedContainer !== null;

      this.fileInfo.style.display = "block";
      this.fileNameEl.textContent = resolvedName;
      this.fileSizeEl.textContent = this.formatSize(dlInit.manifest?.size_bytes || 0);
      this.partsCountEl.textContent = t("download.parts_count", { n: dlInit.parts.length });

      this.log(`File: ${dlInit.manifest?.original_name || "unknown"}`, "info");
      this.log(`Type: ${isBundle ? "Bundle" : "File"}`, "info");
      this.log(`Parts: ${dlInit.parts.length}`, "info");

      // 2. Choose save path
      this.log("Choose save path...", "info");

      // П.4: диалог «Оставить архивом?» ПЕРЕД проводником (для нашего
      // контейнера) — ответ действует на эту операцию (не трогает persist).
      await this._askKeepPackedDialog(isBundle);

      // Фаза 3: расширение по контейнеру (манифест → имя) — для ZIP `.zip`,
      // для tar.zst `.tar.zst` (раньше всегда дописывался `.zip`, из-за чего
      // tar.zst-бандлы сохранялись как `x.tar.zst.zip` и «не опознавались»).
      const expectedExt = expectedContainer ? containerExtension(expectedContainer) : "";
      const defaultName = resolvedName;
      const saveName =
        isBundle && expectedExt && !defaultName.toLowerCase().endsWith(expectedExt)
          ? `${defaultName}${expectedExt}`
          : defaultName;

      let savePath = await save({
        title: isBundle ? t("download.save_archive_title") : t("download.save_title"),
        defaultPath: saveName,
      });
      if (!savePath) {
        this.log("Cancelled by user", "warn");
        await this._closeSessionOnce(downloadId);
        return;
      }
      // BUG-CANCEL-FINAL-001: путь фиксируется сразу — отмена в любой момент
      // после выбора должна удалить недокачанный файл (см. cancelDownload).
      this._activeSavePath = savePath;
      this._activeOutputPath = savePath;

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  Host-Mediation PM-Lease (ADR 2026-09-06): init → path → confirm    ║
      // ║  → start (charge + deliver) → download PM parts → complete          ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      // init НЕ списывает и НЕ доставляет: PM-координаты и billing приходят из
      // POST /desktop/downloads/{id}/start. Retry (reused_active_lease) —
      // оплата уже выполнена, повторного списания нет.
      if (dlInit.host_mediation === true) {
        const cost = dlInit.price?.cost ?? 0;
        if (cost > 0 && !dlInit.reused_active_lease) {
          const ok = await this._askPriceConfirm(cost);
          if (!ok) {
            this.log("Download cancelled before charging", "warn");
            // cancel до start: complete(false) на initiated → cancelled (без списания).
            await this._closeSessionOnce(downloadId);
            return;
          }
        }
        let startResp: DownloadStartResponse;
        try {
          this.log("Charging points and preparing the file...", "info");
          startResp = await api.downloadStart(downloadId);
        } catch (startErr: any) {
          const msg = startErr?.message ?? String(startErr ?? "unknown");
          this._debugLog("downloadStart:error", {
            trace_id: this._traceId,
            download_id: downloadId,
            error: msg,
          });
          if (/^API 402/.test(msg)) {
            await this._closeSessionOnce(downloadId);
            throw new Error(t("download.msg.insufficient_points"));
          }
          throw startErr;
        }
        // С этого момента сессия оплачена (capture). Обрыв/complete(false) →
        // НЕ refund; UI «Повторити безкоштовно» в пределах lease.
        this._hostStarted = true;
        this._leaseDownloadId = downloadId;
        this._leaseFileId = fileId;
        this._leaseExpiresAt = startResp.lease_expires_at ?? null;
        this._retrySavePath = savePath;
        this._retryResolvedName = resolvedName;
        this._retryIsBundle = isBundle;

        // Координаты PM-доставки (не Vault!) для скачивания берём из start.
        if (startResp.parts && startResp.parts.length > 0) {
          dlInit.parts = startResp.parts;
        }
        dlInit.host_delivery = startResp.host_delivery ?? true;
        dlInit.billing = startResp.billing;
        this._debugLog("downloadStart:ok", {
          trace_id: this._traceId,
          download_id: downloadId,
          status: startResp.status,
          parts: startResp.parts.length,
          charged: startResp.billing?.charged ?? 0,
          balance_after: startResp.billing?.balance_after ?? null,
        });
        // «Баллы списаны / остаток» отображаются штатным блоком billing ПОСЛЕ
        // успешного download (см. dlInit.host_delivery === true ниже).
      }

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  Фаза 2: Выбор стратегии скачивания                                ║
      // ║                                                                     ║
      // ║  download_strategy приходит из БД (BUG-DOWNLOAD-010):              ║
      // ║  'single' — файл ≤2GB, прямой TDLib downloadFile в savePath.      ║
      // ║  'multi'  — файл >2GB, разбит на части, composite download.       ║
      // ║                                                                     ║
      // ║  TDLib Fast Path: проверяется первым для ВСЕХ стратегий,           ║
      // ║  без MTProto подготовки (caps, Telegram auth, metadata).           ║
      // ║  MTProto Slow Path — только если TDLib не готов или упал.          ║
      // ╚══════════════════════════════════════════════════════════════════════╝

      let downloadSucceeded = false;

      // ═══════════════════════════════════════════════════════════════════════
      // ║  Fast Path: TDLib JSON FFI (все стратегии)                         ║
      // ║  — Без MTProto metadata check, без getCapabilities,               ║
      // ║    без Telegram auth, без "Direct MTProto download ready"         ║
      // ║  — TDLib использует свой собственный auth-стек                   ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      this.progress.setMessage(t("download.preparing"));
      this.progress.update(0, t("download.preparing"));

      // Проверка TDLib runtime (без caps — _checkTdlibFfiStatus получит
      // параметры runtime через api.getCapabilities при необходимости)
      const tdlibFfiReady = await this._checkTdlibFfiStatus();

      // Cancellation checkpoint: пользователь мог нажать Отмена во время checkTdlibFfiStatus
      await this._abortIfStale(epoch, downloadId);

      // ── Fast Path: TDLib ready → download. Иначе → fallback на MTProto ──
      if (tdlibFfiReady) {
        // ╔══════════════════════════════════════════════════════════════════╗
        // ║  Fast Path: TDLib уже ready (сохранённая сессия)                ║
        // ╚══════════════════════════════════════════════════════════════════╝
        // BUG-DOWNLOAD-027: try/catch вместо прямого await, чтобы при ошибке
        // Fast Path (таймаут, getRemoteFile fail, etc.) выполнение падало в
        // MTProto Slow Path, а не во внешний catch (line 943).
        try {
          await this._executeTdlibFastPath(dlInit, downloadId, savePath, resolvedName, epoch);
          downloadSucceeded = true;

          // ╔══════════════════════════════════════════════════════════════════╗
          // ║  Списание баллов                                                ║
          // ║  Host-режим (host_delivery): списание выполнено СЕРВЕРОМ в init ║
          // ║  ДО выдачи файла в PM (Settlement при выдаче, ADR §0.1).        ║
          // ║  Здесь НЕ вызываем chargePoints — иначе двойное списание.       ║
          // ║  Не-host: Вариант Б — списание после успешного TDLib download.  ║
          // ╚══════════════════════════════════════════════════════════════════╝
          if (dlInit.host_delivery === true) {
            this._debugLog("points:host_settled_at_init", {
              trace_id: this._traceId,
              file_id: fileId,
              user_tg_id: userTgId,
              billing: dlInit.billing ?? null,
            });
            const billing = dlInit.billing;
            if (billing?.charged && billing.charged > 0) {
              if (billing.balance_after !== undefined) {
                this.log(`✅ Points charged. Remaining: ${billing.balance_after}`, "success");
              } else {
                this.log("✅ Points charged", "success");
              }
              this.onBalanceChanged?.();
            } else if (billing?.note) {
              this.log(`ℹ️ ${billing.note}`, "info");
            } else {
              this.log("💳 Charge performed on the server", "info");
            }
          } else {
            this._debugLog("points:charge_after_download", {
              trace_id: this._traceId,
              file_id: fileId,
              user_tg_id: userTgId,
            });
            try {
              const chargeResult = await api.chargePoints(fileId);
              if (chargeResult.success === false) {
                const errMsg = chargeResult.error || t("download.msg.charge_unknown_error");
                this.log(`Failed to charge points: ${errMsg}`, "warn");
              } else if (chargeResult.charged && chargeResult.charged > 0) {
                // Реальное списание (не self-download)
                if (chargeResult.balance_after !== undefined) {
                  this.log(`Points charged. Remaining: ${chargeResult.balance_after}`, "success");
                } else {
                  this.log("Points charged", "success");
                }
                // Обновляем баланс в UI (header) немедленно
                this.onBalanceChanged?.();
              } else {
                // Self-download bypass: владелец скачал свой файл
                const note = chargeResult.note || t("download.msg.charge_self_note");
                this.log(`${note}`, "info");
              }
            } catch (chargeErr: any) {
              this.log(`Point charge error: ${chargeErr?.message ?? "unknown"}`, "warn");
              // Не фатально — файл уже скачан на диск
            }
          }
        } catch (fastPathErr: any) {
          const errMsg = fastPathErr?.message ?? String(fastPathErr ?? "unknown");
          this._debugLog("tdlib:fastpath:fallback", {
            trace_id: this._traceId,
            reason: errMsg,
          });
          // BUG-DOWNLOAD-032: Server Proxy Download удалён — это был мёртвый код,
          // всегда возвращавший 403 HMAC error. Data plane идёт напрямую к DC
          // через TDLib JSON FFI, без проксирования через VPS.
          // При ошибке Fast Path пробрасываем исключение — outer catch покажет
          // финальную ошибку с диагностикой.
          throw fastPathErr;
        }
      } else {
        this.log("TDLib JSON FFI not ready, falling back to MTProto path...", "warn");
      }

      // ═══════════════════════════════════════════════════════════════════════
      // ║  Slow Path: MTProto pipeline                                       ║
      // ║  — TDLib не готов или не сработал (любая стратегия)                ║
      // ║  — MTProto metadata check → Caps → Telegram auth →                ║
      // ║  → TDLib retry → Zero-Stitch MTProto → Server Transit             ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      if (!downloadSucceeded) {
        this._debugLog("mtproto:start", {
          trace_id: this._traceId,
          reason: "TDLib not available, falling back to MTProto",
          parts_count: dlInit.parts.length,
          has_mtproto_meta: dlInit.parts.every((p) => p.mtproto !== undefined),
        });

        // 1. Verify MTProto metadata presence
        const hasMtproto = dlInit.parts.length > 0 && dlInit.parts.every((p) => p.mtproto !== undefined);
        if (!hasMtproto) {
          this._debugLog("mtproto:no_metadata", {
            trace_id: this._traceId,
            error: "MTProto metadata not found",
          });
          throw new Error("MTProto metadata not found — direct download unavailable. File may have been uploaded before MTProto migration.");
        }

        const caps = await api.getCapabilities();
        if (!caps.telegram_api_id) {
          throw new Error("Server did not provide telegram_api_id");
        }

        // ⚡ SOCKS5 proxy — ОТКЛЮЧЁН
        // set_proxy_config удалён из Rust. Все MTProto соединения идут напрямую.
        // См. telegram_direct.rs — proxy-логика полностью вычищена.

        // ⚙️ Check TDLib runtime status
        // TDLib Local Bot API (HTTP на порту 8081) полностью удалён — см. BUG-DOWNLOAD-006 / Local Bot API removal.
        const tdlibFfiReady = await this._checkTdlibFfiStatus();
        this.log("Download ready (TDLib / MTProto)", "success");

        // ═══ Fast Path TDLib уже выполнен выше (line 831). ═══
        // Дублирующийся retry удалён — TDLib download уже был вызван в Fast Path.
        // Если Fast Path не сработал, TDLib не готов и retry не имеет смысла.

        // ═══════════════════════════════════════════════════════════════════════
        //  Hybrid Control Plane + Direct Data Plane
        //  Server-Transit удалён — медиа-трафик идёт напрямую через TDLib.
        //  VPS не проксирует байты, только бизнес-логику (init/complete).
        //
        //  См. ARCHITECTURE_HYBRID_CONTROL_DATA_PLANE_DOWNLOAD.md
        // ═══════════════════════════════════════════════════════════════════════
        if (!downloadSucceeded) {
          throw new Error(
            "TDLib Fast Path did not complete. " +
            "Direct Data Plane (TDLib JSON FFI) is the only download method. " +
            "Ensure TDLib is properly authorized and the storage chat is accessible."
          );
        }
      }

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  BUG-DESKTOP-UI-006 + Фаза 3: magic-детект КОНТЕЙНЕРА — последний    ║
      // ║  рубеж, если manifest type/имя потеряны (до фикса manifest_json      ║
      // ║  никогда не персистился). Читаем первые 8 байт сохранённого файла    ║
      // ║  (peek_file_header — файл целиком НЕ грузим: бандлы 4+ ГиБ) и        ║
      // ║  определяем контейнер: ZIP (`PK 03 04`) либо tar.zst (`28 B5 2F FD`).║
      // ║  Совпадение → дописываем расширение контейнера и распаковываем.      ║
      // ║  Чужие байты (fail-closed, V3) — не распаковываем, отдаём файлом.    ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      const headBytes = await this._peekHeader(savePath, 8);
      const container = detectDownloadContainer({
        manifestContainer: (dlInit.manifest as any)?.container ?? null,
        fileName: resolvedName,
        header: headBytes,
      });
      this.log(
        `container check: ${container} (header=${Array.from(headBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")})`,
        "debug",
      );
      this._debugLog("download:container_check", {
        trace_id: this._traceId,
        file_id: fileId,
        header: Array.from(headBytes),
        container,
        manifest_container: (dlInit.manifest as any)?.container ?? null,
      });

      if (container === "zip" || container === "tar_zst") {
        isBundle = true;
        // Имя без расширения контейнера (легаси-записи, папки) — дописываем:
        // иначе Windows не откроет файл двойным кликом, а extractDir считался
        // бы от неверного имени.
        const ext = containerExtension(container);
        if (!savePath.toLowerCase().endsWith(ext)) {
          const renamed = `${savePath}${ext}`;
          try {
            await invoke("rename_file", { from: savePath, to: renamed });
            this.log(`Renamed to: ${renamed}`, "info");
            savePath = renamed;
            // BUG-CANCEL-FINAL-001: отмена должна удалять ТЕКУЩЕЕ имя файла.
            this._activeSavePath = renamed;
            this._activeOutputPath = renamed;
          } catch (renameErr: any) {
            this.log(
              `⚠️ Rename to ${ext} failed: ${renameErr?.message ?? String(renameErr ?? "unknown")}`,
              "warn"
            );
            // Извлечение всё равно попробуем по исходному пути — unpack_archive
            // определяет контейнер по magic, а не по расширению.
          }
        }
      } else if (headBytes.length >= 4 && (isBundle || container === "foreign")) {
        // Байты прочитаны и это НЕ наш контейнер (чужой архив или вообще не
        // архив): распаковывать нельзя — только «сохранить как есть». Иначе
        // extract_archive честно падал бы уже после списания баллов.
        isBundle = false;
        this.log(
          container === "foreign"
            ? t("download.unpack_foreign_hint")
            : "⚠️ Manifest says bundle, but the bytes are not an archive — saving as is",
          "warn",
        );
      }
      // peek недоступен (пустой header) → остаёмся на решении по манифесту/имени
      // (fail-open: пробуем распаковать; ошибка будет честной, файл не потерян).

      // Диагностика: какой признак привёл к определению бандла
      this._debugLog("download:bundle_detection", {
        trace_id: this._traceId,
        file_id: fileId,
        manifest_type: dlInit.manifest?.type ?? null,
        manifest_container: (dlInit.manifest as any)?.container ?? null,
        container,
        is_bundle: isBundle,
      });

      // Keep-packed: чекбокс виден ТОЛЬКО для bundle; чужое/сырое —
      // без чекбокса (распаковки нет ни при каком состоянии).
      this._refreshKeepPackedRow(isBundle);

      // 6. Extract bundle if needed
      if (isBundle) {
        // Keep-packed (default OFF): checked → архив остаётся на диске +
        // подсказка (по формату контейнера). Контейнер уже определён выше
        // (манифест → magic → имя), повторный peek не нужен.
        const action = decideDownloadAction({
          container,
          keepPacked: this._effectiveKeepPacked(),
        });
        this._debugLog("download:container_action", {
          trace_id: this._traceId,
          file_id: fileId,
          container,
          action,
          keep_packed: this._effectiveKeepPacked(),
        });

        if (action === "keep_file") {
          // Не наш контейнер (.7z/.rar/… как bundle): отдаём валидным файлом
          // как есть — распаковка архиватором получателя (V3). Байты не трогаем.
          this.log(t("download.unpack_foreign_hint"), "info");
          this.log(`Saved: ${savePath}`, "success");
        } else if (action === "keep_archive") {
          this.log(t("download.kept_packed_hint", { path: savePath }), "info");
          this.log(`Saved: ${savePath}`, "success");
        } else {
          this.log(`Extracting... (${container})`, "info");
          this.progress.startBusy(t("download.unpacking_busy"));

          // Расширение контейнера срезаем целиком (`.tar.zst`, а не только
          // последний сегмент — иначе каталог получил бы имя `x.tar`).
          const ext = containerExtension(container) || ".zip";
          const extractDir = savePath.toLowerCase().endsWith(ext)
            ? savePath.slice(0, -ext.length)
            : savePath;
          // unpack_archive определяет контейнер сам (zip | tar.zst) и
          // возвращает распознанный — логируем его в UI/диагностику.
          let unpackErr: unknown = null;
          let unpacked: { container?: string } | null = null;
          try {
            unpacked = await invoke<{ container?: string }>("unpack_archive", {
              archivePath: savePath,
              outputDir: extractDir,
            });
          } catch (e) {
            unpackErr = e;
          }
          this.progress.stopBusy();
          if (unpackErr) throw unpackErr;
          this.log(
            `Extracted to: ${extractDir} (container=${unpacked?.container ?? container})`,
            "success",
          );

          // BUG-DESKTOP-UI-007: после распаковки удаляем сам архив
          // (savePath к этому моменту может быть переименован — magic-детект
          // BUG-006/Фазы 3 дописывает расширение, удаляем ТЕКУЩЕЕ имя)
          try {
            await invoke("delete_file", { path: savePath });
            this.log(`Archive removed: ${savePath}`, "info");
            this._debugLog("download:archive_removed", {
              trace_id: this._traceId,
              file_id: fileId,
              archive_path: savePath,
              container,
            });
          } catch (delErr: any) {
            this.log(
              `⚠️ Archive removal failed (the file can be deleted manually): ${delErr?.message ?? String(delErr ?? "unknown")}`,
              "warn"
            );
          }
        }
      } else {
        this.log(`Saved: ${savePath}`, "success");
      }

      // 7. Complete
      // Финальная проверка поколения: отменённая во время передачи попытка НЕ
      // должна подтверждать complete(true) — иначе сервер зафиксирует успех,
      // хотя пользователь отменил (и retry-панель станет бессмысленной).
      await this._abortIfStale(epoch, downloadId);
      await api.downloadComplete(downloadId, true);
      this.progress.setDone();
      // complete(true): PM-чистка выполнена на сервере — lease закрыт, retry не нужен.
      this._hostStarted = false;
      this.retryPanel.style.display = "none";
      // BUG-DOWNLOAD-050: успех закрывает lease — retry-контекст инвалидируем,
      // иначе watchdog (stall 90с после последнего прогресса — распаковка/
      // complete идут без байтов) стартует повторный download после окончания.
      this._leaseDownloadId = null;
      this._leaseFileId = null;
      this._leaseExpiresAt = null;
      this._retrySavePath = null;
      this._retryResolvedName = null;
      this._retryIsBundle = false;

      this._debugLog("download:complete", {
        trace_id: this._traceId,
        file_id: fileId,
        download_id: downloadId,
        method: "mtproto",
        status: "success",
      });
    } catch (e: any) {
      // Устаревшее поколение (Cancel/новый download) трактуем как отмену, а не
      // как ошибку: иначе отменённая попытка печатает «Error: …» и сбивает UI.
      const isCancelled =
        e.message === "Download cancelled by user" ||
        e.message === "Download cancelled" ||
        e.name === "AbortError" ||
        this.cancelled ||
        !this._isCurrent(epoch);

      this._debugLog("download:error", {
        trace_id: this._traceId,
        file_id: fileId,
        download_id: downloadId,
        error: typeof e === 'string' ? e : (e?.message ?? String(e ?? 'unknown')),
        is_cancelled: isCancelled,
      });

      // Host-Mediation PM-Lease: после `start` баллы списаны (capture), обрыв/отмена —
      // НЕ refund. Показываем «Повторити безкоштовно» (в пределах lease).
      const hostStarted = this._hostStarted && downloadId != null;
      if (isCancelled) {
        this.log("Download cancelled", "warn");
        // Сессия уже закрыта (Cancel) или закрывается сейчас — ровно один раз.
        await this._closeSessionOnce(downloadId);
        // BUG-CANCEL-FINAL-001: отмена есть ФИНАЛ — retry-панель НЕ показываем
        // (lease на сервере жив → повтор того же файла бесплатен и без панели).
        // UI.progress уже сброшен cancelDownload'ом; если поколение устарело из-за
        // НОВОГО старта, UI принадлежит новой попытке — не трогаем.
        if (this._isCurrent(epoch)) {
          this.progress.setCancelled();
        }
      } else {
        const errMsg = typeof e === 'string' ? e : (e?.message ?? String(e ?? 'unknown'));
        this.log(`Error: ${errMsg}`, "error");
        if (hostStarted) {
          // Обрыв после start: файл в PM валиден до TTL, повтор — бесплатный.
          this.progress.setMessage(t("download.msg.progress_error_paid"));
          this._showRetryPanel();
        } else {
          this.progress.setError(`Error: ${errMsg}`);
        }
      }
    } finally {
      // UI трогаем ТОЛЬКО если поколение актуально: отменённая/устаревшая попытка
      // не должна перезаписывать состояние новой (кнопки/controller уже сброшены
      // Cancel'ом или установлены новым стартом).
      if (this._isCurrent(epoch)) {
        this.startBtn.disabled = false;
        this.fileIdInput.disabled = false;
        this.cancelBtn.style.display = "none";
        this.cancelBtn.disabled = true;
        this.abortController = null;
        this._currentMultiId = null;
        this._transferActive = false;
        // BUG-CANCEL-FINAL-001: координаты файла живут только внутри операции —
        // после финала (успех/ошибка) отмена не должна снести готовый файл.
        this._activeSavePath = null;
        this._activeOutputPath = null;
      }

      api.clearTraceId();

    }
  }

  /**
   * Личное хранилище: скачать СВОЙ личный файл (self-download из своего PM).
   *
   * Файл физически в PM юзера (свой PM с Host-ботом). Серверный vaultDownloadInit
   * возвращает mtproto-meta (chat_id = свой PM, message_id) — скачиваем напрямую
   * через TDLib self-download (НЕ списывает баллы, НЕ требует join).
   * SPEC docs/ARCHITECTURE_VAULT_STORAGE.md §5.2.
   */
  async downloadPersonal(pfId: number): Promise<void> {
    if (!requireAuth(this.log)) return;
    if (this._cancelling) {
      this.log("Cancel is still in progress — try again in a moment", "warn");
      return;
    }

    const epoch = ++this._epoch;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.startBtn.disabled = true;
    this.cancelBtn.style.display = "inline-flex";
    this.cancelBtn.disabled = false;
    this.progressContainer.style.display = "block";
    this.progress.reset();
    this.logEl.innerHTML = "";
    this.fileInfo.style.display = "none";

    try {
      this.log(`🗄️ Preparing personal file #${pfId}...`, "info");
      const meta = await api.vaultDownloadInit(pfId);

      const resolvedName = meta.name || `personal_${pfId}`;

      // BUG-PERSONAL-BUNDLE-001: личный файл, залитый ПАПКОЙ, — это .zip-бандл
      // и после скачивания распаковывается (паритет с public vault). Раньше
      // downloadPersonal просто качал файл без распаковки, а метаданные личного
      // файла не хранили bundle_type (серверный фикс пишет его при complete +
      // отдаёт в download-meta как type). Определение бандла:
      //   1) type == "firmware_bundle" из download-meta (новые записи);
      //   2) fallback — имя заканчивается на .zip (старые записи без type);
      //   3) последний рубеж — zip-magic PK 03 04 после скачивания (легаси
      //      записи, залитые до фикса, где bundle_type не хранился вовсе).
      let isBundle =
        meta.type === "firmware_bundle" ||
        resolvedName.toLowerCase().endsWith(".zip");

      // Для бандла гарантируем суффикс .zip в имени по умолчанию — иначе
      // extractDir (имя без .zip) соберётся неверно для папок без расширения.
      const defaultName = isBundle
        ? (resolvedName.toLowerCase().endsWith(".zip")
            ? resolvedName
            : `${resolvedName}.zip`)
        : resolvedName;

      // П.4: диалог «Оставить архивом?» ПЕРЕД проводником (паритет public).
      await this._askKeepPackedDialog(isBundle);

      let savePath = await save({
        title: isBundle ? t("download.save_archive_title") : t("download.save_personal_title"),
        defaultPath: defaultName,
      });
      if (!savePath) {
        this.log("Cancelled by the user", "warn");
        return;
      }
      // BUG-CANCEL-FINAL-001: отмена после выбора пути удаляет частичный файл.
      this._activeSavePath = savePath;
      this._activeOutputPath = savePath;

      // SP-33/D-175: у файла, ПРИНЯТОГО от другого мастера, нет клиентского
      // tg_file_id — вместо него PM-якорь доставки (chat_id + message_id +
      // unique_id): клиент резолвит документ в своём чате по уникальному ключу
      // (BUG-DOWNLOAD-051/052). Свои файлы работают как раньше.
      const parts: MultiPartDescriptor[] = buildVaultPartDescriptors(
        meta.parts || [],
      ) as MultiPartDescriptor[];

      if (parts.length === 0 || !parts.every(hasDownloadAnchor)) {
        throw new Error(
          "Personal file has no TDLib-compatible parts (tg_file_id / pm_delivery)",
        );
      }

      const downloadId = `vault_${pfId}_${Date.now()}`;
      // BUG-CANCEL-RESUME-002: регистрируем Rust-контекст попытки, чтобы Cancel
      // мог отменить именно её (vault-загрузка идёт тем же multi-конвейером).
      this._currentMultiId = downloadId;
      this.log(`🗄️ Downloading personal file: ${resolvedName}`, "info");
      this.progress.setMessage(t("download.msg.progress_personal"));
      this.progress.update(0, "0%");

      await this.tdlibFfiVaultSelfDownload(
        downloadId, parts, savePath, resolvedName, epoch,
      );
      await this._abortIfStale(epoch, null);

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  BUG-PERSONAL-BUNDLE-001 + Фаза 3: распаковка личного бандла         ║
      // ║  (паритет public). isBundle определён выше по type/имени; для        ║
      // ║  legacy-записей — последний рубеж: magic КОНТЕЙНЕРА (ZIP `PK 03 04`  ║
      // ║  или tar.zst `28 B5 2F FD`). Чужой контейнер не распаковываем.      ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      const headBytes = await this._peekHeader(savePath, 8);
      const container = detectDownloadContainer({
        manifestContainer: (meta as any)?.container ?? null,
        fileName: resolvedName,
        header: headBytes,
      });
      this._debugLog("download:container_check", {
        trace_id: this._traceId,
        scope: "personal",
        personal_file_id: pfId,
        header: Array.from(headBytes),
        container,
      });

      if (container === "zip" || container === "tar_zst") {
        isBundle = true;
        // Имя без расширения контейнера — дописываем (Windows-двойной клик +
        // корректный extractDir для `.tar.zst`).
        const ext = containerExtension(container);
        if (!savePath.toLowerCase().endsWith(ext)) {
          const renamed = `${savePath}${ext}`;
          try {
            await invoke("rename_file", { from: savePath, to: renamed });
            this.log(`Renamed to: ${renamed}`, "info");
            savePath = renamed;
            // BUG-CANCEL-FINAL-001: отмена должна удалять ТЕКУЩЕЕ имя файла.
            this._activeSavePath = renamed;
            this._activeOutputPath = renamed;
          } catch (renameErr: any) {
            this.log(
              `⚠️ Rename to ${ext} failed: ${renameErr?.message ?? String(renameErr ?? "unknown")}`,
              "warn"
            );
          }
        }
      } else if (headBytes.length >= 4 && (isBundle || container === "foreign")) {
        // Байты прочитаны и это не наш контейнер → только «сохранить как есть».
        isBundle = false;
        this.log(t("download.unpack_foreign_hint"), "warn");
      }

      // V3 keep-packed: для bundle чекбокс доступен и здесь (тот же элемент UI);
      // чужой контейнер (.7z/.rar) не распаковываем никогда (fail-closed) —
      // отдаём файлом, распаковка архиватором пользователя.
      this._refreshKeepPackedRow(isBundle);

      if (isBundle) {
        const action = decideDownloadAction({
          container,
          keepPacked: this._effectiveKeepPacked(),
        });
        this._debugLog("download:container_action", {
          trace_id: this._traceId,
          personal_file_id: pfId,
          container,
          action,
          keep_packed: this._effectiveKeepPacked(),
        });

        if (action === "keep_file") {
          this.log(t("download.unpack_foreign_hint"), "info");
          this.log(`Saved: ${savePath}`, "success");
        } else if (action === "keep_archive") {
          this.log(t("download.kept_packed_hint", { path: savePath }), "info");
          this.log(`Saved: ${savePath}`, "success");
        } else {
          this.log(`Extracting... (${container})`, "info");
          this.progress.startBusy(t("download.unpacking_busy"));

          // Расширение контейнера срезаем целиком (`.tar.zst` — не только
          // последний сегмент, иначе каталог получил бы имя `x.tar`).
          const ext = containerExtension(container) || ".zip";
          const extractDir = savePath.toLowerCase().endsWith(ext)
            ? savePath.slice(0, -ext.length)
            : savePath;
          let unpacked: { container?: string } | null = null;
          let unpackErr: unknown = null;
          try {
            unpacked = await invoke<{ container?: string }>("unpack_archive", {
              archivePath: savePath,
              outputDir: extractDir,
            });
          } catch (e) {
            unpackErr = e;
          }
          this.progress.stopBusy();
          if (unpackErr) throw unpackErr;

          this.log(
            `Extracted to: ${extractDir} (container=${unpacked?.container ?? container})`,
            "success",
          );

          // После распаковки удаляем сам архив (как public BUG-DESKTOP-UI-007).
          try {
            await invoke("delete_file", { path: savePath });
            this.log(`Archive removed: ${savePath}`, "info");
          } catch (delErr: any) {
            this.log(
              `⚠️ Archive removal failed (the file can be deleted manually): ${delErr?.message ?? String(delErr ?? "unknown")}`,
              "warn"
            );
          }
        }
      } else {
        this.log(`Saved: ${savePath}`, "success");
      }

      this.progress.setDone();
      this.log("✅ Personal file downloaded", "success");
      // Файл забрали на диск — копия в чате с ботом больше не нужна для
      // «своего» сценария (решение владельца 2026-11-10): предлагаем убрать
      // её одним тапом (запись в ARTEL + сообщения в PM).
      this.onPersonalDownloaded?.(pfId, resolvedName);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log(`❌ Personal download error: ${msg}`, "error");
    } finally {
      if (this._isCurrent(epoch)) {
        this.cancelBtn.style.display = "none";
        this.cancelBtn.disabled = true;
        this.startBtn.disabled = false;
        this.abortController = null;
        this._currentMultiId = null;
        // BUG-CANCEL-FINAL-001: координаты файла живут только внутри операции.
        this._activeSavePath = null;
        this._activeOutputPath = null;
      }
    }
  }

  /**
   * Owner-backdoor (T6.4): скачать ЛИЧНЫЙ файл ЦЕЛЕВОГО юзера (владелец).
   *
   * Server: POST /desktop/vault/owner/{target}/files/{pf}/download — host-copy
   * PM(юзера)→PM(владельца), возвращает delivery-координаты. Клиент резолвит
   * delivery-сообщение в СВОЁМ PM (Rust `tdlib_get_message_file` → file_id) и
   * качает штатным single-download (`tdlib_start_download`). Каждое действие
   * аудируется на сервере (actor=OWNER_ID); юзер не уведомляется.
   * SPEC docs/ARCHITECTURE_VAULT_STORAGE.md §0.9; T6.4.
   */
  async ownerDownload(targetTgId: number, pfId: number, displayName: string): Promise<void> {
    if (!requireAuth(this.log)) return;
    if (this._cancelling) {
      this.log("Cancel is still in progress — try again in a moment", "warn");
      return;
    }

    const epoch = ++this._epoch;
    this.cancelled = false;
    // П.4: owner-ветка диалог НЕ показывает (скрытый режим) — ответ прошлой
    // операции не должен протечь сюда: берём persist-чекбокс.
    this._keepPackedDialogAnswer = null;
    this.abortController = new AbortController();
    this.startBtn.disabled = true;
    this.cancelBtn.style.display = "inline-flex";
    this.cancelBtn.disabled = false;
    this.progressContainer.style.display = "block";
    this.progress.reset();
    this.logEl.innerHTML = "";
    this.fileInfo.style.display = "none";

    try {
      this.log(
        `🔐 Owner: requesting file #${pfId} of user ${targetTgId} (delivery to my PM)...`,
        "info",
      );
      const meta = await api.vaultOwnerDownload(targetTgId, pfId);
      const chatId = meta.owner_pm_chat_id;
      const messageId = meta.delivery_message_id;
      if (!chatId || !messageId) {
        throw new Error("Owner download: server did not return delivery coordinates");
      }
      const resolvedName = meta.name || displayName || `owner_${targetTgId}_${pfId}`;
      const savePath = await save({
        title: t("download.save_owner_title", { id: pfId }),
        defaultPath: resolvedName,
      });
      if (!savePath) {
        this.log("Cancelled by the user", "warn");
        return;
      }
      // BUG-CANCEL-FINAL-001: отмена после выбора пути удаляет частичный файл.
      this._activeSavePath = savePath;
      this._activeOutputPath = savePath;

      this.log(
        `🔐 Owner: resolving the delivery message chat=${chatId} msg=${messageId}` +
          (meta.delivery_unique_id ? ` unique=${meta.delivery_unique_id}` : "") +
          "...",
        "info",
      );
      this.progress.setMessage(t("download.msg.progress_owner_fetch"));

      // BUG-DOWNLOAD-052 (фаза 3): multi-личный файл (>2GB) доставлен в PM
      // владельца ПО ЧАСТЯМ → обычный multi-конвейер (склейка частей в один
      // файл). Резолв каждой части — по pm-якорю доставки и `unique_id`
      // (bot-side messageId в TDLib-сессии владельца невалиден).
      const ownerParts = meta.parts ?? [];
      if (ownerParts.length > 1) {
        const descriptors = buildOwnerPartDescriptors(ownerParts);
        const multiId = `owner_${targetTgId}_${pfId}_${epoch}`;
        this._currentMultiId = multiId;
        this.log(
          `🔐 Owner: multi-part delivery (${descriptors.length} parts) → ${savePath}`,
          "info",
        );
        this.progress.setMessage(t("download.msg.progress_owner_download"));
        await this.tdlibFfiMultiDownload(
          multiId, descriptors, savePath, resolvedName, epoch,
        );
        await this._abortIfStale(epoch, null);
        await this._ownerExtractIfBundle(savePath, resolvedName);
        this.progress.setDone();
        this.log(`✅ Owner: file saved: ${savePath}`, "success");
        return;
      }

      // BUG-DOWNLOAD-052 (фаза 3): strict-резолв по стабильному `unique_id`;
      // bot-side messageId в TDLib-сессии владельца невалиден (Bot API id ≠ MTProto id).
      const resolved = await invoke<{ file_id: number; file_name: string; size: number }>(
        "tdlib_get_message_file",
        buildOwnerResolveParams(meta),
      );
      if (!resolved || !resolved.file_id) {
        throw new Error("Owner download: failed to resolve the delivery document (getMessage)");
      }
      this.log(`🔐 Owner: document found (file_id=${resolved.file_id})`, "info");

      this.progress.setMessage(t("download.msg.progress_owner_download"));
      await this.tdlibFfiDownload(
        resolved.file_id, 1, 0, 0, savePath, chatId, messageId, 20000, epoch,
      );
      await this._abortIfStale(epoch, null);

      await this._ownerExtractIfBundle(savePath, resolvedName);
      this.progress.setDone();
      this.log(`✅ Owner: file saved: ${savePath}`, "success");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log(`❌ Owner: download error: ${msg}`, "error");
    } finally {
      if (this._isCurrent(epoch)) {
        this.cancelBtn.style.display = "none";
        this.cancelBtn.disabled = true;
        this.startBtn.disabled = false;
        this.abortController = null;
        // BUG-CANCEL-FINAL-001: координаты файла живут только внутри операции.
        this._activeSavePath = null;
        this._activeOutputPath = null;
      }
    }
  }

  /**
   * Распаковать бандл (.zip) после owner-download — паритет с downloadPersonal
   * (BUG-PERSONAL-BUNDLE-001). Определение: .zip в имени → zip-magic PK 03 04.
   */
  private async _ownerExtractIfBundle(savePath: string, resolvedName: string): Promise<void> {
    // V3 keep-packed: тот же контракт, что в public/personal — контейнер по
    // magic (байты весомее имени), чужой архив не распаковываем никогда
    // (fail-closed), а по чекбоксу либо распаковываем, либо оставляем архивом.
    const container = detectDownloadContainer({
      manifestContainer: null,
      fileName: resolvedName,
      header: await this._peekHeader(savePath),
    });
    const isBundle = container === "zip" || container === "tar_zst";
    this._refreshKeepPackedRow(isBundle);

    if (!isBundle) {
      if (container === "foreign") {
        this.log(t("download.unpack_foreign_hint"), "info");
      }
      return;
    }

    const action = decideDownloadAction({
      container,
      keepPacked: this._effectiveKeepPacked(),
    });
    this._debugLog("download:container_action", {
      trace_id: this._traceId,
      scope: "owner",
      container,
      action,
      keep_packed: this._effectiveKeepPacked(),
    });

    if (action === "keep_archive") {
      this.log(t("download.kept_packed_hint", { path: savePath }), "info");
      return;
    }

    this.log(`🔍 Bundle detected (${container}) — unpacking...`, "info");
    this.progress.startBusy(t("download.unpacking_busy"));

    // Расширение по контейнеру (zip | tar.zst): раньше всегда дописывался
    // `.zip`, из-за чего tar.zst-архив получал имя `x.tar.zst.zip`.
    const ext = containerExtension(container);
    let archivePath = savePath;
    if (ext && !archivePath.toLowerCase().endsWith(ext)) {
      const renamed = `${archivePath}${ext}`;
      try {
        await invoke("rename_file", { from: archivePath, to: renamed });
        archivePath = renamed;
      } catch (e) {
        this.log(`⚠️ rename to ${ext} failed: ${String(e)}`, "warn");
      }
    }
    const extractDir = archivePath.toLowerCase().endsWith(ext)
      ? archivePath.slice(0, -ext.length)
      : archivePath;
    // unpack_archive сам определяет контейнер (zip | tar.zst).
    let unpacked: { container?: string } | null = null;
    let unpackErr: unknown = null;
    try {
      unpacked = await invoke<{ container?: string }>("unpack_archive", {
        archivePath,
        outputDir: extractDir,
      });
    } catch (e) {
      unpackErr = e;
    }
    this.progress.stopBusy();
    if (unpackErr) throw unpackErr;
    this.log(
      `Extracted to: ${extractDir} (container=${unpacked?.container ?? container})`,
      "success",
    );
    try {
      await invoke("delete_file", { path: archivePath });
    } catch (e) {
      this.log(`⚠️ archive removal failed: ${String(e)}`, "warn");
    }
  }

  /**
   * Sequential self-download через TDLib (vault self-download) из своего PM.
   * Слушает тот же event `tdlib-multi-download-progress`, что и public multi.
   */
  private tdlibFfiVaultSelfDownload(
    downloadId: string,
    parts: MultiPartDescriptor[],
    outputPath: string,
    fileName: string,
    /** Поколение операции: события отменённой попытки игнорируются. */
    epoch: number = this._epoch,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let unlisten: UnlistenFn[] = [];

      const stop = (): void => {
        for (const f of unlisten) f();
        // BUG-DOWNLOAD-049: self-download завершён — watchdog не нужен.
        this._stopStallWatchdog();
      };

      const onProgress = (p: TdlibFfiMultiDownloadProgress) => {
        if (p.download_id !== downloadId) return;
        // Отменённая попытка: не пишем в UI и не висим до таймаута.
        if (!this._isCurrent(epoch)) {
          stop();
          reject(new Error("Download cancelled by user"));
          return;
        }
        this.progress.report(Number(p.downloaded_bytes), Number(p.total_bytes), {
          partLabel: t("download.msg.part_label", {
            cur: p.current_part_index + 1,
            total: p.total_parts,
          }),
        });
        // BUG-DOWNLOAD-049: байты self-download — обрыва нет.
        this._stallWd?.progress();
        // BUG-CANCEL-RESUME-002: «cancelled by user» — это отмена, не ошибка.
        const isCancel = p.error ? /cancelled by user/i.test(p.error) : false;
        if (p.error) {
          this.log(
            isCancel
              ? `TDLib self-download cancelled: ${p.error}`
              : `TDLib self-download error: ${p.error}`,
            isCancel ? "warn" : "error",
          );
        }
        if (p.completed || p.error) {
          stop();
          if (p.error) reject(new Error(isCancel ? "Download cancelled by user" : p.error));
          else resolve(outputPath);
        }
      };

      // BUG-DOWNLOAD-049: страховка от «вечного ⏳ Соединение…» (vault self).
      this._startStallWatchdog();
      listen<TdlibFfiMultiDownloadProgress>("tdlib-multi-download-progress", (e) => onProgress(e.payload))
      .then((fn) => {
        unlisten = [fn];
        invoke<string>("tdlib_start_vault_self_download", {
          downloadId,
          parts,
          outputPath,
          fileName,
        }).catch((e: any) => {
          for (const f of unlisten) f();
          this._stopStallWatchdog();
          reject(e);
        });
      }).catch((e: any) => {
        this._stopStallWatchdog();
        reject(e);
      });
    });
  }

  /**
   * Set file_id and start download.
   * Called from SearchPage on result click.
   */
  setFileId(fileId: number): void {
    this.fileIdInput.value = String(fileId);
    this.startDownload();
  }

  /**
   * Активна ли сейчас передача (Phase 3, гибридный старт из поиска):
   * чип «Идёт передача — открыть» на вкладке поиска.
   */
  isTransferActive(): boolean {
    return this._transferActive && !this.cancelled && !this._cancelling;
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + units[i];
  }
}
