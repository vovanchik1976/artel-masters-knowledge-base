/**
 * UploadPage — выбор файла/папки, сканирование, архивация,
 * split, upload частей на сервер.
 *
 * v4: server-driven upload form schema, retry + speedometer + beforeunload.
 * v5: HF Hub Storage стратегия удалена.
 * v8: Shared TDLib Runtime — upload через UploadManager (user session).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { store } from "../store";
import { ProgressUI } from "./Progress";
import type { UploadFormSchemaResponse, UploadFormField } from "../api";
import { t, tLoose, hasKey } from "../i18n";
import { isPersonalScope, subscribeVault } from "../vaultMode";
// SP-35 (D-185): права классов контента по режиму (public/personal).
import { kindNeedsBrandModel, kindRequiresTitle, kindSupportsFolder, pickKindForScope, visibleKindOptions } from "./uploadKinds";
import {
  buildJanitorRequest,
  shouldPurgeTdlibCacheOnCancel,
  type JanitorTrigger,
} from "./JanitorPolicy";
import {
  CardMediaPanel,
  uploadedCardRef,
  type MediaProgressEvent,
} from "./CardMediaPanel";
import type { LocalMediaFile } from "./CardMediaQueue";
import { CardMediaUploader, type MediaUploadHooks } from "./CardMediaUploader";
import type { ResolvedMedia } from "./MediaGallery";
import { mediaBytesForUi } from "./MediaFetchWiring";
import {
  decideSingleSource,
  readSkipPackingPref,
  writeSkipPackingPref,
  type SingleSource,
  type UploadContainer,
} from "../search/SingleUploadPolicy";

// ─── MTProto progress event types ─────────────────────────────────────────

interface UploadPartProgress {
  position: number;
  total: number;
  percent: number;
  part_index?: number;
  part_count?: number;
}


// ── Shared TDLib Runtime ─────────────────────────────────────────

/** Прогресс upload через shared TDLib runtime (tdlib-upload-progress event). */
interface SharedRuntimeUploadProgress {
  upload_id: string;
  file_id: number;
  bytes_uploaded: number;
  total: number;
  percent: number;
  speed_bytes_per_sec: number;
  eta_secs: number;
  completed: boolean;
  error: string | null;
}

/** Прогресс multi-part upload через shared TDLib runtime (tdlib-multi-upload-progress event). */
interface SharedRuntimeMultiUploadProgress {
  upload_id: string;
  current_part: number;
  total_parts: number;
  total_size: number;
  total_uploaded: number;
  /** Байт загружено в текущей части (для плавного прогресса без прыжков). */
  current_part_bytes_read: number;
  /** Всего байт в текущей части. */
  current_part_total_bytes: number;
  percent: number;
  speed_bytes_per_sec: number;
  eta_secs: number;
  completed: boolean;
  error: string | null;
}

/** Событие «часть multi-part отправлена» (Rust) — message_id для self-delete на cancel. */
interface MultiUploadPartDoneEvent {
  upload_id: string;
  part_index: number;
  part_offset: number;
  part_size: number;
  message_id: number;
}

/** Результат sendDocument через TDLib JSON FFI (≤2GB). */
interface TdlibJsonUploadResult {
  tg_file_id: string;
  tg_file_unique_id: string;
  message_id: number;
}

/** Одна часть multi-part upload. */
interface MultiPartEntry {
  part_index: number;
  file_offset: number;
  part_size: number;
  tg_file_id: string;
  tg_file_unique_id: string;
  telegram_message_id: number;
}

/** Результат multi-part upload через TDLib JSON FFI (>2GB). */
interface TdlibUploadMultiResult {
  parts: MultiPartEntry[];
  total_parts: number;
  total_size: number;
}

// ─── Fallback schema (когда сервер недоступен) ──────────────────────────
// Зеркало bot/services/upload_requirements_service.py:_get_upload_fields()

const FALLBACK_FORM_FIELDS: UploadFormField[] = [
  // ─── Дискримінатор контенту ────────────────────────────
  {
    name: "content_kind", labelKey: "upload.field.content_kind.label", placeholderKey: "upload.field.content_kind.placeholder",
    required: true, type: "select", max_length: 16, order: 0, section: "kind",
    options: [
      { value: "firmware", labelKey: "upload.field.content_kind.options.firmware", scopes: ["public", "personal"] },
      { value: "documentation", labelKey: "upload.field.content_kind.options.documentation", scopes: ["public", "personal"] },
      { value: "software", labelKey: "upload.field.content_kind.options.software", scopes: ["public", "personal"] },
      // SP-35 (D-185): даташит микросхемы — профильный контент (оба режима).
      { value: "datasheet", labelKey: "upload.field.content_kind.options.datasheet", scopes: ["public", "personal"] },
      // SP-36 (D-188): ISP-подключение eMMC и фото ремонта — публичные классы.
      { value: "isp_emmc", labelKey: "upload.field.content_kind.options.isp_emmc", scopes: ["public", "personal"] },
      { value: "repair_pictures", labelKey: "upload.field.content_kind.options.repair_pictures", scopes: ["public", "personal"] },
      // SP-35 (D-185): произвольный файл — ТОЛЬКО личное хранилище.
      { value: "any_file", labelKey: "upload.field.content_kind.options.any_file", scopes: ["personal"] },
    ],
  },
  // ─── Ідентифікація пристрою ────────────────────────────
  {
    name: "category", labelKey: "upload.field.category.label", placeholderKey: "upload.field.category.placeholder",
    required: true, type: "select", max_length: 64, order: 1, section: "device",
    options: [
      { value: "tv", labelKey: "upload.field.category.options.tv" },
      { value: "monitor", labelKey: "upload.field.category.options.monitor" },
      { value: "stb", labelKey: "upload.field.category.options.stb" },
      { value: "android_tv", labelKey: "upload.field.category.options.android_tv" },
      { value: "media_server", labelKey: "upload.field.category.options.media_server" },
      { value: "audio", labelKey: "upload.field.category.options.audio" },
      { value: "dvd_bluray", labelKey: "upload.field.category.options.dvd_bluray" },
      { value: "radio", labelKey: "upload.field.category.options.radio" },
      { value: "console", labelKey: "upload.field.category.options.console" },
      { value: "power_station", labelKey: "upload.field.category.options.power_station" },
      { value: "appliance", labelKey: "upload.field.category.options.appliance" },
      { value: "other", labelKey: "upload.field.category.options.other" },
    ],
  },
  {
    name: "brand", labelKey: "upload.field.brand.label", placeholderKey: "upload.field.brand.placeholder",
    required: true, type: "text", max_length: 128, order: 2, section: "device",
  },
  // SP-31 (D-165): тип железа — «рядом с брендом», подделки НЕ отдельный бренд.
  {
    name: "hardware_type", labelKey: "upload.field.hardware_type.label", placeholderKey: "upload.field.hardware_type.placeholder",
    required: true, type: "select", max_length: 16, order: 3, section: "device",
    options: [
      { value: "original", labelKey: "upload.field.hardware_type.options.original" },
      { value: "china_clone", labelKey: "upload.field.hardware_type.options.china_clone" },
    ],
  },
  {
    name: "model", labelKey: "upload.field.model.label", placeholderKey: "upload.field.model.placeholder",
    required: true, type: "text", max_length: 128, order: 4, section: "device",
  },
  // ─── Апаратна платформа ────────────────────────────────
  {
    name: "chassis", labelKey: "upload.field.chassis.label", placeholderKey: "upload.field.chassis.placeholder",
    required: false, type: "text", max_length: 128, order: 5, section: "hardware",
  },
  {
    name: "chipset", labelKey: "upload.field.chipset.label", placeholderKey: "upload.field.chipset.placeholder",
    required: false, type: "text", max_length: 128, order: 6, section: "hardware",
  },
  // ─── Носій та пам'ять ──────────────────────────────────
  {
    name: "memory_type", labelKey: "upload.field.memory_type.label", placeholderKey: "upload.field.memory_type.placeholder",
    required: true, type: "multiselect", max_length: 512, order: 7, section: "storage",
    options: [
      { value: "eeprom", labelKey: "upload.field.memory_type.options.eeprom" },
      { value: "spi_flash", labelKey: "upload.field.memory_type.options.spi_flash" },
      { value: "nand", labelKey: "upload.field.memory_type.options.nand" },
      { value: "nor_flash", labelKey: "upload.field.memory_type.options.nor_flash" },
      { value: "spi_nand", labelKey: "upload.field.memory_type.options.spi_nand" },
      { value: "emmc", labelKey: "upload.field.memory_type.options.emmc" },
      { value: "other", labelKey: "upload.field.memory_type.options.other" },
    ],
  },
  {
    name: "programmer", labelKey: "upload.field.programmer.label", placeholderKey: "upload.field.programmer.placeholder",
    required: false, type: "text", max_length: 128, order: 8, section: "storage",
  },
  // ─── Метадані прошивки ─────────────────────────────────
  {
    name: "firmware_type", labelKey: "upload.field.firmware_type.label", placeholderKey: "upload.field.firmware_type.placeholder",
    required: true, type: "select", max_length: 32, order: 9, section: "metadata",
    options: [
      { value: "dump", labelKey: "upload.field.firmware_type.options.dump" },
      { value: "dump_set", labelKey: "upload.field.firmware_type.options.dump_set" },
      { value: "usb_update", labelKey: "upload.field.firmware_type.options.usb_update" },
      { value: "official", labelKey: "upload.field.firmware_type.options.official" },
      { value: "custom", labelKey: "upload.field.firmware_type.options.custom" },
    ],
  },
  {
    name: "version", labelKey: "upload.field.version.label", placeholderKey: "upload.field.version.placeholder",
    required: false, type: "text", max_length: 128, order: 10, section: "metadata",
  },
  {
    name: "source_status", labelKey: "upload.field.source_status.label", placeholderKey: "upload.field.source_status.placeholder",
    required: true, type: "select", max_length: 16, order: 11, section: "metadata",
    options: [
      { value: "verified", labelKey: "upload.field.source_status.options.verified" },
      { value: "unverified", labelKey: "upload.field.source_status.options.unverified" },
      { value: "original", labelKey: "upload.field.source_status.options.original" },
    ],
  },
  // ─── Додатково ─────────────────────────────────────────
  {
    name: "panel_model", labelKey: "upload.field.panel_model.label", placeholderKey: "upload.field.panel_model.placeholder",
    required: false, type: "text", max_length: 128, order: 12, section: "extra",
  },
  {
    name: "description", labelKey: "upload.field.description.label", placeholderKey: "upload.field.description.placeholder",
    required: false, type: "textarea", max_length: 2000, order: 13, section: "extra",
  },
];


export class UploadPage {
  private progress: ProgressUI;
  private getTgId: () => number;
  private onUploadComplete: (brand: string, model: string) => void;

  // DOM refs
  private selectFileBtn!: HTMLButtonElement;
  private selectFolderBtn!: HTMLButtonElement;
  private startUploadBtn!: HTMLButtonElement;
  private cancelUploadBtn!: HTMLButtonElement;
  private fileInfo!: HTMLElement;
  private uploadPath!: HTMLElement;
  private uploadSize!: HTMLElement;
  private uploadType!: HTMLElement;
  private fieldContainer!: HTMLElement;
  private fieldElements: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = new Map();
  private progressContainer!: HTMLElement;
  private logEl!: HTMLElement;
  /** Хост панели медиа карточки на вкладке «Загрузка» (SP-15 v3, D-069). */
  private mediaPanelHost: HTMLElement | null = null;
  /** Панель медиа последней загруженной карточки (создаётся лениво). */
  private mediaPanel: CardMediaPanel | null = null;
  /** Фетчер медиа-байтов (SP-15 срез 5): своя TDLib по якорю → прокси. */
  private mediaThumbBytes: ((url: string, item?: ResolvedMedia) => Promise<string>) | null = null;

  /** Ленивый фетчер: создаётся один раз на страницу (кеш байтов внутри). */
  private _mediaThumbBytes(url: string, item?: ResolvedMedia): Promise<string> {
    this.mediaThumbBytes ??= mediaBytesForUi((u) => api.mediaObjectUrl(u), "thumb");
    return this.mediaThumbBytes(url, item);
  }

  // Strategy switcher DOM (TDLib JSON FFI)
  private strategyTdlibJsonRadio!: HTMLInputElement;
  private tdlibJsonStatusBlock!: HTMLElement;
  private tdlibJsonDot!: HTMLElement;
  private tdlibJsonStatusText!: HTMLElement;
  private tdlibJsonStatus!: HTMLElement;
  private tdlibJsonUnavailableWarning!: HTMLElement;
  /** TDLib shared runtime доступен? */
  private _tdlibRuntimeReady: boolean = false;

  // ── Диагностика паузы «кнопка Старт → реальная передача байт» ──
  /** performance.now() в момент нажатия «Старт» (якорь для _phase). */
  private _uploadPhaseT0: number = 0;
  /** Залогирован ли момент первой реальной передачи байт (>0). */
  private _firstBytesLogged: boolean = false;

  // Server-driven upload schema
  private uploadSchema: UploadFormSchemaResponse | null = null;
  private schemaFieldMap: Map<string, UploadFormField> = new Map();
  /** Активный content_kind (firmware/documentation/software). */
  private activeKind: string = "firmware";

  private selectedPath: string | null = null;
  private selectedSize: number = 0;
  private isDirectory: boolean = false;

  // Telegram API credentials (compile-time env + server fallback)
  private tgApiId: number = 0;
  private tgApiHash: string = "";

  // Cancel support
  private abortController: AbortController | null = null;
  private cancelled: boolean = false;
  /**
   * Поколение операции (BUG-CANCEL-RESUME-001).
   *
   * Инкрементируется при каждом старте/отмене. Проверки после await
   * не дают устаревшей (отменённой) цепочке дойти до /complete и начислить
   * баллы по операции, которую пользователь уже отменил.
   */
  private _epoch: number = 0;
  /** true, пока идёт teardown отменённой операции — блокирует новый старт. */
  private _cancelling: boolean = false;
  /**
   * Поколение АКТИВНОЙ (владеющей UI) операции.
   *
   * Нужно, чтобы `finally` устаревшей цепочки не обнулял состояние и кнопки
   * новой загрузки, а cancel — мог забрать владение себе.
   */
  private _activeEpoch: number | null = null;
  /** Rust TDLib upload_id (передача). Отличается от serverUploadId! */
  private currentUploadId: string | null = null;
  /** Серверный upload_id (DesktopUploadJob) — для cancel/status API. */
  private serverUploadId: string | null = null;
  /** Свой PM-чат (id бота) и отправленные message_id — self-delete при cancel. */
  private pmChatIdSelf: number | null = null;
  private pmMessageIds: number[] = [];

  /** true после успешного transfer (до /complete) — ошибка /complete НЕ resumable. */
  private _afterTransfer: boolean = false;

  // Temp-архив текущей сессии (firmware-desktop/*.zip) — для cleanup после
  // upload/отмены (BUG-DESKTOP-UI-003). null пока архив не создан.
  private currentArchivePath: string | null = null;
  // Cache cleanup UI elements
  private clearCacheBtn!: HTMLButtonElement;
  private clearCacheResult!: HTMLElement;
  /** 🧹 Кнопка очистки ВСЕХ полей карточки (B, 2026-09-23). */
  private clearFieldsBtn!: HTMLButtonElement;
  /**
   * Фаза 3: radio «Контейнер архива» (tar.zst по умолчанию / ZIP).
   * Показывается только когда упаковка действительно возможна (папка или
   * сырой single с включённым сжатием) — иначе это «выбор ни на что».
   */
  private containerRow!: HTMLElement;
  private containerLabel!: HTMLElement;
  private containerTarZstRadio!: HTMLInputElement;
  private containerZipRadio!: HTMLInputElement;
  /**
   * D-182 (BUG-CABINET-VAULT-SHA-MISMATCH-001): «не пакувати» — ТОЛЬКО личное
   * хранилище. Пакуем по умолчанию; выбор запоминается между запусками
   * (`fw_upload_skip_packing`, паритет с контейнером).
   */
  private skipPackingRow!: HTMLElement;
  private skipPackingCheckbox!: HTMLInputElement;
  private skipPackingLabel!: HTMLElement;

  // Timing для ETA + speedometer
  private uploadStartTime: number = 0;

  // beforeunload guard
  private uploadActive: boolean = false;
  private _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

  constructor(
    getTgId: () => number,
    onUploadComplete?: (brand: string, model: string) => void,
    /**
     * BUG-CANCEL-FINAL-001: идёт ли параллельная передача в ДРУГОЙ вкладке
     * (Download). Кеш TDLib общий, поэтому пург при отмене upload
     * пропускается, пока идёт скачивание (иначе снесём его кеш частей).
     */
    private otherTransferActive?: () => boolean,
  ) {
    this.onUploadComplete = onUploadComplete || (() => { });
    this.progress = new ProgressUI(
      "uploadProgress", "uploadProgressFill",
      "uploadProgressText", "uploadProgressEta",
    );
    this.getTgId = getTgId;

    // Регистрируем beforeunload handler (всегда). Флаг uploadActive решает,
    // показывать ли диалог.
    this._beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      if (this.uploadActive) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", this._beforeUnloadHandler);

    // Дворник temp-мусора: при старте сносим остатки прошлых крешей
    // (BUG-DESKTOP-UI-003, fire-and-forget — не блокирует UI). Порог 0 здесь
    // безопасен: движок ещё не запускался, а второй экземпляр запрещён замком
    // (`requestSingleInstanceLock`, BUG-SINGLE-INSTANCE-001) — свежих «чужих»
    // temp-файлов рядом быть не может (JanitorPolicy).
    void this.cleanupStaleArchives("startup");
  }

  bindEvents(): void {
    this.selectFileBtn = document.getElementById("selectFileBtn") as HTMLButtonElement;
    this.selectFolderBtn = document.getElementById("selectFolderBtn") as HTMLButtonElement;
    this.startUploadBtn = document.getElementById("startUploadBtn") as HTMLButtonElement;
    this.cancelUploadBtn = document.getElementById("cancelUploadBtn") as HTMLButtonElement;
    this.fileInfo = document.getElementById("uploadFileInfo")!;
    this.uploadPath = document.getElementById("uploadPath")!;
    this.uploadSize = document.getElementById("uploadSize")!;
    this.uploadType = document.getElementById("uploadType")!;
    this.fieldContainer = document.getElementById("uploadFieldContainer")!;
    this.progressContainer = document.getElementById("uploadProgress")!;
    this.logEl = document.getElementById("uploadLog")!;
    // Панель медиа карточки (SP-15 срез 3b, D-069 v4): «инструмент в описании файла»
    // ВИДЕН СРАЗУ — владелец выбирает фото ДО старта загрузки (видит превью и лимит),
    // а прикрепление к теме идёт автоматически, когда карточка родится на `/complete`
    // (до этого момента её id не существует — см. _showCardMedia).
    this.mediaPanelHost = document.getElementById("uploadMediaPanel");
    if (this.mediaPanelHost) {
      this.mediaPanel = new CardMediaPanel(this.mediaPanelHost, this._mediaPanelDeps());
      this.mediaPanel.bind();
    }

    // Strategy switcher DOM (TDLib JSON FFI)
    this.strategyTdlibJsonRadio = document.getElementById("strategyTdlibJson") as HTMLInputElement;
    this.tdlibJsonStatusBlock = document.getElementById("tdlibJsonStatusBlock")!;
    this.tdlibJsonDot = document.getElementById("tdlibJsonDot")!;
    this.tdlibJsonStatusText = document.getElementById("tdlibJsonStatusText")!;
    this.tdlibJsonStatus = document.getElementById("tdlibJsonStatus")!;
    this.tdlibJsonUnavailableWarning = document.getElementById("tdlibJsonUnavailableWarning")!;

    // 🧹 Очистка кеша TDLib
    this.clearCacheBtn = document.getElementById("clearTdlibCacheBtn") as HTMLButtonElement;
    this.clearCacheResult = document.getElementById("clearCacheResult")!;
    this.clearCacheBtn.addEventListener("click", () => this.clearTdlibCache());

    // 🧹 Очистка всех полей карточки (B): значения стираются in-place,
    // выбранный файл/папка НЕ сбрасывается (чистим только карточку).
    this.clearFieldsBtn = document.getElementById("clearUploadFieldsBtn") as HTMLButtonElement;
    if (this.clearFieldsBtn) {
      this.clearFieldsBtn.addEventListener("click", () => this._clearFormFields());
    }

    // Фаза 3: контейнер архива (tar.zst по умолчанию — скорость/размер;
    // ZIP — «открывается везде»). Выбор переживает перезапуск клиента.
    // Важно: значение НИКОГДА не читаем из DOM в момент сборки манифеста
    // «по памяти» — только через _uploadContainer() (единый источник).
    this.containerRow = document.getElementById("uploadContainerRow")!;
    this.containerLabel = document.getElementById("uploadContainerLabel")!;
    this.containerTarZstRadio = document.getElementById("uploadContainerTarZst") as HTMLInputElement;
    this.containerZipRadio = document.getElementById("uploadContainerZip") as HTMLInputElement;
    try {
      if (localStorage.getItem("fw_upload_container") === "zip") {
        this.containerZipRadio.checked = true;
        this.containerTarZstRadio.checked = false;
      }
    } catch { /* ignore */ }
    for (const radio of [this.containerTarZstRadio, this.containerZipRadio]) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        try {
          localStorage.setItem("fw_upload_container", radio.value === "zip" ? "zip" : "tar_zst");
        } catch { /* ignore */ }
        // Видимость строки от контейнера не зависит (решение = сырьё/готовое).
      });
    }

    // D-182 (BUG-CABINET-VAULT-SHA-MISMATCH-001): «не пакувати» — только личное
    // хранилище, пакуем ПО УМОЛЧАНИЮ. Выбор переживает перезапуск клиента
    // (как `fw_upload_container`); мусор/сломанное хранилище → пакуем.
    this.skipPackingRow = document.getElementById("uploadSkipPackingRow")!;
    this.skipPackingLabel = document.getElementById("uploadSkipPackingLabel")!;
    this.skipPackingCheckbox = document.getElementById("uploadSkipPacking") as HTMLInputElement;
    this.skipPackingCheckbox.checked = readSkipPackingPref((k) => localStorage.getItem(k));
    this.skipPackingCheckbox.addEventListener("change", () => {
      writeSkipPackingPref(
        (k, v) => localStorage.setItem(k, v),
        this.skipPackingCheckbox.checked,
      );
      // Скрытие/показ строки контейнера зависит от флага — пересчитываем сразу.
      void this._refreshPackingUI().catch(() => {});
    });
    // Смена режима (публичное поле ↔ личный кабинет) меняет доступность галочки:
    // в публичном каталоге сырьё пакуется всегда.
    subscribeVault(() => {
      // SP-35 (D-185): в личном режиме появляется «Довільний файл», в публичном —
      // исчезает. Обновляем только селектор, поля не трогаем.
      this._refreshKindOptions();
      void this._refreshPackingUI().catch(() => {});
    });

    this.selectFileBtn.addEventListener("click", () => this.pickFile());
    this.selectFolderBtn.addEventListener("click", () => this.pickFolder());
    // Drag & Drop: файл → на кнопку «Вибрати файл», папка → на «Вибрати папку».
    this._bindDropTarget(this.selectFileBtn, false);
    this._bindDropTarget(this.selectFolderBtn, true);
    // Drop мимо кнопок не должен навигировать окно на файл (Electron default).
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());
    this.startUploadBtn.addEventListener("click", () => this.startUpload());
    this.cancelUploadBtn.addEventListener("click", () => this.cancelUpload());

    // ── Strategy switch: TDLib shared runtime ──
    this.strategyTdlibJsonRadio.addEventListener("change", () => this._checkTdlibRuntimeStatus());

    // ════════════════════════════════════════════════════════════════════
    // BUG-AUTH-014: Инициализируем статус TDLib runtime сразу после
    // bindEvents. Без этого _tdlibRuntimeReady остаётся false после
    // успешной авторизации, и startUpload() выбрасывает ошибку
    // "TDLib shared runtime недоступний".
    // ════════════════════════════════════════════════════════════════════
    this._checkTdlibRuntimeStatus().catch((e: any) => {
      console.warn("[UploadPage] Initial tdlib runtime check failed:", e?.message ?? e);
    });

    // Загружаем upload form schema c сервера (с кеш-фолбэком)
    this.loadUploadSchema();
  }

  /** Загрузить upload form schema с сервера (с кеш-фолбэком) для активного kind. */
  private async loadUploadSchema(): Promise<void> {
    try {
      const schema = await api.getUploadFormSchema(this.activeKind);
      if (schema.ok && schema.fields) {
        this.uploadSchema = schema;
        this.activeKind = schema.content_kind || this.activeKind;
        // Кешируем
        store.saveUploadSchema(schema);
        this.buildFieldMap(schema);
        this.applySchemaToUI(schema);
        this.log(`📋 Schema loaded (${this.activeKind}, v${schema.schema_version})`, "info");
      }
    } catch {
      // Пробуем кеш
      const cached = store.getCachedUploadSchema();
      if (cached && cached.fields) {
        this.uploadSchema = cached;
        this.buildFieldMap(cached);
        this.applySchemaToUI(cached);
        this.log("⚠️ Using cached form schema (server unavailable)", "warn");
      } else {
        // ═══ FALLBACK: статические поля (зеркало серверной схемы) ═══
        this.log("ℹ️ Using default fields (schema not loaded)", "info");
        this._renderFallbackFields();
      }
    }
  }

  /** Опции дискриминатора из текущей схемы (для проверки прав режима). */
  private _kindOptions(): Array<{ value: string; scopes?: string[] }> {
    const field = this.uploadSchema?.fields?.find((f) => f.name === "content_kind");
    return field?.options ?? [];
  }

  /**
   * Переключить content_kind: перезагрузить схему под выбранный kind и перерисовать.
   *
   * SP-35 (D-185): kind, запрещённый в текущем режиме (например `any_file` в
   * публичном поле), не переключаем — форма осталась бы такой, которую сервер
   * отвергает кодом 400 `KIND_NOT_ALLOWED_IN_SCOPE`.
   */
  private async switchKind(kind: string): Promise<void> {
    if (!kind || kind === this.activeKind) return;
    if (pickKindForScope(kind, this._kindOptions(), isPersonalScope()) !== kind) {
      this.log(`Kind "${kind}" is not allowed in this scope — ignored`, "warn");
      this._refreshKindOptions();
      return;
    }
    this.activeKind = kind;
    await this.loadUploadSchema();
  }

  /**
   * Обновить ТОЛЬКО список опций «Що ви завантажуєте?» под текущий режим.
   *
   * Полная перерисовка формы здесь запрещена: смена режима не должна стирать
   * уже заполненные поля мастера (файл выбран, поля введены).
   */
  private _refreshKindOptions(): void {
    const sel = this.fieldElements.get("content_kind");
    if (!(sel instanceof HTMLSelectElement)) return;
    const field = this.uploadSchema?.fields?.find((f) => f.name === "content_kind");
    if (!field?.options) return;

    const options = visibleKindOptions(field.options, isPersonalScope());
    const keep = pickKindForScope(
      sel.value || this.activeKind, field.options, isPersonalScope(),
    );
    const placeholderValue = "";
    sel.innerHTML = "";
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = placeholderValue;
    placeholderOpt.textContent = this._resolvePlaceholder(field) || t("common.select_placeholder");
    sel.appendChild(placeholderOpt);
    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.dataset.ufOpt = field.name;
      option.dataset.ufOptValue = opt.value;
      option.textContent = this._resolveOptionLabel(field, opt);
      sel.appendChild(option);
    }
    sel.value = keep;
    // Kind сменился принудительно → схема полей должна соответствовать ему.
    if (keep !== this.activeKind) void this.switchKind(keep);
  }

  /**
   * Рендерит hardcoded fallback-поля, когда сервер недоступен и кеш пуст.
   * Полностью дублирует структуру из FALLBACK_FORM_FIELDS,
   * чтобы UI был идентичен серверной схеме.
   */
  private _renderFallbackFields(): void {
    const fallbackSchema: UploadFormSchemaResponse = {
      ok: true,
      schema_version: 5,
      fields: FALLBACK_FORM_FIELDS,
      limits: {
        bot_miniapp_max_upload_bytes: 0,
        max_file_size_bytes: 0,
        max_fields_length: {},
        max_files_per_upload: 1,
      },
      warnings: [],
    };
    this.uploadSchema = fallbackSchema;
    this.buildFieldMap(fallbackSchema);
    this.applySchemaToUI(fallbackSchema);
  }

  /** Построить Map<field_name, field_config> для быстрого доступа */
  private buildFieldMap(schema: UploadFormSchemaResponse): void {
    this.schemaFieldMap.clear();
    for (const field of schema.fields) {
      this.schemaFieldMap.set(field.name, field);
    }
  }

  /** Применить схему к UI: динамически создать DOM-элементы для ВСЕХ полей */
  private applySchemaToUI(schema: UploadFormSchemaResponse): void {
    // Очищаем контейнер и мапу
    this.fieldContainer.innerHTML = "";
    this.fieldElements.clear();

    // Сортируем поля по order
    const sorted = [...schema.fields].sort((a, b) => a.order - b.order);

    const inputStyle = "flex:1; padding:12px 16px; border-radius:12px; border:1px solid var(--glass-border); background:rgba(0,0,0,0.2); color:var(--text); font-size:14px; transition: border-color 0.2s, box-shadow 0.2s; outline:none;";
    const textareaStyle = "width:100%; padding:12px 16px; border-radius:12px; border:1px solid var(--glass-border); background:rgba(0,0,0,0.2); color:var(--text); font-size:14px; resize:vertical; min-height:80px; transition: border-color 0.2s, box-shadow 0.2s; outline:none;";
    // WebKitGTK (Tauri Linux): нативный <select> игнорирует CSS-фон и рисует
    // системный белый popup с унаследованным светлым color → текст не виден.
    // appearance:none форсирует CSS-рендеринг (тёмный фон + светлый текст);
    // кастомная SVG-стрелка заменяет нативную.
    const selectStyle = "flex:1; padding:12px 36px 12px 16px; border-radius:12px; border:1px solid var(--glass-border); background:rgba(0,0,0,0.2); color:var(--text); font-size:14px; cursor:pointer; -webkit-appearance:none; appearance:none; background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='8' viewBox='0 0 14 8'%3E%3Cpath d='M1 1l6 6 6-6' fill='none' stroke='%235dade2' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\"); background-repeat:no-repeat; background-position:right 16px center; background-size:14px 8px; transition: border-color 0.2s; outline:none;";
    const checkboxRowStyle = "display:flex; flex-wrap:wrap; gap:12px; flex:1;";

    let currentSection = "";
    let sectionWrapper: HTMLElement | null = null;

    for (const field of sorted) {
      // Секция
      if (field.section && field.section !== currentSection) {
        currentSection = field.section;
        sectionWrapper = document.createElement("div");
        sectionWrapper.style.cssText = "margin-bottom:16px;";
        const sectionTitle = document.createElement("div");
        sectionTitle.style.cssText = "font-size:12px; color:var(--text-dim); margin-bottom:12px; margin-top:20px; text-transform:uppercase; letter-spacing:1px; display:flex; align-items:center; gap:8px;";
        // data-атрибут нужен для in-place relabel при смене языка (_relabelSchema)
        sectionTitle.dataset.ufSection = field.section;
        
        // Add a subtle line next to the section title
        const line = document.createElement("div");
        line.style.cssText = "flex:1; height:1px; background:linear-gradient(90deg, var(--glass-border), transparent);";
        
        sectionTitle.appendChild(document.createTextNode(this._getSectionLabel(field.section)));
        sectionTitle.appendChild(line);
        
        sectionWrapper.appendChild(sectionTitle);
        this.fieldContainer.appendChild(sectionWrapper);
      }

      // Рядок поля
      const fieldRow = document.createElement("div");
      fieldRow.style.cssText = "display:flex; gap:16px; margin-bottom:12px; align-items:center;";

      // Label
      const label = document.createElement("label");
      label.style.cssText = "font-size:13px; color:var(--text-dim); min-width:160px; font-weight: 500;";
      label.dataset.ufLabel = field.name;
      label.textContent = this._resolveLabel(field);
      if (field.required) {
        const star = document.createElement("span");
        star.style.color = "var(--error)";
        star.style.marginLeft = "4px";
        star.textContent = "*";
        label.appendChild(star);
      }
      fieldRow.appendChild(label);

      // Input / Select / Textarea / Multiselect
      let inputEl: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

      if (field.type === "multiselect" && field.options) {
        // Multiselect: чекбоксы + скрытое текстовое поле для значения
        const container = document.createElement("div");
        container.style.cssText = checkboxRowStyle;

        const hiddenInput = document.createElement("input");
        hiddenInput.type = "hidden";
        hiddenInput.id = `uf_${field.name}`;
        hiddenInput.name = field.name;
        hiddenInput.value = "";

        const otherContainer = document.createElement("div");
        otherContainer.style.cssText = "display:none; width:100%; margin-top:4px;";

        const otherText = document.createElement("input");
        otherText.type = "text";
        otherText.style.cssText = inputStyle;
        otherText.dataset.ufOther = field.name;
        otherText.placeholder = this._resolveOtherPlaceholder(field);

        const updateMultiselectValue = (): void => {
          const checked: string[] = [];
          const cbs = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
          for (const cb of cbs) {
            if (cb.checked) {
              if (cb.value === "other") {
                const val = otherText.value.trim();
                if (val) checked.push(`other:${val}`);
              } else {
                checked.push(cb.value);
              }
            }
          }
          hiddenInput.value = checked.join(", ");
          // Показываем/скрываем other text input
          const otherCb = container.querySelector<HTMLInputElement>("input[value='other']");
          otherContainer.style.display = otherCb?.checked ? "block" : "none";
          // Обновляем поле в мапе и кнопку
          this.updateStartButton();
        };

        for (const opt of field.options) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = opt.value;
          cb.id = `uf_${field.name}_${opt.value}`;
          cb.style.cssText = "margin:0; cursor:pointer; width:16px; height:16px; accent-color:var(--accent);";

          const lbl = document.createElement("label");
          lbl.htmlFor = cb.id;
          lbl.style.cssText = "font-size:13px; color:var(--text-dim); cursor:pointer; white-space:nowrap;";
          lbl.dataset.ufOpt = field.name;
          lbl.dataset.ufOptValue = opt.value;
          lbl.textContent = this._resolveOptionLabel(field, opt);

          const wrapper = document.createElement("div");
          wrapper.style.cssText = "display:flex; align-items:center; gap:6px; background:rgba(0,0,0,0.15); padding:6px 12px; border-radius:8px; border:1px solid var(--glass-border); transition: border-color 0.2s;";
          
          cb.addEventListener("focus", () => { wrapper.style.borderColor = "var(--accent)"; });
          cb.addEventListener("blur", () => { wrapper.style.borderColor = "var(--glass-border)"; });

          wrapper.appendChild(cb);
          wrapper.appendChild(lbl);

          cb.addEventListener("change", updateMultiselectValue);
          container.appendChild(wrapper);

          if (opt.value === "other") {
            otherText.addEventListener("input", updateMultiselectValue);
            otherContainer.appendChild(otherText);
            container.appendChild(otherContainer);
          }
        }

        fieldRow.appendChild(container);
        // Скрытое поле кладём в мапу вместо container
        // (по нему будем читать значение)
        (sectionWrapper || this.fieldContainer).appendChild(fieldRow);
        this.fieldElements.set(field.name, hiddenInput);
        continue; // переходим к следующему полю
      } else if (field.type === "select" && field.options) {
        const sel = document.createElement("select");
        sel.style.cssText = selectStyle;
        // Placeholder option
        const placeholderOpt = document.createElement("option");
        placeholderOpt.value = "";
        placeholderOpt.textContent = this._resolvePlaceholder(field) || t("common.select_placeholder");
        sel.appendChild(placeholderOpt);
        // Options. SP-35 (D-185): дискриминатор контента фильтруем по режиму —
        // «Довільний файл» (any_file) существует только в личном хранилище,
        // публичное поле его не показывает (сервер всё равно отвергнет 400).
        const optionList = field.name === "content_kind"
          ? visibleKindOptions(field.options, isPersonalScope())
          : field.options;
        for (const opt of optionList) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.dataset.ufOpt = field.name;
          option.dataset.ufOptValue = opt.value;
          option.textContent = this._resolveOptionLabel(field, opt);
          sel.appendChild(option);
        }
        // Для дискримінатора контенту предвибираємо активний kind, але тільки
        // якщо він дозволений у поточному режимі (інакше — firmware).
        if (field.name === "content_kind") {
          this.activeKind = pickKindForScope(
            this.activeKind, field.options, isPersonalScope(),
          );
          sel.value = this.activeKind;
        }
        // SP-31 (D-165): тип железа предвибраний «Original» — керуючий
        // елемент завжди визначений, майстер змінює його лише для клону.
        if (field.name === "hardware_type") {
          sel.value = "original";
        }
        inputEl = sel;
      } else if (field.type === "textarea") {
        const ta = document.createElement("textarea");
        ta.style.cssText = textareaStyle;
        ta.placeholder = this._resolvePlaceholder(field) || "";
        inputEl = ta;
      } else {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.style.cssText = inputStyle;
        inp.placeholder = this._resolvePlaceholder(field) || "";
        inputEl = inp;
      }

      // ID = "uf_" + field.name
      inputEl.id = `uf_${field.name}`;
      inputEl.name = field.name;

      // ── Дискримінатор контенту (content_kind) ──
      // При смене kind перезагружаем схему под выбранный класс контента.
      if (field.name === "content_kind" && inputEl instanceof HTMLSelectElement) {
        inputEl.addEventListener("change", () => {
          const kind = inputEl.value;
          if (kind) void this.switchKind(kind);
        });
      }

      // maxlength (HTMLSelectElement не имеет maxLength, пропускаем)
      if (field.max_length > 0 && inputEl instanceof HTMLInputElement) {
        (inputEl as HTMLInputElement).maxLength = field.max_length;
      } else if (field.max_length > 0 && inputEl instanceof HTMLTextAreaElement) {
        (inputEl as HTMLTextAreaElement).maxLength = field.max_length;
      }

      // required
      if (field.required) {
        inputEl.setAttribute("required", "true");
        inputEl.dataset.required = "true";
      }

      // Валидация при вводе
      inputEl.addEventListener("input", () => this.updateStartButton());
      inputEl.addEventListener("change", () => this.updateStartButton());

      fieldRow.appendChild(inputEl);
      (sectionWrapper || this.fieldContainer).appendChild(fieldRow);

      // Сохраняем в мапу
      this.fieldElements.set(field.name, inputEl);
    }
  }

  /** Локализованная метка секции (по ключу upload.section.<name>, fallback — raw section). */
  private _getSectionLabel(section: string): string {
    const key = `upload.section.${section}`;
    return hasKey(key) ? tLoose(key) : section;
  }

  /** Резолв label поля: kind-специфічний ключ → labelKey → ключ по імені → server label.
   *
   * SP-35 (D-185): одне поле `title` має різні підписи в різних kind —
   * «Назва софту» (software), «Назва мікросхеми» (datasheet), «Назва файлу»
   * (any_file).
   */
  private _resolveLabel(field: UploadFormField): string {
    if (this.activeKind && this.activeKind !== "firmware") {
      const kindKey = `upload.field.${field.name}.label_${this.activeKind}`;
      if (hasKey(kindKey)) return tLoose(kindKey);
    }
    const key = field.labelKey || `upload.field.${field.name}.label`;
    return hasKey(key) ? tLoose(key) : (field.label || "");
  }

  /** Резолв placeholder поля: placeholderKey → ключ по имени → server placeholder.
   *
   * Для поля description placeholder зависит от активного content_kind
   * (SPEC docs/SPEC_CONTENT_KINDS_UPLOAD.md): «о прошивке» / «о документе» /
   * «о софте». Резолвится через ключ upload.field.description.placeholder_<kind>.
   */
  private _resolvePlaceholder(field: UploadFormField): string {
    // kind-специфичный placeholder (описание и т.п.): upload.field.<name>.placeholder_<kind>
    if (this.activeKind && this.activeKind !== "firmware") {
      const kindKey = `upload.field.${field.name}.placeholder_${this.activeKind}`;
      if (hasKey(kindKey)) return tLoose(kindKey);
    }
    const key = field.placeholderKey || `upload.field.${field.name}.placeholder`;
    return hasKey(key) ? tLoose(key) : (field.placeholder || "");
  }

  /** Резолв label опции: labelKey → ключ по имени → server label. */
  private _resolveOptionLabel(
    field: UploadFormField,
    opt: { value: string; label?: string; labelKey?: string },
  ): string {
    const key = opt.labelKey || `upload.field.${field.name}.options.${opt.value}`;
    return hasKey(key) ? tLoose(key) : (opt.label || "");
  }

  /** Плейсхолдер "другого" поля в multiselect (например, тип микросхемы). */
  private _resolveOtherPlaceholder(field: UploadFormField): string {
    const key = `upload.field.${field.name}.other_placeholder`;
    return hasKey(key) ? tLoose(key) : t("common.other_placeholder");
  }

  /**
   * Обновить ТОЛЬКО подписи формы in-place (label / placeholder / option-тексты),
   * НЕ пересоздавая DOM.
   *
   * applySchemaToUI() пересоздаёт форму целиком и теряет введённые значения —
   * поэтому для смены языка он не подходит (инцидент: «смена языка на вкладке
   * Upload сбрасывает заполненные поля»). Здесь значения сохраняются: правятся
   * только тексты, помеченные data-атрибутами (ufLabel/ufOpt/ufOther/ufSection).
   */
  private _relabelSchema(): void {
    if (!this.uploadSchema) return;
    const fields = this.uploadSchema.fields;
    const byName = new Map(fields.map((f) => [f.name, f] as const));

    // 1. Метки секций (линия-разделитель сохраняется как child).
    this.fieldContainer.querySelectorAll<HTMLElement>("[data-uf-section]").forEach((secEl) => {
      const line = secEl.querySelector("div");
      secEl.textContent = this._getSectionLabel(secEl.dataset.ufSection || "");
      if (line) secEl.appendChild(line);
    });

    // 2. Метки полей (звёздочку required сохраняем).
    this.fieldContainer.querySelectorAll<HTMLLabelElement>("[data-uf-label]").forEach((labelEl) => {
      const field = byName.get(labelEl.dataset.ufLabel || "");
      if (!field) return;
      const star = labelEl.querySelector("span");
      labelEl.textContent = this._resolveLabel(field);
      if (star) labelEl.appendChild(star);
    });

    // 3. Тексты опций: <option> в select и <label> чекбоксов multiselect.
    this.fieldContainer.querySelectorAll<HTMLElement>("[data-uf-opt]").forEach((optEl) => {
      const field = byName.get(optEl.dataset.ufOpt || "");
      const src = field?.options?.find((o) => o.value === optEl.dataset.ufOptValue);
      if (field && src) optEl.textContent = this._resolveOptionLabel(field, src);
    });

    // 4. Плейсхолдеры: обычные поля — из мапы, «other» multiselect — по data-атрибуту.
    for (const [name, el] of this.fieldElements) {
      const field = byName.get(name);
      if (!field) continue;
      if (el instanceof HTMLSelectElement) {
        const ph = el.querySelector<HTMLOptionElement>('option[value=""]');
        if (ph) ph.textContent = this._resolvePlaceholder(field) || t("common.select_placeholder");
      } else if (el instanceof HTMLTextAreaElement) {
        el.placeholder = this._resolvePlaceholder(field) || "";
      } else if (el instanceof HTMLInputElement && el.type !== "hidden") {
        el.placeholder = this._resolvePlaceholder(field) || "";
      }
    }
    this.fieldContainer.querySelectorAll<HTMLInputElement>("[data-uf-other]").forEach((otherEl) => {
      const field = byName.get(otherEl.dataset.ufOther || "");
      if (field) otherEl.placeholder = this._resolveOtherPlaceholder(field);
    });
  }

  /**
   * Кнопка «Очистити поля» доступна только вне активной передачи (B):
   * во время upload'а форма — источник данных операции, менять её нельзя.
   * Единая точка синхронизации с флагом `uploadActive`.
   */
  private _syncClearFieldsBtn(): void {
    if (this.clearFieldsBtn) this.clearFieldsBtn.disabled = this.uploadActive;
  }

  /**
   * Очистить ВСЕ поля карточки файла одним кликом (B, 2026-09-23).
   *
   * Требование владельца: после выбора файла юзер заполнил карточку и хочет
   * начать заново — вместо ручного стирания каждого поля.
   *
   * Правила:
   *  - форма НЕ пересоздаётся (`applySchemaToUI` не вызывается) — значения
   *    стираются in-place, i18n-подписи и слушатели сохраняются;
   *  - выбранный файл/папка НЕ сбрасываются — чистится только карточка;
   *  - `content_kind` возвращается к базовому kind (`firmware`): если активен
   *    другой kind, форма перерисовывается схемой firmware (иначе остались бы
   *    поля документа/софта при пустом дискриминаторе);
   *  - кнопка «Почати» пересчитывается: обязательные поля пусты → disabled.
   */
  private _clearFormFields(): void {
    if (this.activeKind !== "firmware") {
      this.log("🧹 Clear fields: content_kind → firmware (schema reload)", "info");
      void this.switchKind("firmware");
      return; // switchKind перерисовывает схему — поля уже пустые
    }

    for (const [name, el] of this.fieldElements) {
      const field = this.schemaFieldMap.get(name);
      // В мапе у multiselect лежит скрытый input — чистим ещё чекбоксы и «other».
      if (field?.type === "multiselect") {
        el.value = "";
        this.fieldContainer
          .querySelectorAll<HTMLInputElement>(`input[type="checkbox"][id^="uf_${name}_"]`)
          .forEach((cb) => {
            cb.checked = false;
          });
        this.fieldContainer
          .querySelectorAll<HTMLInputElement>(`[data-uf-other="${name}"]`)
          .forEach((other) => {
            other.value = "";
            if (other.parentElement) other.parentElement.style.display = "none";
          });
        continue;
      }
      // select → placeholder-опция (value=""), input/textarea → пустая строка.
      el.value = "";
    }

    this.updateStartButton();
    this.log("🧹 Форму очищено (поля карточки)", "info");
  }

  /**
   * Перерисовать статусы/подписи после смены языка.
   *
   * ВАЖНО: выполняется ВСЕГДА, независимо от активности вкладки — иначе
   * неактивные вкладки «залипают» на старом языке до повторного открытия.
   * Форму обновляем in-place (_relabelSchema), а не пересозданием: иначе
   * теряются введённые пользователем значения.
   */
  applyLang(): void {
    this._relabelSchema();
    // Панель медиа карточки: подпись/кнопка перерисовываются, форма не пересоздаётся
    // (i18n-правило «без залипания языка»).
    this.mediaPanel?.applyLang();
    if (this.selectedPath !== null && this.uploadType) {
      this.uploadType.textContent = this.isDirectory ? t("common.folder") : t("common.file");
    }
    // Фаза 3: видимость radio контейнера + подпись (форму не пересоздаём).
    void this._refreshPackingUI().catch(() => {});
    // Фаза 3: подпись radio контейнера (форму НЕ пересоздаём — i18n-правило).
    if (this.containerLabel) {
      this.containerLabel.textContent = t("upload.container_label");
    }
    // D-182: подпись галочки «не пакувати» (только личное хранилище).
    if (this.skipPackingLabel) {
      this.skipPackingLabel.textContent = t("upload.skip_packing");
    }
    this._checkTdlibRuntimeStatus().catch(() => {});
  }

  /** Применить атрибуты схемы к DOM-элементу */
  private applyFieldAttrs(
    el: HTMLInputElement | HTMLTextAreaElement,
    field: UploadFormField | undefined,
  ): void {
    if (!field) return;

    // placeholder
    if (field.placeholder) {
      el.placeholder = field.placeholder;
    }

    // maxlength
    if (field.max_length > 0) {
      el.maxLength = field.max_length;
    }

    // required (визуально)
    if (field.required) {
      el.setAttribute("required", "true");
      el.dataset.required = "true";
    }
  }

  private log(msg: string, type: string = "info"): void {
    const line = document.createElement("div");
    line.className = `line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /**
   * Показать инструмент медиа только что загруженной карточки (SP-15 v3, D-069).
   *
   * Карточку берём из ответа `/complete`: публичный путь → `file_id` (дедуп
   * `duplicate`/`reanchored` ведёт на существующую карточку каталога), личный →
   * `personal_file_id`. Ответ без id → панель не показываем (fail-open: загрузка
   * уже успешна, инструмент есть в «Поиске»/«Личных файлах»).
   */
  private _showCardMedia(result: unknown): void {
    const card = uploadedCardRef(result);
    if (!card) return;
    const host = this.mediaPanelHost;
    if (!host) return;
    // Панель одна на страницу: показ другой карточки освободит её blob-адреса.
    this.mediaPanel ??= new CardMediaPanel(host, this._mediaPanelDeps());
    void this.mediaPanel.show(card).catch((err: any) => {
      this.log(`Media panel failed: ${err?.message ?? String(err)}`, "warn");
    });
  }

  /** Зависимости панели медиа (инжектятся — логика панели не знает про fetch/TDLib). */
  private _mediaPanelDeps() {
    return {
      baseUrl: () => api.getBaseUrl(),
      list: (kind: "file" | "personal", cardId: number) => api.cardMediaList(kind, cardId),
      // Байты: своя TDLib по якорю (SP-15 срез 5, D-071), иначе серверный прокси
      // (чужой публичный файл / движок занят) — `blob:` остаётся фолбэком.
      fetchBytes: (url: string, item?: ResolvedMedia) => this._mediaThumbBytes(url, item),
      addPhoto: (
        kind: "file" | "personal",
        cardId: number,
        filePath: string,
        hooks?: MediaUploadHooks,
      ) =>
        new CardMediaUploader({
          init: (k, id) => api.cardMediaInit(k, id),
          startUpload: (args) => invoke<string>("tdlib_start_upload", args),
          waitUpload: (uploadId) => invoke("tdlib_wait_upload", { uploadId }),
          complete: (k, id, uploadId) => api.cardMediaComplete(k, id, uploadId),
        }).addPhoto(kind, cardId, filePath, hooks),
      // Выбор фото — диалог Electron с фильтром изображений (один файл за раз:
      // тема карточки общая, отправка последовательная).
      pickPhotos: () => this._pickPhotos(),
      // Кольцо прогресса конкретного фото: rust-id из `tdlib_start_upload`
      // матчится с событиями `tdlib-upload-progress`.
      listenProgress: (cb: (e: MediaProgressEvent) => void) => this._listenMediaProgress(cb),
      log: (msg: string, type?: string) => this.log(msg, type),
    };
  }

  /**
   * Диалог выбора фото (SP-15 срез 3b): фильтр изображений, один файл за раз.
   *
   * Размер берём у движка (`get_path_info`), а не из диалога: он нужен только
   * для честного предупреждения «крупное фото — в вебе будет только превью».
   * Недоступный размер/путь деградируют молча (fail-open) — серверный лимит
   * и защита очереди (`no_path`/`duplicate`/`limit`) решают остальное.
   */
  private async _pickPhotos(): Promise<LocalMediaFile[]> {
    const picked = await open({
      multiple: false,
      title: t("media.pick_title"),
      filters: [
        { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] },
      ],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    const files: LocalMediaFile[] = [];
    for (const raw of paths) {
      const filePath = String(raw ?? "");
      if (!filePath) continue;
      let size = 0;
      try {
        const info = await invoke<{ size: number }>("get_path_info", { path: filePath });
        size = Number(info?.size ?? 0);
      } catch {
        /* размер не критичен: очередь и сервер считают файлы, а не байты */
      }
      files.push({
        path: filePath,
        name: filePath.split(/[\\/]/).pop() || filePath,
        size: Number.isFinite(size) && size > 0 ? size : 0,
      });
    }
    return files;
  }

  /**
   * Подписка на прогресс передачи фото. `listen()` асинхронный, а панель может
   * отписаться раньше его резолва (смена карточки/языка) — флаг `closed` держит
   * отписку корректной и не оставляет утечку слушателя.
   */
  private _listenMediaProgress(cb: (e: MediaProgressEvent) => void): () => void {
    let unlisten: UnlistenFn | null = null;
    let closed = false;
    void listen<MediaProgressEvent>("tdlib-upload-progress", (event) => {
      const payload = event?.payload;
      if (!closed && payload) cb(payload);
    })
      .then((fn) => {
        if (closed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* нет шины событий (тесты/ранняя стадия) — кольцо просто не рисуется */
      });
    return () => {
      closed = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* окно закрывается — не беда */
        }
        unlisten = null;
      }
    };
  }

  /** Диагностика пауз: логирует время от нажатия «Старт» (ms, T+x.x s). */
  private _phase(label: string): void {
    const s = ((performance.now() - this._uploadPhaseT0) / 1000).toFixed(2);
    const line = `⏱ [T+${s}s] ${label}`;
    console.log(`[UPLOAD-PHASE] ${line}`);
    this.log(line, "info");
  }

  private updateStartButton(): void {
    const hasPath = this.selectedPath !== null;

    // Используем правила из схемы, если доступны
    if (this.fieldElements.size > 0) {
      const allRequiredFilled = Array.from(this.fieldElements.entries())
        .filter(([name]) => {
          const field = this.schemaFieldMap.get(name);
          return field?.required === true;
        })
        .every(([, el]) => el.value.trim().length > 0);
      this.startUploadBtn.disabled = !(hasPath && allRequiredFilled);
    } else {
      // Схема не загрузилась — полей нет, кнопка неактивна
      this.startUploadBtn.disabled = true;
    }
  }

  /** Получить DOM-элемент поля по имени */
  private getFieldElement(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
    return this.fieldElements.get(name) || null;
  }

  /** Проверить поля по схеме и вернуть сообщение об ошибке или null */
  private validateFields(): string | null {
    if (this.fieldElements.size === 0 && this.schemaFieldMap.size === 0) {
      // fallback — нет ни динамических полей, ни схемы
      return null;
    }

    for (const field of this.schemaFieldMap.values()) {
      const el = this.getFieldElement(field.name);
      if (!el) continue;

      const value = el.value.trim();

      // required check
      if (field.required && !value) {
        return t("upload.field_required", { field: this._resolveLabel(field) });
      }

      // max_length check
      if (field.max_length > 0 && value.length > field.max_length) {
        return t("upload.field_too_long", {
          field: this._resolveLabel(field),
          max: field.max_length,
        });
      }
    }

    return null;
  }

  private async pickFile(): Promise<void> {
    try {
      const result = await open({
        multiple: false,
        title: t("upload.pick_file_title"),
      });
      if (result) {
        const path = result as string;
        await this.setSelected(path, false);
      }
    } catch (e: any) {
      this.log(`File selection error: ${e.message}`, "error");
    }
  }

  private async pickFolder(): Promise<void> {
    try {
      const result = await open({
        multiple: false,
        directory: true,
        title: t("upload.pick_folder_title"),
      });
      if (result) {
        const path = result as string;
        await this.setSelected(path, true);
      }
    } catch (e: any) {
      this.log(`Folder selection error: ${e.message}`, "error");
    }
  }

  /**
   * Drag & Drop цели выбора: файл → кнопка «Вибрати файл», папка → «Вибрати папку».
   *
   * Путь берётся из `File.path` (специфика Electron 22; `webUtils.getPathForFile`
   * появился только в Electron 29). Drop при disabled-кнопках (идёт upload)
   * игнорируется; несовпадение типа объекта с кнопкой — warn в лог, без выбора.
   */
  private _bindDropTarget(btn: HTMLButtonElement, expectDir: boolean): void {
    const over = (e: DragEvent): void => {
      e.preventDefault();
      if (!btn.disabled) btn.classList.add("drop-hover");
    };
    btn.addEventListener("dragenter", over);
    btn.addEventListener("dragover", over);
    btn.addEventListener("dragleave", (e: DragEvent) => {
      // Не снимаем подсветку при переходе на дочерний <span>/<img>.
      if (e.relatedTarget && btn.contains(e.relatedTarget as Node)) return;
      btn.classList.remove("drop-hover");
    });
    btn.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      btn.classList.remove("drop-hover");
      if (btn.disabled) return;
      void this._applyDroppedPath(e, btn, expectDir);
    });
  }

  /** Достать путь из drop, сверить тип объекта (файл/папка) с кнопкой и выбрать. */
  private async _applyDroppedPath(
    e: DragEvent,
    btn: HTMLButtonElement,
    expectDir: boolean,
  ): Promise<void> {
    const file = e.dataTransfer?.files?.[0];
    const path = (file as (File & { path?: string }) | undefined)?.path;
    if (!file || !path) {
      // Без File.path (не-Electron контекст) путь недоступен — сообщаем явно.
      this.log(t("upload.msg.drop_no_path"), "warn");
      return;
    }
    if (btn.disabled) return;
    try {
      const info = await invoke<{ size: number; is_dir: boolean; name: string }>(
        "get_path_info", { path },
      );
      if (info.is_dir !== expectDir) {
        this.log(
          t(expectDir ? "upload.msg.drop_folder_only" : "upload.msg.drop_file_only"),
          "warn",
        );
        return;
      }
      await this.setSelected(path, info.is_dir);
    } catch (err: any) {
      this.log(`Drop error: ${err.message}`, "error");
    }
  }

  private async setSelected(path: string, isDir: boolean): Promise<void> {
    this.selectedPath = path;
    this.isDirectory = isDir;

    try {
      const info = await invoke<{ size: number; is_dir: boolean; name: string }>(
        "get_path_info", { path },
      );
      this.selectedSize = info.size;

      this.fileInfo.style.display = "block";
      this.uploadPath.textContent = path;
      this.uploadSize.textContent = this.formatSize(info.size);
      this.uploadType.textContent = isDir ? t("common.folder") : t("common.file");
      this.log(`Selected: ${path} (${this.formatSize(info.size)})`, "info");
      // Фаза 3: показать строку контейнера, когда пакуем сами (папка/сырьё).
      await this._refreshPackingUI();
      this.updateStartButton();
    } catch (e: any) {
      this.log(`Read error: ${e.message}`, "error");
    }
  }

  /**
   * SP-37 (D-189): текущий класс контента (селектор формы) — единое чтение
   * для гейта папки и скрытия radio/checkbox пакування у не-firmware.
   */
  private _currentContentKind(): string {
    const el = this.fieldElements.get("content_kind");
    return (el && el.value && el.value.trim()) || this.activeKind || "firmware";
  }

  /**
   * Фаза 3: видимость radio «Контейнер» — показываем, только когда пакуем
   * САМИ (папка/мультифайл или сырой single). Готовый архив грузится как
   * есть — контейнер у него уже есть, выбор «ни на что» не влияет.
   * Чекбокс «Сжать перед отправкой» удалён (сжатие сырья обязательно) —
   * подпись больше не нужна, только peek-решение для видимости и лога.
   *
   * Вызывается при выборе файла/папки и в applyLang().
   */
  private async _refreshPackingUI(): Promise<void> {
    if (!this.selectedPath) {
      this._refreshSkipPackingRow(false);
      this._refreshContainerRow(false);
      return;
    }
    // SP-37 (D-189): для kind ≠ firmware пакування заборонено власником —
    // radio «Контейнер» и галочка «не пакувати» не имеют смысла (и папку
    // всё равно нельзя) → обе строки скрыты всегда.
    const contentKind = this._currentContentKind();
    if (!kindSupportsFolder(contentKind)) {
      this._refreshSkipPackingRow(false);
      this._refreshContainerRow(false);
      return;
    }
    // Папка (или >1 файла) пакуется всегда → radio виден, галочки «не пакувати» нет.
    if (this.isDirectory) {
      this._refreshSkipPackingRow(false);
      this._refreshContainerRow(true);
      return;
    }
    try {
      const header = await invoke<number[]>("peek_file_header", {
        path: this.selectedPath,
        n: 8,
      });
      const fileName = this.selectedPath.split(/[/\\]/).pop() ?? "";
      const decision = decideSingleSource({
        fileName,
        header,
        allowSkipPacking: this._skipPackingActive(),
      });
      // Галочка «не пакувати» осмысленна только для сырья (source=file):
      // у готового архива решение принимают байты, а не мастер.
      this._refreshSkipPackingRow(decision.source === "file");
      // Сырьё с активной галочкой не пакуется → контейнер выбирать нечего.
      this._refreshContainerRow(decision.shouldArchive);
      this.log(`Single policy: ${decision.reason}`, "info");
    } catch {
      // peek недоступен — контейнер показываем по факту упаковки (сырьё
      // пакуется всегда, готовый архив — нет; без peek это не различить,
      // поэтому по умолчанию прячем до старта, где решение примется заново).
      this._refreshSkipPackingRow(false);
      this._refreshContainerRow(false);
    }
  }

  /**
   * Фаза 3: активный контейнер упаковки из radio — единый источник правды
   * (уходит в `pack_archive` и в манифест как `container`).
   * Default — tar.zst (скорость/размер), ZIP — «открывается везде».
   */
  private _uploadContainer(): UploadContainer {
    return this.containerZipRadio?.checked ? "zip" : "tar_zst";
  }

  /** Показать/скрыть row выбора контейнера (только когда пакуем сами). */
  private _refreshContainerRow(packing: boolean): void {
    if (!this.containerRow) return;
    this.containerRow.style.display = packing ? "flex" : "none";
  }

  /**
   * D-182: «не пакувати» разрешено ТОЛЬКО в личном хранилище.
   *
   * Публичный каталог пакует всегда (решение владельца 2026-11-11): сырьё в
   * общий каталог не принимается, там нужен предсказуемый контейнер.
   */
  private _skipPackingAllowed(): boolean {
    return isPersonalScope();
  }

  /** Активен ли выбор «не пакувати»: право режима И галочка мастера. */
  private _skipPackingActive(): boolean {
    return this._skipPackingAllowed() && this.skipPackingCheckbox?.checked === true;
  }

  /**
   * Строка «не пакувати»: только личный режим и только когда файл — сырьё
   * (у готового архива / bundle выбора нет: решение принимают байты).
   */
  private _refreshSkipPackingRow(rawFile: boolean): void {
    if (!this.skipPackingRow) return;
    const visible = rawFile && this._skipPackingAllowed();
    this.skipPackingRow.style.display = visible ? "flex" : "none";
  }

  /**
   * Self-delete своих PM-сообщений (best-effort; ошибка не роняет teardown).
   *
   * Принимает ОПЦИОНАЛЬНЫЙ снимок координат: cancelUpload выполняется параллельно
   * с `finally` в startUpload, который обнуляет this.pmChatIdSelf/this.pmMessageIds.
   * Без снимка self-delete мог бы прочитать пустой список и пропустить удаление.
   */
  private async _deleteOwnPmMessages(
    chatId?: number | null,
    messageIds?: number[],
  ): Promise<void> {
    const chat = chatId ?? this.pmChatIdSelf;
    const ids = messageIds ?? this.pmMessageIds;
    if (!chat || !ids.length) return;
    try {
      await invoke("tdlib_delete_messages", {
        chatId: chat,
        messageIds: ids,
      });
      this.log(`🗑 PM cleanup: own upload messages deleted: ${ids.length}`, "info");
    } catch (err: any) {
      console.warn("PM self-delete failed:", err?.message || err);
    } finally {
      this.pmMessageIds = [];
    }
  }

  /** true, если операция с данным поколением всё ещё актуальна (не отменена). */
  private _isCurrent(epoch: number): boolean {
    return epoch === this._epoch;
  }

  /**
   * Прервать устаревшую (отменённую) попытку.
   *
   * Вызывается после каждого длинного await: если пользователь нажал Cancel
   * или начал новую загрузку, старая цепочка обязана остановиться и не
   * вызывать `/complete`/credit по отменённой операции.
   */
  private _throwIfStale(epoch: number): void {
    if (!this._isCurrent(epoch)) {
      throw new Error("Upload cancelled by user");
    }
  }

  /**
   * ⛔ Cancel = ГЛОБАЛЬНАЯ отмена (§7.2 плана Cancel/Resume):
   * 1) стоп Rust-передачи; 2) серверный teardown (Vault-якоря, per-upload тема);
   * 3) self-delete своих PM-сообщений; 4) удаление архива; 5) reset UI.
   */
  private async cancelUpload(): Promise<void> {
    if (this.cancelled || this._cancelling) return;
    this.cancelled = true;
    this._cancelling = true;
    // Новое поколение: все уже запущенные цепочки становятся устаревшими и
    // больше не дойдут до /complete (иначе Cancel «оживал» после teardown).
    this._epoch++;
    this.log("⛔ Upload cancelled (global)", "warn");
    this.progress.setCancelled();
    if (this.cancelUploadBtn) this.cancelUploadBtn.style.display = "none";

    // ⚠️ СНИМАЕМ ВСЕ КООРДИНАТЫ ДО ЛЮБЫХ await. `cancelUpload()` выполняется
    // ПАРАЛЛЕЛЬНО с `startUpload()` (кнопка не ждёт фонового upload). Как только
    // Rust останавливает передачу, `finally` в startUpload немедленно обнуляет
    // this.serverUploadId / this.currentUploadId / this.pmChatIdSelf /
    // this.pmMessageIds. Если прочитать их ПОСЛЕ await — получим null → серверный
    // teardown и self-delete PM молча пропадают (job/Vault/тема/PM остаются).
    const rustId = this.currentUploadId;
    const sid = this.serverUploadId;
    const pmChat = this.pmChatIdSelf;
    const pmIds = [...this.pmMessageIds];

    // 1. Стоп Rust-передачи (Rust TDLib upload_id; для multi — глобальный флаг).
    try {
      await invoke("tdlib_cancel_upload", { uploadId: rustId });
      if (rustId) this.log(`🗑️ TDLib cancel sent (upload_id=${rustId})`, "info");
      else this.log("🗑️ TDLib cancel sent (global, multi-upload)", "info");
    } catch (e) {
      console.warn("tdlib_cancel_upload failed:", e);
    }
    if (this.abortController) this.abortController.abort();

    // 1b. Сброс upload-кеша TDLib. Без него повторная заливка ТОГО ЖЕ файла
    // мгновенно «вспоминает» уже загруженный remote-файл (local→remote mapping в
    // ~/.tdlib): часть не качается, прогресс-событий нет → UI висит на 0%, а часть
    // уходит в PM. Очистка кеша заставляет следующий старт реально качать с
    // нулевого байта с нормальным прогрессом. Ждём ~500ms, чтобы drain_cancellations
    // успел отправить cancelUploadFile { delete: true } по активным upload.
    //
    // BUG-CANCEL-FINAL-001: кеш общий на сессию → при активном скачивании в
    // другой вкладке пург пропускаем (иначе снесём кеш частей download).
    if (shouldPurgeTdlibCacheOnCancel(this.otherTransferActive?.() === true)) {
      try {
        await new Promise(r => setTimeout(r, 500));
        const cacheRes = await invoke<string>("tdlib_clear_cache");
        this.log(`🧹 TDLib upload cache cleared after cancel: ${cacheRes}`, "info");
      } catch (e: any) {
        console.warn("tdlib_clear_cache after cancel failed:", e?.message || e);
      }
    } else {
      this.log(
        "ℹ️ TDLib cache purge skipped: another transfer is active (cache is shared)",
        "warn",
      );
    }

    // 2. Серверный teardown: удаляет Vault-якоря и per-upload тему, job — DELETE.
    if (sid) {
      try {
        await api.cancelUpload(sid);
        this.log("✅ Server-side teardown (Vault/DB) done", "info");
      } catch (e: any) {
        this.log(`⚠️ Server-side cancel error: ${e?.message || String(e)}`, "warn");
      }
    }

    // 3. Self-delete своих PM-сообщений (части, что реально ушли в PM).
    await this._deleteOwnPmMessages(pmChat, pmIds);

    // 4. Удаление temp-архива.
    await this.tryRemoveArchive();

    // 4b. 🧹 BUG-CANCEL-FINAL-001: дворник после отмены (порог 0 — движок
    // остановлен шагом 1): слайсы `{pid}_{i}.part` multi-upload, temp-архив,
    // который tryRemoveArchive мог не снять (файл занят на Windows).
    await this.cleanupStaleArchives("cancel");

    // 5. Reset.
    this.serverUploadId = null;
    this.currentUploadId = null;
    this.pmChatIdSelf = null;

    this.startUploadBtn.disabled = false;
    this.selectFileBtn.disabled = false;
    this.selectFolderBtn.disabled = false;
    this.cancelUploadBtn.disabled = true;
    this.abortController = null;
    this.cancelled = false;
    // Cancel забрал владение UI: finally отменённой цепочки уже ничего не сбросит.
    this._activeEpoch = null;
    this.uploadActive = false;
    // Teardown завершён — новый старт снова разрешён.
    this._cancelling = false;
    this._syncClearFieldsBtn();
  }

  /** Общий финал: /complete (+polling) → self-delete PM после vaulted → credit → reset. */
  private async _finalizeAndCredit(
    serverUploadId: string,
    completePayload: Record<string, any>,
    hostCleanupPm: { chat: number; messageIds: number[] } | null,
    epoch: number,
  ): Promise<void> {
    this._throwIfStale(epoch);
    this.log(`📡 Complete → /desktop/uploads/${serverUploadId}/complete`, "info");
    this.progress.update(95, t("upload.finalizing"));
    this.progress.setMessage(t("upload.finalizing"));

    const COMPLETE_POLL_INTERVAL = 2_000;
    const COMPLETE_TIMEOUT = 5_400_000;
    let completeResult: Awaited<ReturnType<typeof api.uploadComplete>> | null = null;

    const completeResponse = await api.uploadComplete(serverUploadId, completePayload);

    if (completeResponse.status === "accepted") {
      const pollStartTime = Date.now();
      while (true) {
        this._throwIfStale(epoch);
        if (this.cancelled) throw new Error("Upload cancelled by user");
        if (Date.now() - pollStartTime > COMPLETE_TIMEOUT) {
          throw new Error(`Complete polling timeout (${COMPLETE_TIMEOUT / 1000}s). Upload may still be in progress on server.`);
        }
        try {
          const pollResult: any = await api.uploadCompleteStatus(serverUploadId);
          const pollState = pollResult?.status || "unknown";
          if (pollState === "completed") {
            completeResult = pollResult;
            break;
          } else if (pollState === "failed") {
            throw new Error(`Complete failed: ${pollResult?.error || "Unknown error"}`);
          } else {
            const progressPct = pollResult?.progress_pct || 0;
            this.progress.update(95 + Math.floor(progressPct * 0.04), t("upload.finalizing_pct", { pct: progressPct }));
            this.progress.setMessage(t("upload.waiting_finish", { n: Math.floor((Date.now() - pollStartTime) / 1000) }));
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          this.log(`⚠️ Complete-poll error: ${errMsg} → retry`, "warn");
        }
        await new Promise(r => setTimeout(r, COMPLETE_POLL_INTERVAL));
      }
    } else {
      completeResult = completeResponse;
    }

    this.log(`✅ Done! Status: ${completeResult!.status}`, "success");
    this.progress.setDone();

    // Self-delete PM после vaulted (Host-Mediation).
    const completedVaulted = (completeResult as any)?.vaulted === true;
    if (hostCleanupPm && completedVaulted) {
      this.pmChatIdSelf = hostCleanupPm.chat;
      this.pmMessageIds = hostCleanupPm.messageIds;
      await this._deleteOwnPmMessages();
    }

    // Credit-поинты.
    const creditFileId = (completeResult as any).file_id as number | undefined;
    if (creditFileId) {
      // Баллы начисляем только если операция не была отменена во время /complete.
      this._throwIfStale(epoch);
      try {
        await api.creditPoints(creditFileId);
        this._refreshBalanceDisplay();
      } catch (creditErr: any) {
        this.log(`⚠️ Failed to credit points: ${creditErr?.message || String(creditErr)}`, "warn");
      }
    }

    this.log("✅ Upload finished", "success");

    // Reset после успеха (архив можно удалить).
    this.serverUploadId = null;
    this.pmChatIdSelf = null;
    this.pmMessageIds = [];
    this.currentUploadId = null;
    await this.tryRemoveArchive();

    this.startUploadBtn.disabled = false;
    this.selectFileBtn.disabled = false;
    this.selectFolderBtn.disabled = false;
    if (this.cancelUploadBtn) { this.cancelUploadBtn.style.display = "none"; this.cancelUploadBtn.disabled = true; }
    this.abortController = null;

  }

  private _resetButtons(): void {
    this.startUploadBtn.disabled = false;
    this.selectFileBtn.disabled = false;
    this.selectFolderBtn.disabled = false;
    this.cancelUploadBtn.disabled = true;
    this.abortController = null;
    this.cancelled = false;
  }

  /**
   * Best-effort удаление temp-архива текущей сессии (BUG-DESKTOP-UI-003).
   * Удаляется ТОЛЬКО если архив реально создан: currentArchivePath задан и
   * отличается от selectedPath (для одиночного файла archivePath == selectedPath —
   * исходный файл пользователя удалять нельзя).
   * Ошибка удаления не фатальна: файл может быть занят (Windows) — повторную
   * попытку делает finally в startUpload(), остатки чистит cleanup_stale_archives.
   */
  private async tryRemoveArchive(): Promise<void> {
    const archivePath = this.currentArchivePath;
    if (!archivePath || archivePath === this.selectedPath) return;
    try {
      await invoke("remove_archive", { path: archivePath });
      this.log(`🧹 Temp archive removed: ${archivePath}`, "info");
      this.currentArchivePath = null;
    } catch (e: any) {
      // Не выводим в UI (не i18n-сообщение): удаление — best-effort, файл может
      // быть занят Rust-стороной. DevTools-only лог.
      const msg = e?.message || String(e);
      console.warn(`remove_archive failed (${archivePath}): ${msg}`);
    }
  }

  /**
   * Дворник temp-мусора (BUG-DESKTOP-UI-003 + BUG-CANCEL-FINAL-001).
   *
   * Чистит в Rust: `temp/firmware-desktop/*.zip|*.zst` (temp-архивы upload) и
   * `temp/tdlib_upload_parts/*.part` (слайсы multi-upload `{pid}_{i}.part`), а
   * на `startup` — ещё и файловый кеш TDLib (BUG-JANITOR-WIN-001: на Windows это
   * `%LOCALAPPDATA%\firmware-desktop-electron\tdlib_files`; иначе он копился
   * бесконечно у тех, кто только заливает файлы).
   *
   * Порог возраста и признак «чистить ли кеш» задаёт чистая функция
   * `buildJanitorRequest` (JanitorPolicy): порог 0 для ВСЕХ триггеров (второй
   * экземпляр запрещён замком `requestSingleInstanceLock`,
   * BUG-SINGLE-INSTANCE-001), а кеш — только на старте и только если в другой
   * вкладке не идёт передача (кеш общий на TDLib-сессию).
   *
   * Ошибки — только console (дворник не должен ломать завершение операции).
   */
  private async cleanupStaleArchives(
    trigger: JanitorTrigger = "startup",
  ): Promise<void> {
    try {
      const req = buildJanitorRequest(
        trigger,
        this.otherTransferActive?.() === true,
      );
      const removed = await invoke<number>("cleanup_stale_archives", {
        maxAgeSecs: req.maxAgeSecs,
        includeTdlibCache: req.includeTdlibCache,
      });
      if (removed > 0) {
        console.log(`🧹 Cleanup (${trigger}): stale temp files removed: ${removed}`);
      }
    } catch (e: any) {
      console.warn(`cleanup_stale_archives (${trigger}) failed:`, e?.message || e);
    }
  }

  /** Очистить файловый кеш TDLib (/tmp/tdlib_files и /tmp/tdlib_download_parts). */
  private async clearTdlibCache(): Promise<void> {
    this.clearCacheBtn.disabled = true;
    this.clearCacheResult.textContent = t("upload.cache_clearing");
    this.clearCacheResult.style.color = "var(--text-dim)";
    try {
      const result = await invoke<string>("tdlib_clear_cache");
      this.clearCacheResult.textContent = `✅ ${result}`;
      this.clearCacheResult.style.color = "var(--success)";
      this.log(`🧹 ${result}`, "success");
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      this.clearCacheResult.textContent = `❌ ${errMsg}`;
      this.clearCacheResult.style.color = "var(--error)";
      this.log(`❌ Cache cleanup error: ${errMsg}`, "error");
    } finally {
      this.clearCacheBtn.disabled = false;
      // Автоочистка сообщения через 10 секунд
      setTimeout(() => {
        this.clearCacheResult.textContent = "";
      }, 10000);
    }
  }

  /** Обновить отображение баланса в статус-баре после начисления баллов */
  private async _refreshBalanceDisplay(): Promise<void> {
    try {
      const appState = await api.getAppState();
      const infoEl = document.getElementById("statusExtra");
      if (appState?.user && infoEl) {
        const u = appState.user;
        if (!u.is_banned) {
          const parts: string[] = [];
          if (u.is_unlimited) parts.push(t("header.unlimited"));
          parts.push(t("header.balance", { n: u.balance }));
          infoEl.textContent = parts.join(" | ");
        }
      }
    } catch {
      // Не фатально — баланс обновится при следующем открытии
    }
  }

  /**
   * Идёт ли активная upload-передача.
   *
   * Нужно DownloadPage: файловый кеш TDLib общий на сессию, поэтому пург
   * кеша при отмене скачивания пропускается, пока идёт upload
   * (BUG-CANCEL-FINAL-001, `JanitorPolicy.shouldPurgeTdlibCacheOnCancel`).
   */
  isUploadActive(): boolean {
    return this.uploadActive;
  }

  /** Очистить beforeunload при уничтожении страницы */
  destroy(): void {
    if (this._beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
  }

  /**
   * Phase 3 (гигиена PM): один раз за установку — mute + archive чата с ботом.
   * Флаг в localStorage (`bot_chat_quiet_done`). Best-effort: ошибки TDLib
   * (уже в архиве и т.п.) игнорируются, upload не блокируется.
   */
  private _ensureBotChatQuiet(pmChatId: string | undefined): void {
    if (!pmChatId) return;
    try {
      if (localStorage.getItem("bot_chat_quiet_done") === "1") return;
      localStorage.setItem("bot_chat_quiet_done", "1");
    } catch {
      return; // нет localStorage — тихо выходим
    }
    const chatId = parseInt(pmChatId, 10);
    if (!Number.isFinite(chatId) || chatId <= 0) return;
    void (async () => {
      try {
        await invoke("tdlib_quiet_bot_chat", { chatId });
        this.log("🤫 Bot chat muted and archived (PM hygiene)", "info");
      } catch (e) {
        // Не критично: юзер может вручную заархивировать; флаг уже стоит —
        // повторять не будем, чтобы не спамить TDLib на каждой загрузке.
        this.log(`⚠️ Bot chat quiet failed (non-critical): ${String(e)}`, "warn");
      }
    })();
  }

  /**
   * Phase 4 (гигиена PM): дочищаем СТАРЫЙ (>48ч) мусор в PM.
   * Сервер отдаёт координаты (bot уже не может удалить), клиент удаляет
   * СВОИ сообщения (revoke) — без ограничения по возрасту. Best-effort.
   *
   * BUG-CANCEL-FINAL-001: клиентский 24ч-гейт (localStorage `old_pm_sweep_at`)
   * УБРАН — дворник работает на КАЖДОЙ операции. Гейт был лишним: серверная
   * половина и так отдаёт только элементы старше 48ч и только своей личной
   * ветки, так что повторный вызов идемпотентен и дешёв (обычно 0 items).
   */
  private _sweepOldPmDocs(): void {
    void (async () => {
      try {
        const res = await api.getOldPmCleanup();
        if (!res || !res.items || res.items.length === 0) return;
        let cleaned = 0;
        for (const it of res.items) {
          try {
            await invoke("tdlib_delete_messages", {
              chatId: it.chat_id,
              messageIds: it.message_ids,
              revoke: true,
            });
            cleaned += it.message_ids.length;
          } catch {
            // best-effort: часть может не удалиться — попробуем в следующий раз
          }
        }
        if (cleaned > 0) {
          this.log(`🧹 Old PM litter cleaned (${cleaned} msgs)`, "info");
        }
      } catch {
        // тихо: свип не критичен
      }
    })();
  }

  private async startUpload(): Promise<void> {
    if (!this.selectedPath) return;

    // Отменённая операция ещё разбирается (teardown) — новый старт запрещён.
    if (this._cancelling) {
      this.log("Cancel is still in progress — try again in a moment", "warn");
      return;
    }

    // Новое поколение операции: всё, что было запущено раньше, становится
    // устаревшим (не дойдёт до /complete).
    const epoch = ++this._epoch;
    this._activeEpoch = epoch;

    // Инструмент медиа прошлой карточки отвязываем сразу: его галерея относится к ДРУГОМУ
    // файлу. НО очередь выбранных фото сохраняем — по приказу владельца фото выбирают ДО
    // загрузки, и они принадлежат именно той карточке, что сейчас создаётся (`detachCard`,
    // а не `dispose`: тот стёр бы выбор пользователя).
    this.mediaPanel?.detachCard();

    // Диагностика паузы «кнопка Старт → реальная передача байт»
    this._uploadPhaseT0 = performance.now();
    this._firstBytesLogged = false;

    // Валидация полей через схему (или fallback)
    const validationError = this.validateFields();
    if (validationError) {
      this.log(`❌ ${validationError}`, "error");
      return;
    }

    // Збираємо значення всіх динамічних полів
    const fieldValues: Record<string, string> = {};
    for (const [name, el] of this.fieldElements) {
      fieldValues[name] = el.value.trim();
    }
    const contentKind = fieldValues["content_kind"] || this.activeKind || "firmware";
    const brand = fieldValues["brand"] || "";
    const model = fieldValues["model"] || "";
    const version = fieldValues["version"] || "";
    const description = fieldValues["description"] || undefined;
    const title = fieldValues["title"] || "";
    const docType = fieldValues["doc_type"] || "";

    const tgId = this.getTgId();
    if (!tgId) {
      this.log("❌ Auth error: no tg_id", "error");
      return;
    }

    // ── Telegram API credentials ──
    // Zero Secrets in Binary: hash не запекается в .exe. Цепочка fallback:
    //   1) /api/capabilities → api_id (public, без hash)
    //   2) /api/client-config (Bearer) → api_hash (только аутентифицированному Desktop)
    //   3) VITE_TELEGRAM_API_HASH → опциональный dev-fallback
    // Если ни один источник не дал hash — логируем, TDLib не сможет авторизоваться.
    if (!this.tgApiId || !this.tgApiHash) {
      try {
        const caps = await api.getCapabilities();
        if (caps.telegram_api_id && !this.tgApiId) {
          this.tgApiId = caps.telegram_api_id;
        }
      } catch {
        this.log("⚠️ Failed to load telegram_api_id from /api/capabilities", "warn");
      }
      if (!this.tgApiHash && api.getToken()) {
        try {
          const cfg = await api.getClientConfig();
          if (cfg?.ok && cfg.telegram_api_hash) {
            this.tgApiHash = cfg.telegram_api_hash;
            if (!this.tgApiId && cfg.telegram_api_id) this.tgApiId = cfg.telegram_api_id;
            this.log("🔑 api_hash received from server (/api/client-config)", "info");
          }
        } catch {
          this.log("⚠️ client-config unavailable (no Bearer or network)", "warn");
        }
      }
      if (!this.tgApiHash) {
        this.tgApiHash = import.meta.env.VITE_TELEGRAM_API_HASH || "";
        if (this.tgApiHash) this.log("🔑 api_hash from VITE_* (dev fallback)", "info");
      }
    }

    this.log(`🔑 API ID: ${this.tgApiId}${this.tgApiHash ? ', hash: present' : ', hash: MISSING'}`, "info");

    // Валидация обязательных полей до начала любых операций.
    // У title-only kind (software/datasheet/isp_emmc/repair_pictures/any_file)
    // бренд/модель/шасси — необязательные метаданные (SPEC §7/§13); «Назва
    // файлу» обязательна для software/datasheet/isp_emmc/repair_pictures
    // (у any_file пустое название = имя файла).
    if (kindNeedsBrandModel(contentKind) && (!brand || !model)) {
      this.log("❌ Fill in the required fields: brand, model", "error");
      this.startUploadBtn.disabled = false;
      this.selectFileBtn.disabled = false;
      this.selectFolderBtn.disabled = false;
      return;
    }
    if (kindRequiresTitle(contentKind) && !title) {
      this.log("❌ Fill in the required field: title", "error");
      this.startUploadBtn.disabled = false;
      this.selectFileBtn.disabled = false;
      this.selectFolderBtn.disabled = false;
      return;
    }

    // D-167: карточка прошивки — model не может повторять brand (регистр и
    // лишние пробелы не важны). Повтор = неправильно заполненные поля: загрузка
    // блокируется с явным предупреждением. Шасси НЕ сравнивается (совпадение
    // model/chassis бывает легитимным — решение владельца).
    if (contentKind === "firmware" && brand && model) {
      const normCardField = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
      if (normCardField(model) === normCardField(brand)) {
        this.log(
          "❌ Wrong card fields: model must differ from brand (case-insensitive)",
          "error",
        );
        this.startUploadBtn.disabled = false;
        this.selectFileBtn.disabled = false;
        this.selectFolderBtn.disabled = false;
        return;
      }
    }

    // SP-37 (D-189): папку/несколько файлов можно загрузить ТОЛЬКО как
    // Прошивку. Архивирование при upload разрешено владельцем только для
    // firmware, а raw-мультифайлового режима в протоколе нет — поэтому для
    // остальных kind папка блокируется ДО старта (до скана/пакования).
    if (this.isDirectory && !kindSupportsFolder(contentKind)) {
      this.log(`❌ ${t("upload.folder_firmware_only")}`, "error");
      this.startUploadBtn.disabled = false;
      this.selectFileBtn.disabled = false;
      this.selectFolderBtn.disabled = false;
      return;
    }

    // ════════════════════════════════════════════════════════════════════
    // BUG-AUTH-014: Ранний live-check статуса TDLib runtime — ДО начала
    // сканирования/архивации/инициализации, чтобы не делать лишнюю работу
    // при недоступном runtime.
    // ════════════════════════════════════════════════════════════════════
    const runtimeStatusEarly = await invoke<{ ready: boolean }>("tdlib_runtime_status");
    if (!runtimeStatusEarly.ready) {
      this.log(
        "❌ TDLib shared runtime unavailable. Wait for authorization to complete.",
        "error",
      );
      this.startUploadBtn.disabled = false;
      this.selectFileBtn.disabled = false;
      this.selectFolderBtn.disabled = false;
      return;
    }
    this._tdlibRuntimeReady = true;

    // Между guard'ом и этой точкой был await (tdlib_runtime_status) — пользователь
    // мог успеть нажать Cancel: тогда поколение сменилось, и мы обязаны выйти,
    // НЕ сбрасывая состояние отмены и не начиная передачу.
    if (!this._isCurrent(epoch)) {
      this.log("Upload was cancelled — start aborted", "warn");
      return;
    }

    // Сброс состояния отмены
    this.cancelled = false;
    this.currentUploadId = null;
    this.serverUploadId = null;
    this._afterTransfer = false;
    this.pmChatIdSelf = null;
    this.pmMessageIds = [];
    this.uploadActive = true; // beforeunload
    this.abortController = new AbortController();
    this.uploadStartTime = 0;
    this._syncClearFieldsBtn();

    this.startUploadBtn.disabled = true;
    this.selectFileBtn.disabled = true;
    this.selectFolderBtn.disabled = true;
    this.cancelUploadBtn.style.display = "inline-flex";
    this.cancelUploadBtn.disabled = false;
    this.progressContainer.style.display = "block";
    this.progress.reset();
    this.logEl.innerHTML = "";

    let archivePath: string | null = null;
    this.currentArchivePath = null; // новый upload — архив (если создастся) будет новый

    try {
      // 1. Сканирование / хэширование (долгая фаза — busy-индикация П.3)
      this.log("🔍 Scanning files...", "info");
      this.progress.startBusy(t("upload.scanning_busy"));
      const scanResult = await invoke<{
        files: Array<{ path: string; size: number; sha256: string }>;
        total_size: number;
        bundle_sha256: string;
      }>("scan_and_hash", {
        path: this.selectedPath,
        isDirectory: this.isDirectory,
      });
      this.progress.stopBusy();

      this._phase(`scan_and_hash done (${scanResult.files.length} files, ${this.formatSize(scanResult.total_size)})`);
      this.log(`Files found: ${scanResult.files.length}`, "info");
      this.log(`Checksum: ${scanResult.bundle_sha256.substring(0, 16)}...`, "info");

      // 2. Архивация:
      //  - папка (или >1 файла) → ВСЕГДА пакуем, уровень дефолт (None=6);
      //  - одиночный файл → «Умный Single Upload» (BUG-SMART-SINGLE-UPLOAD-001):
      //    готовый архив (расширение+magic) → skip перепаковки, грузим как есть;
      //    сырой → по чекбоксу «Сжать перед отправкой» (ON=Fast/1, OFF=как есть).
      archivePath = this.selectedPath;
      let archiveSize = this.selectedSize;
      // Серверный тип содержимого: bundle (наш архив в облаке) vs file (сырьё).
      // Манифест ниже обязан совпасть с решением — download распаковывает
      // ТОЛЬКО bundle (magic-фолбэк BUG-DESKTOP-UI-006 — страховка для старых).
      let singleSource: SingleSource = "bundle";
      // Фаза 3: контейнер архива для манифеста. Заполняется, когда архив
      // создали МЫ (выбранный radio) или когда готовый наш архив грузим как
      // есть (его контейнер знает политика: zip | tar_zst).
      let manifestContainer: UploadContainer | null = null;

      if (this.isDirectory || scanResult.files.length > 1) {
        const container = this._uploadContainer();
        this.log(`📦 Packing into the archive... (${container})`, "info");
        // Упаковка папки — минуты: busy-пульс вместо «замиршего» прогресса (П.3).
        this.progress.startBusy(t("upload.packing_busy"));

        archivePath = await invoke<string>("pack_archive", {
          path: this.selectedPath,
          isDirectory: this.isDirectory,
          bundleHash: scanResult.bundle_sha256,
          container,
        });
        this.progress.stopBusy();
        manifestContainer = container;
        // Реальный temp-архив создан — запоминаем для cleanup в finally/cancelUpload.
        this.currentArchivePath = archivePath;
        archiveSize = await invoke<number>("get_path_info", { path: archivePath }).then(
          (i: any) => i.size,
        );

        this.log(`Archive created: ${this.formatSize(archiveSize)}`, "info");
      } else if (!this.isDirectory && scanResult.files.length === 1) {
        // Одиночный файл: peek 8 байт + решение (расширение имеет вес,
        // байты — решающий голос).
        const fileName = this.selectedPath!.split(/[/\\]/).pop() ?? "";
        const header = await invoke<number[]>("peek_file_header", {
          path: this.selectedPath,
          n: 8,
        });
        const decision = decideSingleSource({
          fileName,
          header,
          allowSkipPacking: this._skipPackingActive(),
          // SP-37/D-189: архівування — тільки для Прошивки; інші kind йдуть
          // байтами як є (ready/file), container=null → manifest firmware_file.
          packRaw: kindSupportsFolder(contentKind),
        });
        singleSource = decision.source;
        this.log(`Single policy at start: ${decision.reason}`, "info");
        this._phase(`single_source=${decision.source} should_archive=${decision.shouldArchive}`);

        if (!decision.shouldArchive) {
          // Готовый наш архив грузим как есть → его контейнер знает политика.
          manifestContainer = decision.container;
          if (decision.source === "bundle") {
            this.log(t("upload.skip_ready_archive"), "info");
          } else if (decision.source === "ready") {
            // V3: чужой архив (.7z/.rar/…) — отдаём валидным файлом как есть,
            // распаковка — архиватором получателя (свой распаковываем только ZIP).
            this.log(t("upload.skip_foreign_archive"), "info");
          } else {
            // D-182 (личное хранилище, «не пакувати»): байты уходят как есть,
            // манифест ниже объявит firmware_file → сервер запишет НАСТОЯЩИЙ
            // хэш байтов (BUG-CABINET-VAULT-SHA-MISMATCH-001).
            this.log("Raw file — packing skipped (personal vault), sending bytes as-is", "info");
          }
          // archivePath/archiveSize остаются = исходный файл (как есть).
        } else {
          const container = this._uploadContainer();
          this.log(`📦 Packing into the archive... (single, ${container}, Fast level 1)`, "info");
          this.progress.startBusy(t("upload.packing_busy"));

          archivePath = await invoke<string>("pack_archive", {
            path: this.selectedPath,
            isDirectory: false,
            bundleHash: scanResult.bundle_sha256,
            container,
            compressionLevel: 1, // Fast: сырые дампы, не Ultra
          });
          this.progress.stopBusy();
          manifestContainer = container;
          this.currentArchivePath = archivePath;
          archiveSize = await invoke<number>("get_path_info", { path: archivePath }).then(
            (i: any) => i.size,
          );
          this.log(`Archive created: ${this.formatSize(archiveSize)}`, "info");
        }
      }

      // 16 MB VirtualPart — быстрее HTTP round-trips
      // Для 1.88GB → 120 итераций, каждая быстрее 64MB
      const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB VirtualPart
      const estimatedParts = Math.ceil(archiveSize / CHUNK_SIZE);

      // 3. Инициализация upload-сессии на сервере
      this.log("🚀 Initializing on the server...", "info");
      this.progress.update(10, t("upload.preparing"));

      const uploadInit = await api.uploadInit({
        user_tg_id: tgId,
        brand,
        model,
        version,
        description,
        // Content kind (SPEC docs/SPEC_CONTENT_KINDS_UPLOAD.md)
        content_kind: contentKind,
        title: title || undefined,
        doc_type: docType || undefined,
        // Upload form v2 fields
        category: fieldValues["category"] || undefined,
        chassis: fieldValues["chassis"] || undefined,
        chipset: fieldValues["chipset"] || undefined,
        memory_type: fieldValues["memory_type"] || undefined,
        programmer: fieldValues["programmer"] || undefined,
        firmware_type: fieldValues["firmware_type"] || undefined,
        source_status: fieldValues["source_status"] || undefined,
        panel_model: fieldValues["panel_model"] || undefined,
        // SP-31 (D-165): тип железа original | china_clone (дефолт сервера — original).
        hardware_type: fieldValues["hardware_type"] || undefined,
        total_parts: estimatedParts,
        total_size: archiveSize,
        mode: isPersonalScope() ? "personal" : "public",
        manifest_json: JSON.stringify({
          schema_version: 1,
          // Умный Single Upload + V3/Фаза 3 (честная типизация):
          //  - папка / одиночный файл, упакованный НАМИ (или готовый наш архив)
          //    → firmware_bundle: download распакует тем же контейнером (`container`);
          //  - одиночный чужой архив (.7z/.rar/…) → firmware_file: отдаём
          //    валидным файлом как есть, распаковка — архиватором получателя;
          //  - сырой single (как есть или ужатый) → firmware_file.
          // ⚠️ Признак бандла — КОНТЕЙНЕР, а не `singleSource`: после упаковки
          // singleSource остаётся "file", и `type="firmware_file"` заставлял
          // сервер писать byte_sha256 внутреннего файла → гарантированный
          // «SHA-256 не совпал» на скачивании архива
          // (BUG-CABINET-VAULT-SHA-MISMATCH-001, 2026-11-11).
          type:
            this.isDirectory || manifestContainer !== null
              ? "firmware_bundle"
              : "firmware_file",
          // Фаза 3: контейнер архива (`zip` | `tar_zst`) — download берёт его
          // приоритетнее magic/имени, а сервер хранит в properties. Для
          // firmware_file (сырьё/чужой архив) поля нет — распаковки не будет.
          container: manifestContainer ?? undefined,
          original_name: this.selectedPath.split(/[/\\]/).pop(),
          source_kind: this.isDirectory ? "directory" : "file",
          single_source: singleSource,
          files: scanResult.files,
          bundle_sha256: scanResult.bundle_sha256,
        }),
      });

      // ═══ ПРЕ-ДЕДУП (BUG-PRE-DEDUP-001): сервер нашёл такой же файл в каталоге
      // ДО загрузки байтов (bundle_sha256 передан в manifest_json этого же init).
      // upload_id при этом ОТСУТСТВУЕТ (job не создавался) — клиент НЕ качает
      // файл, показывает message и завершает загрузку без передачи байтов.
      if ((uploadInit as any)?.duplicate) {
        const dupMsg = (uploadInit as any)?.message
          || t("upload.msg.already_in_catalog", { file: (uploadInit as any)?.file_id });
        this.log(`Duplicate: ${dupMsg}`, "warn");
        this._phase("uploadInit → duplicate (no byte transfer needed)");
        this.progress.setDone();
        // Очищаем temp-архив (создан до init) — см. finally tryRemoveArchive.
        try { await this.tryRemoveArchive(); } catch { /* best-effort */ }
        return;
      }

      this._phase("uploadInit (HTTP → server) done");
      this.log(`Upload ID: ${uploadInit.upload_id}`, "info");

      // Сервер мог ответить уже после Cancel — тогда /complete и начисление
      // баллов по этой операции недопустимы.
      this._throwIfStale(epoch);

      // ── Серверный upload_id (DesktopUploadJob) — ОТЛИЧАЕТСЯ от Rust TDLib id.
      // Нужен для cancel/status API (ownership через Bearer-токен).
      this.serverUploadId = uploadInit.upload_id;

      // ═══ Host-PM staging (вариант 1, 2026-09-17) ═══
      // Сервер вернул host_chat_id → цель загрузки — скрытый PM user↔Host
      // (Host-АККАУНТ, а не бот). Bot-API chat_id здесь неприменим: у клиента
      // в TDLib другой id, поэтому резолвим chat_id ЛС через
      // `tdlib_resolve_private_chat` (createPrivateChat без нормализации
      // user_id — `-100<id>` сломал бы адресацию ЛС, BUG-PM-DELETE-001).
      // host_chat_id отсутствует (флаг OFF) → legacy pm_chat_id (PM с ботом).
      let hostPmChatId: string | undefined;
      const hostChatId = uploadInit.host_chat_id || 0;
      if (hostChatId) {
        const resolved = await invoke<{ chat_id: number; user_id: number }>(
          "tdlib_resolve_private_chat",
          {
            userId: hostChatId,
            username: uploadInit.host_username || undefined,
          },
        );
        if (!resolved?.chat_id) {
          throw new Error(t("upload.msg.chat_not_configured"));
        }
        hostPmChatId = String(resolved.chat_id);
        this.log(
          `🏠 Host-PM target resolved: chat_id=${resolved.chat_id} (variant 1)`,
          "info",
        );
      }

      // ════════════════════════════════════════════════════════════════
      // Единственный путь: Shared TDLib Runtime (UploadManager)
      // ════════════════════════════════════════════════════════════════
      let completePayload: Record<string, any>;
      // Host-Mediation (ADR): координаты своих PM-сообщений для self-delete после vaulted.
      let hostCleanupPm: { chat: number; messageIds: number[] } | null = null;

      {
        // BUG-AUTH-014: Live-check вынесен наверх (ранний guard до тяжёлых
        // операций). Здесь _tdlibRuntimeReady уже гарантированно true.

        // TDLib shared runtime требует только chat_id (storage chat).
        // api_id / api_hash не нужны — сессия пользователя уже авторизована.

        // ═══ Guard: target-чат для upload (Vault ИЛИ PM с ботом/Host, Host-Mediation) ═══
        // Host-PM (вариант 1): uploadInit.host_chat_id → резолвнутый PM user↔Host
        // (hostPmChatId) — приоритетнее legacy pm_chat_id (PM с ботом).
        // legacy: storage_chat_id → в storage-чат. Vault юзеру не раскрываем.
        const pmChatId = hostPmChatId || uploadInit.pm_chat_id || undefined;
        const storageChatId = uploadInit.storage_chat_id || undefined;
        const targetChatId = pmChatId || storageChatId;
        if (!targetChatId) {
          throw new Error(t("upload.msg.chat_not_configured"));
        }

        // Phase 3 (гигиена PM): один раз за установку делаем чат с ботом
        // «тихим» — mute + archive. Сервер это сделать не может (настройки
        // клиента юзера), а наш TDLib — может. Best-effort, не блокирует upload.
        this._ensureBotChatQuiet(pmChatId);
        // Phase 4 (BUG-CANCEL-FINAL-001: без 24ч-гейта): на КАЖДОЙ операции
        // дочищаем СТАРЫЙ (>48ч) мусор в своей PM — сервер отдаёт координаты,
        // удаляем свои сообщения (revoke). Best-effort, не блокирует upload.
        this._sweepOldPmDocs();

        this.log("📋 Upload strategy: tdlib-shared-runtime (UploadManager)", "info");

        // Для файлів ≤2GB використовуємо single upload,
        // для >2GB — multi-part розбивку.
        const MAX_SINGLE_SIZE = 2 * 1024 * 1024 * 1024 - 1; // 2GB - 1

        if (archiveSize <= MAX_SINGLE_SIZE) {
          // ── Single upload via shared TDLib runtime (≤2GB) ──
          const uploadResult = await this._uploadViaSharedRuntime({
            archivePath: archivePath!,
            storageChatId: storageChatId || "",
            pmChatId,
            archiveSize,
            messageThreadId: uploadInit.message_thread_id,
            serverUploadId: this.serverUploadId || undefined,
            epoch,
          });

          // Host-Mediation: запоминаем своё PM-сообщение для self-delete после vaulted.
          if (pmChatId && uploadResult.message_id) {
            hostCleanupPm = { chat: parseInt(pmChatId, 10), messageIds: [uploadResult.message_id] };
          }
          // Cancel/сбой в любой момент: храним координаты своих PM-сообщений.
          if (hostCleanupPm) {
            this.pmChatIdSelf = hostCleanupPm.chat;
            this.pmMessageIds = hostCleanupPm.messageIds.slice();
          }

          completePayload = {
            upload_route: "tdlib_shared_runtime",
            document_meta: {
              tg_document_id: "",
              tg_file_id: uploadResult.tg_file_id,
              tg_file_unique_id: uploadResult.tg_file_unique_id,
              tg_file_reference: "",
              access_hash: "",
              dc_id: 0,
              size: archiveSize,
              brand,
              model,
              version,
              chat_id: parseInt(targetChatId || "0", 10),
              parts: [{
                index: 0,
                tg_file_id: uploadResult.tg_file_id,
                tg_file_unique_id: uploadResult.tg_file_unique_id,
                telegram_message_id: uploadResult.message_id,
                size: archiveSize,
              }],
            },
            original_name: this.selectedPath.split(/[/\\]/).pop(),
          };
        } else {
          // ── Multi-part upload via shared TDLib runtime (>2GB) ──
          // 1.95GB — безопасный лимит для slice-парсера (int32_t в TDLib, MAX=2147483647).
          // 2GB (2147483648) на 1 байт превышает INT32_MAX, вызывая integer overflow
          // в FileFd::open() патченного TDLib → зависание на 0%.
          // Рабочее значение из коммита a46daf7 до чистки.
          const TDLIB_SAFE_PART_BYTES = Math.floor(1.95 * 1024 * 1024 * 1024); // ~1.95GB
          const multiUploadResult = await this._uploadViaSharedRuntimeMulti({
            archivePath: archivePath!,
            storageChatId: storageChatId || "",
            pmChatId,
            archiveSize,
            messageThreadId: uploadInit.message_thread_id,
            maxPartSize: Math.min(
                uploadInit.part_max_bytes || (2 * 1024 * 1024 * 1024 - 1),
                TDLIB_SAFE_PART_BYTES,
            ),
            serverUploadId: this.serverUploadId || undefined,
            epoch,
          });

          // Host-Mediation: self-delete всех PM-частей после vaulted.
          // BUG-AUTO-CLEAN-001: Rust tdlib_start_multi_upload возвращает часть
          // как SinglePartResult {message_id, size, part_index, ...}, а НЕ
          // {telegram_message_id, part_size}. Читаем message_id (fallback),
          // иначе список PM-сообщений пуст → self-delete не вызывается.
          if (pmChatId) {
            const pmMsgIds = multiUploadResult.parts
              .map(p => ((p as any).telegram_message_id ?? (p as any).message_id) as number | undefined)
              .filter((id): id is number => !!id);
            if (pmMsgIds.length) {
              hostCleanupPm = { chat: parseInt(pmChatId, 10), messageIds: pmMsgIds };
            } else {
              this.log(
                "⚠️ Host multi: failed to collect part message_ids for self-delete",
                "warn",
              );
            }
          }
          // Cancel/сбой в любой момент: храним координаты своих PM-сообщений.
          if (hostCleanupPm) {
            this.pmChatIdSelf = hostCleanupPm.chat;
            this.pmMessageIds = hostCleanupPm.messageIds.slice();
          }

          completePayload = {
            upload_route: "tdlib_shared_runtime",
            document_meta: {
              tg_document_id: "",
              tg_file_id: multiUploadResult.parts[0]?.tg_file_id || "",
              tg_file_unique_id: multiUploadResult.parts[0]?.tg_file_unique_id || "",
              tg_file_reference: "",
              access_hash: "",
              dc_id: 0,
              size: archiveSize,
              brand,
              model,
              version,
              chat_id: parseInt(targetChatId || "0", 10),
              parts: multiUploadResult.parts.map(p => ({
                index: p.part_index,
                tg_file_id: p.tg_file_id,
                tg_file_unique_id: p.tg_file_unique_id,
                telegram_message_id: (p as any).telegram_message_id ?? (p as any).message_id,
                size: (p as any).part_size ?? (p as any).size ?? 0,
                file_offset: p.file_offset,
              })),
            },
            original_name: this.selectedPath.split(/[/\\]/).pop(),
          };
        }
      }

      this.log(
        `📡 Complete → /desktop/uploads/${uploadInit.upload_id}/complete`
        + ` (${completePayload.document_meta.parts.length} parts)`,
        "info",
      );

      // ════════════════════════════════════════════════════════════════
      // Шаг 5: Завершение — финализация сессии на сервере
      // ════════════════════════════════════════════════════════════════
      this.progress.update(95, t("upload.finalizing"));
      this.progress.setMessage(t("upload.finalizing"));

      // ─── Non-blocking /complete с polling ───
      //   POST /complete → либо 200 (Direct MTProto, fast),
      //   либо 202 Accepted (Redis Queue path) → polling GET /complete-status.
      const COMPLETE_POLL_INTERVAL = 2_000; // ms
      const COMPLETE_TIMEOUT = 5_400_000;   // ms (90 минут для 5GB)
      let completeResult: Awaited<ReturnType<typeof api.uploadComplete>> | null = null;

      // Transfer завершён — дальнейшие ошибки /complete НЕ resumable (skip неприменим).
      this._afterTransfer = true;

      const completeResponse = await api.uploadComplete(uploadInit.upload_id, completePayload);

      // Шаг 2: определяем, нужен ли polling
      // 200 → Direct MTProto — ответ готов (status: "completed")
      // 202 Accepted → Redis Queue path — polling (status: "accepted")
      if (completeResponse.status === "accepted") {
        // Redis Queue path — polling
        this.log(
          `ℹ️ /complete returned 202 Accepted — starting polling `
          + `/desktop/uploads/${uploadInit.upload_id}/complete-status`,
          "info",
        );

        const pollStartTime = Date.now();
        let pollResult: any = null;
        // BUG-UPLOAD-COMPLETE-TIMEOUT: терминальный "failed" от сервера не ретраим —
        // иначе клиент молотит /complete-status до 90-минутного таймаута.
        let hardFailError: string | null = null;

        while (true) {
          // Проверка отмены пользователем / устаревшего поколения
          this._throwIfStale(epoch);
          if (this.cancelled) {
            throw new Error("Upload cancelled by user");
          }

          // Проверка таймаута
          if (Date.now() - pollStartTime > COMPLETE_TIMEOUT) {
            throw new Error(
              `Complete polling timeout (${COMPLETE_TIMEOUT / 1000}s). `
              + `Upload may still be in progress on server.`,
            );
          }

          try {
            pollResult = await api.uploadCompleteStatus(uploadInit.upload_id);

            const pollState = pollResult?.status || "unknown";

            if (pollState === "completed") {
              // 200 — готово
              this.log(`✅ Complete polling: status completed`, "success");
              completeResult = pollResult;
              break;
            } else if (pollState === "failed") {
              // 500 — терминальная ошибка
              hardFailError = pollResult?.error || "Unknown error";
              throw new Error(`Complete failed: ${hardFailError}`);
            } else {
              // 202 — ещё выполняется (pending/processing/accepted)
              const progressPct = pollResult?.progress_pct || 0;
              this.progress.update(
                95 + Math.floor(progressPct * 0.04), // 95–99% шкала для polling
                t("upload.finalizing_pct", { pct: progressPct }),
              );
              this.progress.setMessage(
                t("upload.waiting_finish", { n: Math.floor((Date.now() - pollStartTime) / 1000) }),
              );
            }
          } catch (err: any) {
            // Терминальный провал (status:"failed" от сервера) — НЕ ретраим,
            // показываем ошибку пользователю сразу.
            if (hardFailError !== null) {
              throw err;
            }
            // Ошибка сети/HTTP — ретраим
            const errMsg = err?.message || String(err);
            this.log(
              `⚠️ Complete-poll error: ${errMsg} → retry in ${COMPLETE_POLL_INTERVAL}ms`,
              "warn",
            );
            // Не выходим — продолжаем polling после паузы
          }

          // Ждём перед следующим poll
          await new Promise(resolve =>
            setTimeout(resolve, COMPLETE_POLL_INTERVAL),
          );
        }
      } else {
        // Direct MTProto path — ответ уже готов (200)
        completeResult = completeResponse;
      }

      // Лог результата (с защитой от undefined received_parts/total_parts для direct MTProto)
      this.log(
        `✅ Done! Status: ${completeResult!.status}`
        + (completeResult!.received_parts !== undefined
            ? ` (parts: ${completeResult!.received_parts}/${completeResult!.total_parts})`
            : ` (file_id: ${(completeResult as any).file_id || "unknown"})`),
        "success",
      );
      this.progress.setDone();

      // ═══════════════════════════════════════════════════════════════════════
      // Host-Mediation (ADR): после vaulted сервер перенёс файл в Vault — клиент
      // удаляет СВОЁ upload-сообщение в PM (self-delete), ЛС остаётся пустым.
      // ═══════════════════════════════════════════════════════════════════════
      const completedVaulted = (completeResult as any)?.vaulted === true;
      if (hostCleanupPm && completedVaulted) {
        try {
          this.log("🗑 Deleting the upload message from PM (self-delete)...", "info");
          await invoke("tdlib_delete_messages", {
            chatId: hostCleanupPm.chat,
            messageIds: hostCleanupPm.messageIds,
          });
          this.log("🗑 PM cleaned (upload message deleted)", "success");
        } catch (cleanErr: any) {
          this.log(
            "⚠️ PM self-delete failed: " + (cleanErr?.message || String(cleanErr)),
            "warn",
          );
        }
      }

      // ╔══════════════════════════════════════════════════════════════════════╗
      // ║  Integration Bridge: Worker API credit-points                       ║
      // ║  Начисляем бонусные баллы аплоадеру после успешной загрузки.        ║
      // ╚══════════════════════════════════════════════════════════════════════╝
      const creditFileId = (completeResult as any).file_id as number | undefined;
      if (creditFileId) {
        // Баллы начисляем только если операция не была отменена во время /complete.
        this._throwIfStale(epoch);
        try {
          this.log("📦 Crediting points for the upload...", "info");
          const creditResult = await api.creditPoints(creditFileId);
          if (creditResult.credited !== undefined) {
            this.log(`💰 +${creditResult.credited} points for the upload!`, "success");
          } else if (creditResult.success !== false) {
            this.log("💰 Points credited", "success");
          }
          // Обновляем баланс в UI после начисления баллов
          this._refreshBalanceDisplay();
        } catch (creditErr: any) {
          // Не фатально — upload уже завершён, баллы можно доначислить позже
          const crMsg = creditErr?.message || String(creditErr);
          this.log(
            `⚠️ Failed to credit points: ${crMsg.substring(0, 200)} (can be credited manually)`,
            "warn",
          );
        }
      } else {
        this.log("⚠️ No file_id in the response — points not credited", "warn");
      }

      // Пользователь остаётся на вкладке Upload после завершения
      this.log(`✅ Upload finished: ${brand} ${model}`.trim(), "success");
      // Локализованный success-строчник ВЕРХНИМ РЕГИСТРОМ (запрос владельца).
      this.log(t("upload.msg.upload_success").toUpperCase(), "success");

      // ── BUG-CABINET-STALE-001: личный кабинет узнаёт о новой карточке ──
      // Список кабинета — это один GET к поисковому индексу, он живёт в DOM;
      // без этого сигнала свежий файл был виден только после перезапуска
      // клиента. Пользователя НЕ уводим с вкладки (решение владельца): App
      // помечает список устаревшим и перечитывает его при открытии «Пошуку» —
      // или сразу, если кабинет открыт в этот момент.
      this.onUploadComplete(brand, model);

      // ── Медиа карточки (SP-15 v3, D-069): «отдельный инструмент в описании файла».
      // Карточка уже существует (host-mediation создал File/Vault-запись на /complete),
      // поэтому фото можно цеплять сразу ЗДЕСЬ, без похода в «Поиск»/«Личные файлы».
      this._showCardMedia(completeResult);
    } catch (e: any) {
      // Всегда дублируем в console.error для DevTools (F12)
      console.error("UploadPage.startUpload() error:", e);

      if (this.cancelled
        || !this._isCurrent(epoch)
        || e?.message === "Upload cancelled by user"
        || e?.message === "Upload cancelled") {
        this.progress.setCancelled();
      } else {
        // Сериализуем ошибку со всех сторон — без DevTools
        let errDetail: string;
        try {
          if (typeof e === "string") {
            errDetail = e;
          } else if (e?.message) {
            errDetail = e.message;
          } else {
            // Пробуем забрать error из Tauri IPC-объекта {error: "..."}
            errDetail = e?.error || JSON.stringify(e);
          }
        } catch {
          errDetail = String(e);
        }

        // ═══ Специфична помилка: бот не є адміністратором у storage чаті ═══
        // Ця помилка виникає, коли TDLib JSON FFI (бот) намагається надіслати
        // документ у супергрупу/канал, де бот не є адміністратором.
        // Рішення: додати бота як адміністратора або перемкнутися на MTProto Direct.
        const errLower = errDetail.toLowerCase();
        if (
          errLower.includes("botnotadmin")
          || errLower.includes("не є адміністратором")
          || errLower.includes("not enough rights")
          || (errLower.includes("адміністратор") && errLower.includes("бот"))
        ) {
          const botAdminMsg = [
            t("upload.msg.bot_not_admin_title"),
            "",
            t("upload.msg.bot_not_admin_what_to_do"),
            t("upload.msg.bot_not_admin_step1"),
            t("upload.msg.bot_not_admin_step2"),
            t("upload.msg.bot_not_admin_step3"),
            "",
            t("upload.msg.bot_not_admin_details", { err: errDetail.substring(0, 300) }),
          ].join("\n");
          this.log(botAdminMsg, "error");
          this.progress.setError(t("upload.msg.bot_not_admin_hint"));
        } else {
          // Обрезаем слишком длинные сообщения (сервер может вернуть HTML)
          const maxLen = 500;
          const displayErr = errDetail.length > maxLen
            ? errDetail.substring(0, maxLen) + "..."
            : errDetail;
          this.log(`❌ ${displayErr}`, "error");
          this.progress.setError(t("upload.msg.error_prefix", { err: displayErr }));
        }
      }

    } finally {
      // Сброс состояния/UI — ТОЛЬКО если эта цепочка всё ещё владеет операцией.
      // Устаревшая (отменённая) цепочка не должна обнулять serverUploadId и
      // переключать кнопки НОВОЙ загрузки, иначе новая операция «теряла» job.
      const ownsUi = this._activeEpoch === epoch;
      if (ownsUi) {
        this._activeEpoch = null;
        // П.3: если фаза (scan/pack) оборвалась ошибкой/отменой — busy-пульс
        // обязан погаснуть (stopBusy идемпотентен, при успехе уже остановлен).
        this.progress.stopBusy();
        // beforeunload guard — снимаем блокировку
        this.uploadActive = false;
        this._syncClearFieldsBtn();

        this.currentUploadId = null;
        this.serverUploadId = null;
        this.pmChatIdSelf = null;
        this.pmMessageIds = [];

        // 🧹 BUG-DESKTOP-UI-003: удаляем temp-архив после upload (успех/ошибка/отмена).
        // Best-effort — не должен ломать завершение upload'а.
        try {
          await this.tryRemoveArchive();
        } catch (e) {
          console.warn("tryRemoveArchive in finally failed:", e);
        }

        // 🧹 BUG-CANCEL-FINAL-001: дворник после КАЖДОЙ операции (порог 0 —
        // движок остановлен): свежий temp-архив, слайсы `{pid}_{i}.part`
        // (multi-upload), остатки неудачного tryRemoveArchive.
        try {
          await this.cleanupStaleArchives("op-end");
        } catch (e) {
          console.warn("cleanupStaleArchives in finally failed:", e);
        }

        this.startUploadBtn.disabled = false;
        this.selectFileBtn.disabled = false;
        this.selectFolderBtn.disabled = false;
        this.cancelUploadBtn.style.display = "none";
        this.cancelUploadBtn.disabled = true;
        this.abortController = null;
      }
    }
  }

  /**
   * Проверить доступность TDLib shared runtime.
   * Зелёный/красный индикатор в TDLib status block.
   */
  private async _checkTdlibRuntimeStatus(): Promise<void> {
    this.tdlibJsonDot.style.background = "var(--text-dim)";
    this.tdlibJsonStatusText.textContent = t("upload.tdlib_checking");
    this.tdlibJsonUnavailableWarning.style.display = "none";
    try {
      const status = await invoke<{ ready: boolean; download_manager: boolean }>("tdlib_runtime_status");
      const healthy = status.ready;
      if (healthy) {
        this.tdlibJsonDot.style.background = "var(--success)";
        this.tdlibJsonStatusText.textContent = t("upload.tdlib_ready");
        this.tdlibJsonUnavailableWarning.style.display = "none";
        this._tdlibRuntimeReady = true;
      } else {
        this.tdlibJsonDot.style.background = "var(--error)";
        this.tdlibJsonStatusText.textContent = t("upload.tdlib_unavailable");
        this.tdlibJsonUnavailableWarning.style.display = "block";
        this._tdlibRuntimeReady = false;
      }
    } catch (e) {
      this.tdlibJsonDot.style.background = "var(--error)";
      this.tdlibJsonStatusText.textContent = t("upload.tdlib_check_error", { err: String(e) });
      this.tdlibJsonUnavailableWarning.style.display = "block";
      this._tdlibRuntimeReady = false;
    }
  }



  /**
   * Shared TDLib Runtime стратегия — загрузка через UploadManager (≤2GB).
   *
   * Вызывает `tdlib_start_upload` → получает upload_id,
   * слушает `tdlib-upload-progress` для прогресса,
   * затем `tdlib_wait_upload` для блокирующего ожидания результата.
   */
  private async _uploadViaSharedRuntime(params: {
    archivePath: string;
    storageChatId: string;
    archiveSize: number;
    messageThreadId?: number;
    pmChatId?: string;
    /** Серверный upload_id для caption документа (BUG-UPLOAD-013): host_ingest
     * маршрутизирует строго по нему, без fallback на «последний открытый job». */
    serverUploadId?: string;
    /** Поколение операции: события отменённой передачи игнорируются. */
    epoch?: number;
  }): Promise<TdlibJsonUploadResult> {
    const { archivePath, storageChatId, archiveSize, messageThreadId, pmChatId } = params;
    const opEpoch = params.epoch ?? this._epoch;
    const sessionUploadId = params.serverUploadId ?? this.serverUploadId ?? null;
    // Host-Mediation: target = PM с ботом (id бота), иначе legacy storage-чат.
    const chatId = parseInt((pmChatId || storageChatId || "0"), 10);
    if (!chatId) throw new Error("Target chat ID is not configured");
    const isPm = !!pmChatId;

    // Bot token / api_hash не нужны — сессия пользователя уже авторизована в shared runtime.

    this.log("🚀 Shared TDLib Runtime upload → UploadManager", "info");
    this.progress.update(15, "TDLib Shared Upload");
    this.uploadStartTime = performance.now();

    // ─── Start upload через shared runtime ──────────────────────────
    this._phase("→ calling tdlib_start_upload (preliminaryUploadFile)");
    const uploadId = await invoke<string>("tdlib_start_upload", {
      filePath: archivePath,
      chatId,
      messageThreadId: messageThreadId || null,
      pm: isPm,
      sessionUploadId,
    });

    this._phase("tdlib_start_upload returned upload_id (preliminaryUploadFile sent)");
    // Сохраняем uploadId для кнопки «Отмена»
    this.currentUploadId = uploadId;

    this.log(`📤 Upload ID: ${uploadId}`, "info");

    // ─── Progress binding: tdlib-upload-progress ──────────────────────
    let unlistenShared: UnlistenFn | null = null;
    let sharedCompleted = false;
    try {
      unlistenShared = await listen<SharedRuntimeUploadProgress>("tdlib-upload-progress", (event) => {
        try {
          // Игнорируем события отменённой/устаревшей передачи: иначе после Cancel
          // они продолжали рисовать прогресс в уже новую операцию.
          if (this.cancelled || !this._isCurrent(opEpoch)) return;

          const { bytes_uploaded, total, percent } = event.payload;

          // Диагностика паузы: фиксируем момент первой реальной передачи байт
          if (!this._firstBytesLogged && bytes_uploaded > 0) {
            this._firstBytesLogged = true;
            this._phase(`first real byte transfer (${this.formatSize(bytes_uploaded)}/${this.formatSize(total)})`);
          }

          if (percent >= 100) {
            if (!sharedCompleted) {
              sharedCompleted = true;
              this.progress.setDone();
              this.log(
                `✅ Shared TDLib: upload finished (${this.formatSize(total)})`,
                "success",
              );
            }
          } else {
            // Фазовый диапазон 15..90 (preparing/finalizing — вне диапазона);
            // ETA/скорость рендерит ProgressUI из TransferMeter по сырым байтам.
            this.progress.report(bytes_uploaded, total, { displayRange: [15, 90] });

            this.log(
              `📤 Shared TDLib: ${this.formatSize(bytes_uploaded)}/${this.formatSize(total)} (${percent}%)`,
              "info",
            );
          }
        } catch (innerErr) {
          console.error("tdlib-upload-progress error:", innerErr);
        }
      });
    } catch {
      this.log("⚠️ Failed to subscribe to tdlib-upload-progress", "warn");
    }

    try {
      // ─── Блокирующее ожидание завершения ──────────────────────────
      const result = await invoke<TdlibJsonUploadResult>("tdlib_wait_upload", {
        uploadId,
      });

      this.log(
        `✅ Shared TDLib: file_id=${result.tg_file_id.substring(0, 20)}... message_id=${result.message_id}`,
        "success",
      );

      return result;
    } finally {
      if (unlistenShared) {
        try { unlistenShared(); } catch { /* ignore */ }
      }
      // Не очищаем currentUploadId здесь — это делает cancelUpload() или startUpload() finally
    }
  }

  /**
   * Shared TDLib Runtime multi-part стратегия — загрузка через UploadManager (>2GB).
   *
   * Вызывает `tdlib_start_multi_upload`, которая разбивает файл на части
   * и загружает каждую последовательно через shared TDLib runtime.
   * Прогресс приходит через Tauri event `tdlib-multi-upload-progress`.
   */
  private async _uploadViaSharedRuntimeMulti(params: {
    archivePath: string;
    storageChatId: string;
    archiveSize: number;
    messageThreadId?: number;
    pmChatId?: string;
    maxPartSize: number;
    skipOffsets?: number[];
    /** Серверный upload_id для caption каждой части (BUG-UPLOAD-013). */
    serverUploadId?: string;
    /** Поколение операции: события отменённой передачи игнорируются. */
    epoch?: number;
  }): Promise<TdlibUploadMultiResult> {
    const { archivePath, storageChatId, archiveSize, messageThreadId, pmChatId, maxPartSize, skipOffsets } = params;
    const opEpoch = params.epoch ?? this._epoch;
    const sessionUploadId = params.serverUploadId ?? this.serverUploadId ?? null;
    // Host-Mediation: target = PM с ботом (id бота), иначе legacy storage-чат.
    const chatId = parseInt((pmChatId || storageChatId || "0"), 10);
    if (!chatId) throw new Error("Target chat ID is not configured");
    const isPm = !!pmChatId;

    // Bot token / api_hash не нужны — сессия пользователя уже авторизована в shared runtime.

    this.log("🚀 Shared TDLib Runtime multi upload → UploadManager (>2GB)", "info");
    this.progress.update(15, "TDLib Shared Multi Upload");
    this.uploadStartTime = performance.now();

    // ─── Progress binding: tdlib-multi-upload-progress ─────────────────
    let unlistenShared: UnlistenFn | null = null;
    let unlistenPartDone: UnlistenFn | null = null;
    let sharedCompleted = false;
    try {
      unlistenShared = await listen<SharedRuntimeMultiUploadProgress>("tdlib-multi-upload-progress", (event) => {
        try {
          // Игнорируем события отменённой/устаревшей передачи (паритет с single).
          if (this.cancelled || !this._isCurrent(opEpoch)) return;

          const {
            total_uploaded, total_size, percent,
            current_part, total_parts,
            current_part_bytes_read, current_part_total_bytes,
          } = event.payload;

          // Плавный процент: учитываем per-part granular progress
          // Вычисляем сколько байт было загружено до начала этой части
          const completed_before = total_uploaded - current_part_bytes_read;
          const smooth_percent = total_size > 0
            ? Math.min(100, ((completed_before + current_part_bytes_read) / total_size) * 100)
            : 0;

          if (smooth_percent >= 100 || percent >= 100) {
            if (!sharedCompleted) {
              sharedCompleted = true;
              this.progress.setDone();
              this.log(
                `✅ Shared TDLib multi: upload finished (${this.formatSize(total_size)}, ${total_parts} parts)`,
                "success",
              );
            }
          } else {
            // Плавный прогресс по фактическим байтам; фазовый диапазон 15..90;
            // ETA/скорость — из TransferMeter (межчастевые cooldown'ы входят в окно).
            const smooth_uploaded = completed_before + current_part_bytes_read;
            this.progress.report(smooth_uploaded, total_size, { displayRange: [15, 90] });

            this.log(
              `📤 Shared TDLib multi: ${this.formatSize(smooth_uploaded)}/${this.formatSize(total_size)} (${Math.round(smooth_percent)}%) [part ${current_part}/${total_parts} · ${this.formatSize(current_part_bytes_read)}/${this.formatSize(current_part_total_bytes)}]`,
              "info",
            );
          }
        } catch (innerErr) {
          console.error("tdlib-multi-upload-progress error:", innerErr);
        }
      });
    } catch {
      this.log("⚠️ Failed to subscribe to tdlib-multi-upload-progress", "warn");
    }

    // ─── Per-part done binding: копим PM message_id в реальном времени ──
    // Нужно для self-delete своих PM-сообщений при cancel/сбое на середине multi.
    try {
      unlistenPartDone = await listen<MultiUploadPartDoneEvent>("tdlib-multi-upload-part-done", (event) => {
        try {
          if (this.cancelled) return;
          const { message_id } = event.payload;
          if (!isPm || !message_id) return;
          if (!this.pmChatIdSelf) this.pmChatIdSelf = chatId;
          if (this.pmChatIdSelf === chatId && !this.pmMessageIds.includes(message_id)) {
            this.pmMessageIds.push(message_id);
          }
        } catch (innerErr) {
          console.error("tdlib-multi-upload-part-done error:", innerErr);
        }
      });
    } catch {
      // Не фатально — накопление message_id остаётся после завершения (fallback).
    }

    try {
      // ─── Запуск multi-part upload (блокирующий) ────────────────────
      const result = await invoke<TdlibUploadMultiResult>("tdlib_start_multi_upload", {
        filePath: archivePath,
        chatId,
        maxPartSize,
        messageThreadId: messageThreadId || null,
        pm: isPm,
        skipOffsets: skipOffsets || [],
        sessionUploadId,
      });

      this.log(
        `✅ Shared TDLib multi: ${result.parts.length} parts, ${this.formatSize(result.total_size)}`,
        "success",
      );

      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Если отмена пользователем — не показываем alert и не кричим "error"
      if (this.cancelled || errMsg.includes("Upload cancelled")) {
        this.log("⛔ Multi upload cancelled", "warn");
        this.progress.setCancelled();
        throw err;
      }

      const display = `❌ Shared TDLib multi upload failed: ${errMsg}`;
      console.error("Shared TDLib multi upload error:", err);
      this.log(display, "error");
      this.progress.setError(display);
      alert(display);
      throw err;
    } finally {
      if (unlistenShared) {
        try { unlistenShared(); } catch { /* ignore */ }
      }
      if (unlistenPartDone) {
        try { unlistenPartDone(); } catch { /* ignore */ }
      }
      this.currentUploadId = null;
    }
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + units[i];
  }
}
