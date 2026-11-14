import { parseFileId } from "../search/FileId";
import { FileReviews } from "./FileReviews";
/**
 * SearchPage — поиск файлов прошивок по всем полям.
 *
 * Отображает результаты в виде карточек со всеми заполненными полями
 * upload-формы (category, chassis, chipset, memory_type, programmer,
 * firmware_type, source_status, panel_model и др.).
 * Клик по кнопке "Скачать" переключает на вкладку Download.
 *
 * v2 — Единая авторизация: проверка через requireAuth() из централизованного auth.ts.
 * Авторизация происходит ОДИН раз при входе в клиент и работает для всех модулей.
 */

import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type {
  CatalogSearchResponse,
  CatalogTreeResponse,
  FacetDistribution,
  SearchResultItem,
  VaultFileItem,
} from "../api";
import { requireAuth } from "../auth";
import { getCurrentTgId } from "../auth";
import { uploaderDisplayName, uploaderLabelKey } from "../search/UploaderLabel";
import { isPersonalScope, subscribeVault } from "../vaultMode";
import { shouldRefreshCabinet } from "./CabinetRefresh";
import {
  bindMediaGallery,
  renderMediaGalleryHtml,
  resolveCardMedia,
  type ResolvedMedia,
} from "./MediaGallery";
import { openMediaLightbox } from "./MediaLightbox";
import {
  fullSizeResolver,
  loadProtectedThumbs,
  revokeObjectUrls,
} from "./MediaAuth";
import { mediaBytesForUi } from "./MediaFetchWiring";
import { CardMediaUploader } from "./CardMediaUploader";
import { t, tLoose, hasKey } from "../i18n";
import {
  buildFilter,
  clearAll,
  clearField,
  countActive,
  facetGroups,
  toggleValue,
  type FacetSelection,
} from "../search/FacetQuery";
import { facetOptionLabel } from "../search/facetLabels";
import { MIN_SEARCH_CHARS, decideSearch } from "../search/SearchPolicy";
import { SummaryBlock } from "./SummaryBlock";
import { renderReturnChipHtml } from "./CardJump";
import { AttachmentForm, type CardAttachmentItem } from "./AttachmentForm";
import { AttachmentUploader } from "./AttachmentUploader";
import {
  directoryInitials,
  filterDirectory,
  type DirectoryEntry,
} from "./vaultShare";
import {
  brandsAt,
  isLeafClick,
  kindsAt,
  leafFilter,
  matchesLeaf,
  modelsAt,
  type CatalogTree,
  type TreeLeaf,
  type TreePath,
} from "../search/CatalogTree";
import { CardEditDialog, cardEditButtonLabel } from "./CardEditDialog";

/**
 * content_kind → i18n-ключ бейджа. Значение самого поля (данные файла)
 * НЕ переводится: локализуется только бейдж типа контента.
 */
/**
 * Классы контента без бренда/модели: название карточки = `title`
 * (SP-35/D-185: software + даташит микросхемы + произвольный файл;
 * SP-36/D-188: + ISP-подключение eMMC и фото ремонта).
 */
const TITLE_ONLY_KINDS: ReadonlySet<string> = new Set([
  "software", "datasheet", "any_file", "isp_emmc", "repair_pictures",
]);

const KIND_KEY: Record<
  string,
  | "search.kind.firmware"
  | "search.kind.documentation"
  | "search.kind.software"
  | "search.kind.datasheet"
  | "search.kind.isp_emmc"
  | "search.kind.repair_pictures"
  | "search.kind.any_file"
> = {
  firmware: "search.kind.firmware",
  documentation: "search.kind.documentation",
  software: "search.kind.software",
  // SP-35 (D-185): даташит микросхемы и произвольный файл личного хранилища.
  datasheet: "search.kind.datasheet",
  // SP-36 (D-188): ISP-подключение eMMC и фото ремонта.
  isp_emmc: "search.kind.isp_emmc",
  repair_pictures: "search.kind.repair_pictures",
  any_file: "search.kind.any_file",
};

export class SearchPage {
  // DOM refs
  private searchInput!: HTMLInputElement;
  private fileIdInput!: HTMLInputElement;
  private searchBtn!: HTMLButtonElement;
  /** Кнопка «Весь каталог» (A3): вход в дерево публичного каталога. */
  private allCatalogBtn!: HTMLButtonElement;
  /** Хлебные крошки дерева каталога (A3). */
  private crumbsEl!: HTMLElement;
  private resultsContainer!: HTMLElement;
  private searchStatus!: HTMLElement;
  private logEl!: HTMLElement;

  // i18n: семантическое состояние статуса/результатов для перерисовки при смене языка
  private _lastStatus:
    | { kind: "searching" }
    | { kind: "not_found"; query: string }
    | { kind: "found"; n: number }
    | { kind: "found_personal"; n: number }
    | { kind: "empty_personal" }
    | { kind: "min_chars" }
    | { kind: "error"; err: string }
    /** Каталог-дерево: файлов в каталоге n (browse без текста). */
    | { kind: "catalog"; n: number }
    /** Каталог-дерево: каталог пуст (approved-файлов нет). */
    | { kind: "catalog_empty" }
    | null = null;
  /** Режим последнего рендера: public-каталог, личный кабинет или дерево. */
  private _lastMode: "public" | "vault" | "tree" | null = null;
  private _lastResults: SearchResultItem[] | null = null;
  private _lastVaultResults: VaultFileItem[] | null = null;

  // ── Дерево публичного каталога (A3, «Весь каталог») ──
  /** Дерево с сервера (/api/v1/search/public/tree), null → ещё не загружено. */
  private _tree: CatalogTree | null = null;
  /** Текущий путь в дереве: [] → kinds, [kind] → brands, [kind, brand] → models. */
  private _treePath: TreePath = [];
  /** Открытая папка-лист: показываем её файлы карточками (иное — только папки). */
  private _treeLeaf: TreeLeaf | null = null;

  // ── Фасетный каталог (Phase 3, docs/SEARCH_CATALOG_ARCHITECTURE.md) ──
  private facetsEl!: HTMLElement;
  /** Выбор фасетов (мультивыбор: OR внутри поля, AND между полями). */
  private _selection: FacetSelection = {};
  /** facetDistribution последнего успешного каталог-ответа (null → панель скрыта). */
  private _lastFacets: FacetDistribution | null = null;
  /** Поколение каталог-запроса: устаревшие ответы (гонка debounce) не рендерятся. */
  private _epoch = 0;

  /**
   * id личных файлов, удалённых В ЭТОЙ СЕССИИ (BUG-PERSONAL-DELETE-001).
   * Поисковый индекс обновляется асинхронно — перечитанный список может
   * на несколько секунд вернуть «только что удалённый» файл; такие id
   * отфильтровываются при рендере, чтобы карточка не «воскресала».
   */
  private readonly _hiddenPersonalIds = new Set<number>();

  /**
   * Карточки, чья ЕДИНСТВЕННАЯ правка уже потрачена в этой сессии (D-187).
   *
   * Ключ — `${kind}:${id}`. Слот живёт на сервере, но клиент не должен звать
   * мастером кнопку, которая заведомо ответит «використано»: после успешной
   * правки (и после ответа `can_edit=false`) кнопка гаснет на месте. После
   * перезапуска состояние снова приходит с сервера при открытии формы.
   */
  private readonly _editUsedCards = new Set<string>();

  private static _editKey(kind: "file" | "personal", cardId: number): string {
    return `${kind}:${cardId}`;
  }

  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Форма «Редагувати» (D-186) — одна на страницу.
   *
   * Владелец карточки правит её текст ОДИН раз; после успеха слот потрачен,
   * поэтому выдачу перечитываем — карточка показывает новый текст, а кнопка
   * объясняет, что правка уже использована (состояние приходит с сервера).
   */
  private readonly cardEditDialog = new CardEditDialog({
    load: (kind, id) => api.cardEditState(kind, id),
    save: (kind, id, patch, revision) => api.cardEditPatch(kind, id, patch, revision),
    onToast: (message, type) => {
      const level = type === "error" ? "error" : type === "success" ? "success" : "info";
      this.onNotify?.(message, type ?? "info");
      this.log(message, level);
    },
    onSaved: () => {
      if (this._lastMode === "vault") void this.doPersonalSearch();
      else void this.doSearch();
    },
    onUsed: (kind, cardId) => this._markCardEditUsed(kind, cardId),
  });

  /**
   * Справку цієї картки витрачено: гасимо кнопку ЗАРАЗ (D-187).
   *
   * Не чекаємо перечитування видачі — «одноразова» кнопка, яка після успіху
   * виглядає робочою, змушує майстра тиснути її вдруге і отримувати відмову.
   */
  private _markCardEditUsed(kind: "file" | "personal", cardId: number): void {
    this._editUsedCards.add(SearchPage._editKey(kind, cardId));
    this.resultsContainer
      ?.querySelectorAll<HTMLButtonElement>(
        `.card-edit-btn[data-card-kind="${kind}"][data-card-id="${cardId}"]`,
      )
      .forEach((btn) => {
        btn.disabled = true;
        btn.textContent = cardEditButtonLabel(true);
      });
  }

  /** Порядок групп фасетов в панели (пустые группы не выводятся). */
  private static readonly FACET_FIELDS = [
    "kind",
    "brand",
    "device_category",
    "hardware_type", // SP-31 (D-165): Оригинал / China-clone
    "chassis",
    "chipset",
    "panel_model",
  ];

  /** Подпись группы фасетов: i18n-ключ `search.facet_{field}`, fallback — имя поля. */
  private facetLabel(field: string): string {
    const key = `search.facet_${field}`;
    return hasKey(key) ? tLoose(key) : field;
  }

  /**
   * Автоматический поиск по запросу.
   * Используется после завершения upload для отображения загруженного файла.
   */
  async autoSearch(query: string): Promise<void> {
    this.searchInput.value = query;
    // Небольшая задержка для корректного рендеринга после переключения вкладки
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.doSearch();
  }

  // Callback для переключения на download
  private onDownloadFile: (fileId: number) => void;
  /** Callback для скачивания ЛИЧНОГО файла (self-download из своего PM). */
  private onPersonalDownloadFile: ((pfId: number) => void) | null = null;
  /** Callback для toast-уведомлений (подключает App.showToast). */
  private onNotify: ((message: string, type: "success" | "error" | "info") => void) | null = null;
  /**
   * SP-19 S1b (D-087): сводка + «что ещё скачать» под карточкой (key = file_id).
   * Сводку строит фоном сервер — здесь только чтение кеша (`GET /card`).
   */
  private summaryBlocks = new Map<number, SummaryBlock>();
  private fileReviews = new Map<number, FileReviews>();
  /** Формы вложений (SP-20, D-094): ключ — `kind:id` карточки. */
  private attachmentForms = new Map<string, AttachmentForm>();
  /** D-135: хост компактной карточки, если её нет в текущей выдаче. */
  private focusHost: HTMLElement | null = null;
  private focusEpoch = 0;
  private focusedFileId: number | null = null;
  private focusFromCommunity = false;
  /** D-135: убрать компактную карточку (обычная перерисовка выдачи — сама очистит). */
  private clearFocusCard(): void {
    if (this.focusHost) {
      this.focusHost.remove();
      this.focusHost = null;
    }
  }
  /**
   * D-135/D-136: прыжок «из чата в карточку» — подсветить и скроллить к
   * карточке выдачи; если карточки там нет — построить её над результатами
   * из `GET /api/v1/files/{id}`. Карточка ПОЛНАЯ, тот же рендерер, что в
   * выдаче поиска (`_buildResultCard`: поля формы, медиа, отзывы, сводка,
   * вложения) — «полукарточки» бренд/модель больше нет (D-136, поручение
   * владельца 2026-10-30). `fromCommunity` добавляет чип возврата в чат.
   */
  async focusCard(fileId: number, opts: { fromCommunity?: boolean } = {}): Promise<void> {
    const container = this.resultsContainer;
    if (!container || !Number.isSafeInteger(fileId) || fileId <= 0) return;
    const epoch = ++this.focusEpoch;
    // A pending catalogue/debounce must not erase the card requested from chat.
    this._epoch++;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    if (this._lastStatus?.kind === "searching") {
      this._lastStatus = null;
      if (this.searchStatus) this.searchStatus.textContent = "";
    }
    this.focusedFileId = fileId;
    this.focusFromCommunity = !!opts.fromCommunity;
    const existing = container
      .querySelector<HTMLElement>(`.search-dl-btn[data-file-id="${fileId}"]`)
      ?.closest<HTMLElement>(".search-result-card");
    container.querySelectorAll("[data-return-community]").forEach(chip => chip.remove());
    if (existing) {
      // A repeated jump may target our own temporary card: keep it connected.
      if (!this.focusHost?.contains(existing)) this.clearFocusCard();
      if (opts.fromCommunity) this._attachReturnChip(existing);
      this._flash(existing);
      return;
    }
    this.clearFocusCard();
    try {
      const file = await api.fileById(fileId);
      if (epoch !== this.focusEpoch || this.resultsContainer !== container) return;
      if (file.id !== fileId) throw new Error("Invalid file response");
      const host = document.createElement("div");
      host.className = "search-jump-host";
      // D-136: ТА ЖЕ карточка, что в выдаче поиска (поля формы, медиа, отзывы,
      // сводка, вложения) — «полукарточки» больше нет.
      host.appendChild(this._buildResultCard(file));
      container.prepend(host);
      this.focusHost = host;
      const card = host.querySelector<HTMLElement>(".search-result-card")!;
      if (opts.fromCommunity) this._attachReturnChip(card);
      this._flash(card);
    } catch (e: unknown) {
      if (epoch !== this.focusEpoch) return;
      const message = e instanceof Error ? e.message : String(e);
      this.onNotify?.(t(/404|403|not_found|not found|forbidden/i.test(message)
        ? "search.id_unavailable" : "search.id_network_error"), "error");
    }
  }

  /** Чип «← Вернуться в чат» в шапке карточки (D-135); снимается после клика. */
  private _attachReturnChip(card: HTMLElement): void {
    const header = card.querySelector(".search-result-header");
    if (!header || this.onReturnToCommunity == null) return;
    let chip = header.querySelector<HTMLButtonElement>("[data-return-community]");
    if (!chip) {
      const template = document.createElement("template");
      template.innerHTML = renderReturnChipHtml();
      chip = template.content.firstElementChild as HTMLButtonElement;
      header.prepend(chip);
    }
    chip.textContent = t("search.back_to_chat");
    chip.onclick = () => {
      chip!.remove();
      this.focusFromCommunity = false;
      this.onReturnToCommunity?.();
    };
  }

  /** Подсветка карточки на 1.4 с (владелец видит, куда «перенесло»). */
  private _flash(card: HTMLElement): void {
    if (card.getClientRects().length) card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("search-focus-flash");
    // перезапуск анимации: форсируем reflow между классами
    void card.offsetWidth;
    card.classList.add("search-focus-flash");
    window.setTimeout(() => card.classList.remove("search-focus-flash"), 1400);
  }

  constructor(
    onDownloadFile: (fileId: number) => void,
    onPersonalDownloadFile?: (pfId: number) => void,
    onNotify?: (message: string, type: "success" | "error" | "info") => void,
    private onDiscussion?: (fileId: number) => void,
    private onReturnToCommunity?: () => void,
  ) {
    this.onDownloadFile = onDownloadFile;
    this.onPersonalDownloadFile = onPersonalDownloadFile ?? null;
    this.onNotify = onNotify ?? null;
  }

  bindEvents(): void {
    this.searchInput = document.getElementById("searchQuery") as HTMLInputElement;
    this.searchBtn = document.getElementById("searchBtn") as HTMLButtonElement;
    this.allCatalogBtn = document.getElementById("searchAllCatalogBtn") as HTMLButtonElement;
    this.crumbsEl = document.getElementById("searchCrumbs")!;
    this.resultsContainer = document.getElementById("searchResults")!;
    this.searchStatus = document.getElementById("searchStatus")!;
    this.facetsEl = document.getElementById("searchFacets")!;
    this.logEl = document.getElementById("searchLog")!;

    this.fileIdInput = document.getElementById("searchFileId") as HTMLInputElement;
    document.getElementById("searchFileIdBtn")!.addEventListener("click", () => void this.searchById());
    this.fileIdInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void this.searchById(); }
    });
    this.fileIdInput.addEventListener("input", () => {
      if (!this.fileIdInput.value.trim()) void this.doSearch();
    });
    this.searchBtn.addEventListener("click", () => this.doSearch());
    // «Весь каталог» (A3): паритет пустого ввода — дерево публичного каталога.
    this.allCatalogBtn.addEventListener("click", () => void this.openCatalogTree());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.doSearch();
    });
    // Мгновенный поиск «на каждое нажатие» (debounce 250 мс): каталог Meili
    // дешёвый (typo-tolerance в индексе). Legacy ILIKE не дёргаем — запрос
    // уходит только после паузы в вводе.
    // BUG-SEARCH-SCOPE-002: запрос < MIN_SEARCH_CHARS символов НЕ отправляется —
    // сразу показываем подсказку (иначе короткий ввод «грязнит» выдачу).
    this.searchInput.addEventListener("input", () => {
      if (this.fileIdInput.value.trim()) return;
      if (decideSearch(this.searchInput.value) === "too_short") {
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
        }
        this._showMinCharsHint();
        return;
      }
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        void this.doSearch();
      }, 250);
    });

    // Клики по фасетам: чип (toggle) и «Сбросить» — делегирование на контейнер.
    this.facetsEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".facet-clear")) {
        this._selection = clearAll(this._selection);
        void this.doSearch();
        return;
      }
      const chip = target.closest<HTMLElement>(".facet-option");
      if (chip) {
        const field = chip.dataset.field ?? "";
        const value = chip.dataset.value ?? "";
        if (field && value) {
          this._selection = toggleValue(this._selection, field, value);
          void this.doSearch();
        }
      }
    });

    // Фокус на поле ввода при загрузке
    setTimeout(() => this.searchInput?.focus(), 500);
  }

  private log(msg: string, type: string = "info"): void {
    const line = document.createElement("div");
    line.className = `line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + " " + units[i];
  }

  /** Иконка/метка класса контента (kind badge). Значение content_kind — данные, переводится только бейдж. */
  private kindLabel(item: { content_kind?: string; doc_type?: string }): string {
    const kind = item.content_kind || "firmware";
    return t(KIND_KEY[kind] ?? "search.kind.firmware");
  }

  /** Заголовок карточки: title-only kind → title; иначе brand + model (+ версия). */
  private cardTitle(item: {
    content_kind?: string;
    title?: string;
    brand: string;
    model: string;
    version?: string;
    chassis?: string;
  }): string {
    const kind = item.content_kind || "firmware";
    if (TITLE_ONLY_KINDS.has(kind) && item.title && item.title.trim()) {
      return item.title.trim();
    }
    const parts = [item.brand, item.model].filter((p) => p && p.trim());
    const head = parts.length ? parts.join(" ") : (item.title?.trim() || t("search.untitled"));
    return item.chassis ? `${head} ${item.chassis}` : head;
  }

  /** Показать личное хранилище (без запроса = список всех своих файлов). */
  async showPersonal(): Promise<void> {
    this.searchInput.value = "";
    // Смена scope → фасеты предыдущего (публичного) контекста не переносятся.
    this._selection = {};
    this._lastFacets = null;
    this._epoch++;
    // Вход в кабинет всегда перечитывает список — пометка «устарел» снимается.
    this._personalCabinetStale = false;
    // A3: «Весь каталог» — вход в ПУБЛИЧНОЕ дерево; в личном режиме скрыт
    // (там пустой запрос и так даёт список всех своих файлов).
    if (this.allCatalogBtn) this.allCatalogBtn.style.display = "none";
    await this.doSearch();
  }

  /** Сброс при переключении обратно в «Публичное поле». */
  resetPublic(): void {
    this._clearResults();
    this._lastMode = null;
    this._lastResults = null;
    this._lastVaultResults = null;
    this._lastStatus = null;
    this._selection = {};
    this._lastFacets = null;
    this._tree = null;
    this._treePath = [];
    this._treeLeaf = null;
    this._hideCrumbs();
    // A3: возврат в публичный режим — кнопка «Весь каталог» снова доступна.
    if (this.allCatalogBtn) this.allCatalogBtn.style.display = "";
    this._epoch++; // невалидируем подвисшие каталог-ответы
    this._renderFacets();
    if (this.searchStatus) {
      this.searchStatus.textContent = "";
      this.searchStatus.className = "search-status";
    }
    if (this.searchInput) this.searchInput.value = "";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Дерево публичного каталога (A3, «Весь каталог»)
  // ══════════════════════════════════════════════════════════════════════════

  /** Скрыть хлебные крошки (любой не-деревянный режим). */
  private _hideCrumbs(): void {
    if (!this.crumbsEl) return;
    this.crumbsEl.style.display = "none";
    this.crumbsEl.innerHTML = "";
  }

  /**
   * Открыть «Весь каталог»: вход из кнопки #searchAllCatalogBtn и из пустого
   * запроса. Фасеты сбрасываются — это полный обзор (как в личном кабинете).
   */
  async openCatalogTree(): Promise<void> {
    if (!requireAuth(this.log)) return;
    this.searchInput.value = "";
    this._selection = clearAll(this._selection);
    this._lastFacets = null;
    this._renderFacets();

    this.searchBtn.disabled = true;
    this.searchInput.disabled = true;
    try {
      await this._loadCatalogTree();
    } finally {
      this.searchBtn.disabled = false;
      this.searchInput.disabled = false;
    }
  }

  /** Загрузить дерево с сервера (SQL, approved-only) и отрисовать корень. */
  private async _loadCatalogTree(): Promise<void> {
    this._clearResults();
    this._lastMode = "tree";
    this._lastVaultResults = null;
    this._lastResults = null;
    this._treePath = [];
    this._treeLeaf = null;
    this._lastStatus = { kind: "searching" };
    this.searchStatus.textContent = t("search.searching");
    this.searchStatus.className = "search-status";
    this.logEl.innerHTML = "";
    this.log("Catalog tree: root", "info");

    const epoch = ++this._epoch;
    let resp: CatalogTreeResponse;
    try {
      resp = await api.catalogTree();
    } catch (e: any) {
      if (this._epoch !== epoch) return;
      const err = e?.message ?? String(e);
      this._lastStatus = { kind: "error", err };
      this.searchStatus.textContent = t("search.error", { err });
      this.searchStatus.className = "search-status error";
      this.log(`Catalog tree error: ${err}`, "error");
      return;
    }
    if (this._epoch !== epoch) return; // пользователь уже ищет/переключает

    if (!resp.ok) {
      const err = "search failed";
      this._lastStatus = { kind: "error", err };
      this.searchStatus.textContent = t("search.error", { err });
      this.searchStatus.className = "search-status error";
      this.log("Catalog tree: server returned ok=false", "error");
      return;
    }

    this._tree = resp.tree;
    this._renderTree();

    const total = resp.tree?.total ?? 0;
    if (total === 0) {
      this._lastStatus = { kind: "catalog_empty" };
      this.searchStatus.textContent = t("search.tree_empty");
      this.searchStatus.className = "search-status";
      this.log("Catalog is empty", "warn");
      return;
    }
    this._lastStatus = { kind: "catalog", n: total };
    this.searchStatus.textContent = t("search.tree_total", { n: total });
    this.searchStatus.className = "search-status success";
    this.log(`Catalog tree loaded: ${total} file(s)`, "success");
  }

  /**
   * Перерисовать текущий уровень дерева (папки) либо, если открыт лист,
   * файлы папки карточками. Крошки — отдельный контейнер (не пересоздаётся
   * вместе с результатами) — i18n-safe.
   */
  private _renderTree(preserveCommunity=false): void {
    this._clearResults(preserveCommunity);
    if (!this.crumbsEl) return;
    this.crumbsEl.style.display = "flex";
    this._renderCrumbs();

    if (this._treeLeaf) {
      const items = this._lastResults ?? [];
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-empty";
        empty.textContent = t("search.tree_empty");
        this.resultsContainer.appendChild(empty);
        return;
      }
      for (const item of items) this.renderResultCard(item);
      return;
    }

    const tree = this._tree;
    if (!tree) return;
    const level = document.createElement("div");
    level.className = "tree-level";

    const path = this._treePath;
    if (path.length === 0) {
      for (const k of kindsAt(tree)) {
        level.appendChild(
          this._folderRow(this.kindLabel({ content_kind: k.kind }), k.count, () => {
            this._treePath = [k.kind];
            this._renderTree();
          }),
        );
      }
    } else if (path.length === 1) {
      const kind = path[0];
      for (const b of brandsAt(tree, path)) {
        level.appendChild(
          this._folderRow(b.brand, b.count, () => {
            if (isLeafClick(kind, b)) {
              void this._openLeaf({ kind, brand: b.brand, model: null });
              return;
            }
            this._treePath = [kind, b.brand];
            this._renderTree();
          }),
        );
      }
    } else {
      const kind = path[0];
      const brand = path[1];
      for (const m of modelsAt(tree, path)) {
        level.appendChild(
          this._folderRow(m.model, m.count, () => {
            void this._openLeaf({ kind, brand, model: m.model });
          }),
        );
      }
    }

    if (level.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = t("search.tree_empty");
      level.appendChild(empty);
    }
    this.resultsContainer.appendChild(level);
  }

  /** Кликабельная папка уровня дерева: 📁 label + счётчик файлов. */
  private _folderRow(label: string, count: number, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "tree-folder";
    const name = document.createElement("span");
    name.textContent = `📁 ${label}`;
    const badge = document.createElement("span");
    badge.className = "tree-folder-count";
    badge.textContent = String(count);
    btn.appendChild(name);
    btn.appendChild(badge);
    btn.addEventListener("click", onClick);
    return btn;
  }

  /**
   * Хлебные крошки: корень («Весь каталог») → kind → brand → model.
   * Клик по сегменту возвращает на соответствующий уровень (лист сбрасывается).
   */
  private _renderCrumbs(): void {
    if (!this.crumbsEl) return;
    this.crumbsEl.innerHTML = "";

    const root = document.createElement("button");
    root.className = "tree-crumb";
    root.textContent = t("search.all_catalog");
    root.addEventListener("click", () => this._goToCrumb(0));
    this.crumbsEl.appendChild(root);

    this._crumbLabels().forEach((label, i) => {
      const sep = document.createElement("span");
      sep.className = "tree-sep";
      sep.textContent = "›";
      this.crumbsEl.appendChild(sep);

      const btn = document.createElement("button");
      btn.className = "tree-crumb";
      btn.textContent = label;
      btn.addEventListener("click", () => this._goToCrumb(i + 1));
      this.crumbsEl.appendChild(btn);
    });
  }

  /** Подписи сегментов крошек (kind локализуется как бейдж, данные — нет). */
  private _crumbLabels(): string[] {
    if (this._treeLeaf) {
      const leaf = this._treeLeaf;
      const kind = this.kindLabel({ content_kind: leaf.kind });
      // Title-only kind: файлы лежат прямо в папке — model-уровня нет.
      if (TITLE_ONLY_KINDS.has(leaf.kind)) return [kind, leaf.brand];
      return [kind, leaf.brand, leaf.model ?? t("search.untitled")];
    }
    return this._treePath.map((seg, i) =>
      i === 0 ? this.kindLabel({ content_kind: seg }) : seg,
    );
  }

  /** Клик по крошке: index 0 = корень, иначе сегмент пути (лист сбрасывается). */
  private _goToCrumb(index: number): void {
    this._treePath =
      index === 0 ? [] : this._treePath.slice(0, Math.min(index, this._treePath.length));
    this._treeLeaf = null;
    this._lastResults = null;
    // Возврат к каталогу — статус снова «в каталоге n файлов».
    const total = this._tree?.total ?? 0;
    this._lastStatus = total ? { kind: "catalog", n: total } : { kind: "catalog_empty" };
    if (total) {
      this.searchStatus.textContent = t("search.tree_total", { n: total });
      this.searchStatus.className = "search-status success";
    } else {
      this.searchStatus.textContent = t("search.tree_empty");
      this.searchStatus.className = "search-status";
    }
    this._renderTree();
  }

  /**
   * Открыть папку-лист: файлы показываются карточками (Meili-фильтр листа;
   * при деградации — legacy с клиентским фильтром matchesLeaf).
   */
  private async _openLeaf(leaf: TreeLeaf): Promise<void> {
    this._treeLeaf = leaf;
    this._treePath =
      TITLE_ONLY_KINDS.has(leaf.kind) ? [leaf.kind] : [leaf.kind, leaf.brand];
    this._lastFacets = null;
    this._renderFacets();
    this.searchBtn.disabled = true;
    this.searchInput.disabled = true;
    try {
      await this._doCatalogSearch("", leafFilter(leaf), { tree: true });
    } finally {
      this.searchBtn.disabled = false;
      this.searchInput.disabled = false;
    }
  }

  private async searchById(): Promise<void> {
    if (!requireAuth(this.log)) return;
    const id = parseFileId(this.fileIdInput.value);
    if (id === null) {
      this.onNotify?.(t("search.id_invalid"), "error");
      return;
    }
    await this.focusCard(id);
  }

  private async doSearch(): Promise<void> {
    // Единая проверка авторизации
    if (!requireAuth(this.log)) return;

    if (this.fileIdInput?.value.trim()) { await this.searchById(); return; }

    // BUG-SEARCH-SCOPE-002: 1–2 символа — запрос не уходит (кнопка/Enter/автопоиск
    // тоже), показываем подсказку. Пустой запрос — обычное поведение.
    if (decideSearch(this.searchInput.value) === "too_short") {
      this._showMinCharsHint();
      return;
    }

    // В личном режиме поиск идёт по личному реестру, пустой запрос = список.
    if (isPersonalScope()) {
      await this.doPersonalSearch();
      return;
    }

    // Публичный режим: пустой запрос без фасетов = «Весь каталог» — дерево
    // папок (kind → brand → model), а не плоский список (решение владельца,
    // 2026-09-23). Пустой запрос С фасетами — плоская выдача с фильтром.
    const query = this.searchInput.value.trim();
    if (!query && countActive(this._selection) === 0) {
      await this.openCatalogTree();
      return;
    }

    this.searchBtn.disabled = true;
    this.searchInput.disabled = true;
    try {
      await this._doCatalogSearch(query);
    } finally {
      this.searchBtn.disabled = false;
      this.searchInput.disabled = false;
      this.searchInput.focus();
    }
  }

  /**
   * Подсказка «мало символов» (BUG-SEARCH-SCOPE-002): результаты и фасеты
   * предыдущего запроса СКРЫВАЮТСЯ — иначе «залипшее» found-состояние
   * выглядело бы как результат короткого запроса.
   */
  private _showMinCharsHint(): void {
    this._epoch++; // невалидируем подвисшие каталог-ответы
    this._clearResults();
    this._lastMode = null;
    this._lastResults = null;
    this._lastVaultResults = null;
    this._lastFacets = null;
    this._treePath = [];
    this._treeLeaf = null;
    this._hideCrumbs();
    this._renderFacets();
    this._lastStatus = { kind: "min_chars" };
    this.searchStatus.textContent = t("search.min_chars");
    this.searchStatus.className = "search-status";
    this.log(`Query too short — min ${MIN_SEARCH_CHARS} chars required`, "warn");
  }

  /**
   * Публичный каталог через Meili-прокси (Phase 3): фасеты + опечатки +
   * мгновенный поиск. Деградации (fail-open по всему конвейеру):
   *   - прокси недоступен / старый сервер (404) → legacy /desktop/search;
   *   - SEARCH_INDEX_ENABLED=false → fallback:"index_disabled" → legacy;
   *   - Meili down → 503 → legacy.
   * Гонка debounce: ответ применяется только если поколение (`_epoch`)
   * актуально — иначе (пользователь уже печатает дальше) ответ выбрасывается.
   */
  private async _doCatalogSearch(
    query: string,
    filterOverride?: string,
    opts?: { tree?: boolean },
  ): Promise<void> {
    const treeMode = opts?.tree === true;
    this._clearResults();
    this._lastMode = treeMode ? "tree" : "public";
    this._lastVaultResults = null;
    this._lastStatus = { kind: "searching" };
    this.searchStatus.textContent = t("search.searching");
    this.searchStatus.className = "search-status";
    if (!treeMode) {
      this._treePath = [];
      this._treeLeaf = null;
      this._hideCrumbs();
    }
    this.logEl.innerHTML = "";
    this.log(
      query
        ? `Searching: "${query}" (facets: ${countActive(this._selection)})`
        : `Catalog browse (facets: ${countActive(this._selection)})`,
      "info",
    );

    const epoch = ++this._epoch;

    let resp: CatalogSearchResponse;
    try {
      resp = await api.catalogSearch(
        query,
        filterOverride ?? buildFilter(this._selection),
      );
    } catch (e: any) {
      this.log(
        `Catalog proxy unavailable (${e?.message ?? e}) → legacy search`,
        "warn",
      );
      await this._doLegacyPublicSearch(query, epoch, this._treeLeaf);
      return;
    }

    if (this._epoch !== epoch) return; // устаревший ответ — пользователь уже ищет дальше

    if (resp.fallback === "index_disabled") {
      this.log("Search index disabled on server → legacy search", "warn");
      await this._doLegacyPublicSearch(query, epoch, this._treeLeaf);
      return;
    }

    if (!resp.ok) {
      const err = resp.error ?? "search failed";
      this._lastStatus = { kind: "error", err };
      this.searchStatus.textContent = t("search.error", { err });
      this.searchStatus.className = "search-status error";
      this.log(`Catalog search error: ${err}`, "error");
      return;
    }

    this._lastFacets = resp.facets ?? {};
    this._renderFacets();

    if (resp.results.length === 0) {
      this._lastResults = [];
      this._lastStatus = query ? { kind: "not_found", query } : { kind: "catalog_empty" };
      if (query) {
        this.searchStatus.textContent = t("search.not_found", { query });
        this.searchStatus.className = "search-status error";
        this.log(`No results for "${query}"`, "warn");
      } else {
        this.searchStatus.textContent = t("search.tree_empty");
        this.searchStatus.className = "search-status";
        this.log("Catalog folder is empty", "warn");
      }
      if (treeMode) this._renderTree();
      return;
    }

    this._lastStatus = { kind: "found", n: resp.total };
    if (!query) {
      // Browse (пустой q): «в каталоге n файлов» вместо «найдено по запросу».
      this.searchStatus.textContent = t("search.tree_total", { n: resp.total });
      this.log(`Catalog: ${resp.total} file(s)`, "success");
    } else {
      this.searchStatus.textContent = t("search.found", { n: resp.total });
      this.log(`Found ${resp.total} file(s)`, "success");
    }
    this.searchStatus.className = "search-status success";

    this._lastResults = resp.results;
    if (treeMode) {
      this._renderTree();
      return;
    }
    for (const item of resp.results) {
      this.renderResultCard(item);
    }
  }

  /**
   * Legacy-путь (ILIKE /desktop/search) — деградация каталога. Без фасетов:
   * панель скрывается. Поколение `epoch` гарантирует, что медленный legacy-ответ
   * не перезатрёт более новый каталог-ответ.
   *
   * `leaf` (A3): файлы папки дерева — legacy-эндпоинт фильтра не знает,
   * поэтому выборка сужается клиентским `matchesLeaf`.
   */
  private async _doLegacyPublicSearch(
    query: string,
    epoch: number,
    leaf?: TreeLeaf | null,
  ): Promise<void> {
    this._lastFacets = null;
    this._renderFacets();
    try {
      const resp = await api.search(query);
      if (this._epoch !== epoch) return;

      const items = leaf
        ? resp.results.filter((r) => matchesLeaf(r, leaf))
        : resp.results;

      if (!resp.ok || items.length === 0) {
        this._lastResults = [];
        if (query) {
          this._lastStatus = { kind: "not_found", query };
          this.searchStatus.textContent = t("search.not_found", { query });
          this.searchStatus.className = "search-status error";
          this.log(`No results for "${query}"`, "warn");
        } else {
          this._lastStatus = { kind: "catalog_empty" };
          this.searchStatus.textContent = t("search.tree_empty");
          this.searchStatus.className = "search-status";
          this.log("Catalog folder is empty (legacy)", "warn");
        }
        if (leaf) this._renderTree();
        return;
      }

      this._lastStatus = { kind: "found", n: items.length };
      if (!query) {
        this.searchStatus.textContent = t("search.tree_total", { n: items.length });
        this.log(`Catalog (legacy): ${items.length} file(s)`, "success");
      } else {
        this.searchStatus.textContent = t("search.found", { n: items.length });
        this.log(`Found ${items.length} file(s)`, "success");
      }
      this.searchStatus.className = "search-status success";

      this._lastResults = items;
      if (leaf) {
        this._renderTree();
        return;
      }
      for (const item of items) {
        this.renderResultCard(item);
      }
    } catch (e: any) {
      if (this._epoch !== epoch) return;
      this._lastStatus = { kind: "error", err: e.message };
      this.searchStatus.textContent = t("search.error", { err: e.message });
      this.searchStatus.className = "search-status error";
      this.log(`Search error: ${e.message}`, "error");
    }
  }

  /**
   * Личный поиск/список по своим файлам (SPEC §6.3).
   *
   * Phase 4: фасетный личный каталог через Meili-прокси
   * (/api/v1/search/personal — сервер жёстко фильтрует по своему tg_id),
   * тот же чип-UI, что и публичный каталог. Деградации — как в публичном:
   * прокси недоступен / index_disabled / Meili down → legacy
   * /desktop/vault/search (ILIKE), панель фасетов скрывается.
   */
  /** Обновить личный список (после удаления файла/копии — вне изнутри класса). */
  async refreshPersonalList(): Promise<void> {
    this._personalCabinetStale = false;
    await this.doPersonalSearch();
  }

  /**
   * BUG-CABINET-STALE-001: список кабинета устарел (была личная загрузка).
   *
   * Список приходит одним GET и живёт в DOM — без этой пометки свежий файл
   * появлялся только после перезапуска клиента (живой репорт владельца
   * 2026-11-11: personal #33 загружен, в кабинете его нет).
   */
  private _personalCabinetStale = false;

  /** Пометить список кабинета устаревшим (после личной загрузки). */
  markPersonalCabinetStale(): void {
    this._personalCabinetStale = true;
  }

  /**
   * Перечитать список кабинета, если он устарел И кабинет открывается сейчас.
   *
   * `activeTab` — `data-tab` вкладки, которая становится активной (передаёт
   * App): правило (личный режим + «Пошук» + пометка) живёт в `CabinetRefresh`,
   * чтобы его нельзя было размазать по вызовам.
   */
  async refreshPersonalCabinetIfStale(activeTab: string): Promise<void> {
    const scope = isPersonalScope() ? "personal" : "public";
    if (!shouldRefreshCabinet({ scope, tab: activeTab, stale: this._personalCabinetStale })) {
      return;
    }
    this._personalCabinetStale = false;
    this.log("Cabinet list stale after upload → refreshing", "info");
    await this.refreshPersonalList();
  }

  /** Открыта ли вкладка «Пошук» (фоновое обновление не должно красть фокус). */
  private _isSearchTabActive(): boolean {
    return (
      document.getElementById("tab-search")?.classList.contains("active") === true
    );
  }

  /**
   * D-180: показать карточку только что принятого входящего файла.
   *
   * Индекс Meili обновляется post-commit асинхронно, поэтому первые попытки
   * могут не найти карточку — обновляем личный список с короткими паузами.
   * Подсветка — тот же `_flash`, что и при прыжке на карточку из поиска.
   */
  async flashPersonalCard(pfId: number): Promise<void> {
    const selector = `.search-result-card[data-personal-id="${pfId}"]`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const card = this.resultsContainer?.querySelector<HTMLElement>(selector);
      if (card) {
        this._flash(card);
        return;
      }
      if (attempt === 3) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await this.refreshPersonalList();
    }
  }

  private async doPersonalSearch(): Promise<void> {
    const query = this.searchInput.value.trim();

    this.searchBtn.disabled = true;
    this.searchInput.disabled = true;
    try {
      await this._doPersonalCatalog(query);
    } finally {
      this.searchBtn.disabled = false;
      this.searchInput.disabled = false;
      // Фокус ставим ТОЛЬКО когда вкладка «Пошук» реально открыта: фоновое
      // обновление списка (после личной загрузки) не должно уводить курсор
      // на скрытую вкладку (BUG-CABINET-STALE-001).
      if (this._isSearchTabActive()) this.searchInput.focus();
    }
  }

  private async _doPersonalCatalog(query: string): Promise<void> {
    this._clearResults();
    this._lastMode = "vault";
    this._lastResults = null;
    this._treePath = [];
    this._treeLeaf = null;
    this._hideCrumbs();
    this._lastStatus = { kind: "searching" };
    this.searchStatus.textContent = t("search.searching");
    this.searchStatus.className = "search-status";
    this.logEl.innerHTML = "";
    this.log(
      query
        ? `Personal search: "${query}" (facets: ${countActive(this._selection)})`
        : "Personal storage: browse all",
      "info",
    );

    const epoch = ++this._epoch;

    let resp: CatalogSearchResponse;
    try {
      resp = await api.personalCatalogSearch(query, buildFilter(this._selection));
    } catch (e: any) {
      this.log(
        `Personal catalog proxy unavailable (${e?.message ?? e}) → legacy`,
        "warn",
      );
      await this._doLegacyPersonalSearch(query, epoch);
      return;
    }

    if (this._epoch !== epoch) return;

    // BUG-PERSONAL-DELETE-001: индекс может на несколько секунд вернуть
    // «только что удалённый» файл — такие id прячем (см. _hiddenPersonalIds).
    if (this._hiddenPersonalIds.size > 0) {
      resp.results = resp.results.filter(
        (r) => !this._hiddenPersonalIds.has(r.id),
      );
    }

    if (resp.fallback === "index_disabled") {
      this.log("Search index disabled on server → legacy personal search", "warn");
      await this._doLegacyPersonalSearch(query, epoch);
      return;
    }

    if (!resp.ok) {
      const err = resp.error ?? "search failed";
      this._lastStatus = { kind: "error", err };
      this.searchStatus.textContent = t("search.error", { err });
      this.searchStatus.className = "search-status error";
      this.log(`Personal catalog error: ${err}`, "error");
      return;
    }

    this._lastFacets = resp.facets ?? {};
    this._renderFacets();

    if (resp.results.length === 0) {
      this._lastVaultResults = [];
      if (query) {
        this._lastStatus = { kind: "not_found", query };
        this.searchStatus.textContent = t("search.not_found", { query });
        this.searchStatus.className = "search-status error";
        this.log(`No personal results for "${query}"`, "warn");
      } else {
        this._lastStatus = { kind: "empty_personal" };
        this.searchStatus.textContent = t("search.empty_personal");
        this.searchStatus.className = "search-status";
        this.log("Personal storage is empty", "warn");
      }
      return;
    }

    this._lastStatus = { kind: "found_personal", n: resp.total };
    this.searchStatus.textContent = t("search.personal_found", { n: resp.total });
    this.searchStatus.className = "search-status success";
    this.log(`Found ${resp.total} personal file(s)`, "success");

    const items = resp.results.map((card) => this._cardToVaultItem(card));
    this._lastVaultResults = items;
    for (const item of items) {
      this.renderVaultCard(item);
    }
  }

  /** Карточка Meili → VaultFileItem (карточка личного файла, Phase 4). */
  private _cardToVaultItem(
    card: SearchResultItem & { published_file_id?: number },
  ): VaultFileItem {
    return {
      id: card.id,
      content_kind: card.content_kind,
      brand: card.brand,
      model: card.model,
      version: card.version,
      description: card.description,
      original_name: card.original_name,
      size_bytes: card.size_bytes,
      created_at: card.created_at,
      published_file_id: card.published_file_id ?? null,
      device_category: card.device_category,
      chassis: card.chassis,
      chipset: card.chipset,
      memory_type: card.memory_type,
      firmware_type: card.firmware_type,
      source_status: card.source_status,
      programmer: card.programmer,
      panel_model: card.panel_model,
      doc_type: card.doc_type,
      title: card.title,
    };
  }

  /** Legacy личный поиск (ILIKE /desktop/vault/search) — деградация каталога. */
  private async _doLegacyPersonalSearch(query: string, epoch: number): Promise<void> {
    this._lastFacets = null;
    this._renderFacets();
    try {
      const resp = await api.vaultSearch(query);
      if (this._epoch !== epoch) return;

      if (!resp.ok || resp.results.length === 0) {
        this._lastVaultResults = [];
        if (query) {
          this._lastStatus = { kind: "not_found", query };
          this.searchStatus.textContent = t("search.not_found", { query });
          this.searchStatus.className = "search-status error";
          this.log(`No personal results for "${query}"`, "warn");
        } else {
          this._lastStatus = { kind: "empty_personal" };
          this.searchStatus.textContent = t("search.empty_personal");
          this.searchStatus.className = "search-status";
          this.log("Personal storage is empty", "warn");
        }
        return;
      }

      this._lastStatus = { kind: "found_personal", n: resp.total };
      this.searchStatus.textContent = t("search.personal_found", { n: resp.total });
      this.searchStatus.className = "search-status success";
      this.log(`Found ${resp.total} personal file(s)`, "success");

      this._lastVaultResults = resp.results;
      for (const item of resp.results) {
        this.renderVaultCard(item);
      }
    } catch (e: any) {
      if (this._epoch !== epoch) return;
      this._lastStatus = { kind: "error", err: e.message };
      this.searchStatus.textContent = t("search.error", { err: e.message });
      this.searchStatus.className = "search-status error";
      this.log(`Personal search error: ${e.message}`, "error");
    }
  }

  /**
   * Карточка личного файла: статус публикации + действия publish/delete.
   *
   * «Отозвать из общего» у юзера НЕТ: если файл опубликован в общий каталог,
   * он остаётся там (удалить его может только админ). Юзер может удалить
   * ТОЛЬКО свою личную копию (реестр + self-delete PM) — публикация в каталоге
   * при этом не трогается (опубликованный File живёт отдельной записью).
   */
  // ─── Медиа карточки (SP-15 v3, D-069) ──────────────────────────────────────

  /**
   * `blob:`-адреса защищённых медиа: держим, чтобы освобождать при перерисовке
   * карточки/очистке результатов (иначе адрес живёт до перезапуска окна).
   */
  private _mediaBlobs: string[] = [];
  private _cardMediaBlobs = new WeakMap<HTMLElement, string[]>();
  /** Фетчеры медиа-байтов (SP-15 срез 5): своя TDLib → серверный прокси. */
  private _mediaThumb: ((url: string, item?: ResolvedMedia) => Promise<string>) | null = null;
  private _mediaFull: ((url: string, item?: ResolvedMedia) => Promise<string>) | null = null;

  /** Освободить blob-адреса конкретной карточки (перед перерисовкой её галереи). */
  private _revokeCardBlobs(card: HTMLElement): void {
    const old = this._cardMediaBlobs.get(card) || [];
    if (!old.length) return;
    revokeObjectUrls(old);
    this._mediaBlobs = this._mediaBlobs.filter((url) => !old.includes(url));
    this._cardMediaBlobs.delete(card);
  }

  /** Нормализовать медиа карточки под канонический домен сервера. */
  private _cardMedia(
    items: SearchResultItem["media"],
    opts: { authorized?: boolean } = {},
  ): ResolvedMedia[] {
    return resolveCardMedia(items as never, api.getBaseUrl(), opts);
  }

  /**
   * Вставить галерею превью в карточку и привязать лайтбокс (увеличение без потерь).
   *
   * Защищённые медиа (`authorized`) тег `<img>` показать НЕ может — маршрут
   * требует `Authorization`, а тег заголовки не отправляет. Поэтому превью
   * качаем сами (`api.mediaObjectUrl` → blob), а оригинал грузится лениво при
   * открытии зума (`resolveFull`).
   */
  private async _attachCardMedia(card: HTMLElement, items: ResolvedMedia[]): Promise<void> {
    if (!items.length) return;
    let list = items;
    if (items.some((m) => m.authorized)) {
      // Байты: сначала СВОЯ TDLib по якорю (SP-15 срез 5, D-071), иначе прокси.
      const res = await loadProtectedThumbs(items, this._mediaThumbFetcher());
      list = res.items;
      this._revokeCardBlobs(card);
      if (res.objectUrls.length) {
        this._cardMediaBlobs.set(card, res.objectUrls);
        this._mediaBlobs.push(...res.objectUrls);
      }
    }
    const host = card.querySelector<HTMLElement>(".search-result-media");
    if (!host) return;
    host.innerHTML = renderMediaGalleryHtml(list);
    bindMediaGallery(host, list, (index) => {
      openMediaLightbox(
        list.map((m) => ({
          fullUrl: m.fullUrl,
          thumbUrl: m.thumbUrl,
          width: m.width,
          height: m.height,
          // Резолвер — свой на каждое открытие: лайтбокс освобождает blob при
          // закрытии, поэтому кешировать адрес между открытиями нельзя.
          resolveFull: m.authorized
            ? fullSizeResolver(m.fullUrl, this._mediaFullFetcher(), m)
            : undefined,
        })),
        index,
      );
    });
  }

  /** Фетчер превью карточки: своя TDLib (якорь) → серверный прокси (фолбэк). */
  private _mediaThumbFetcher(): (url: string, item?: ResolvedMedia) => Promise<string> {
    this._mediaThumb ??= mediaBytesForUi((url) => api.mediaObjectUrl(url), "thumb");
    return this._mediaThumb;
  }

  /** Фетчер оригинала (зум): крупные кадры (>20 МБ) идут только через TDLib. */
  private _mediaFullFetcher(): (url: string, item?: ResolvedMedia) => Promise<string> {
    this._mediaFull ??= mediaBytesForUi((url) => api.mediaObjectUrl(url), "full");
    return this._mediaFull;
  }

  /** Личная карточка: медиа берём запросом (в индексе поиска их нет). */
  private async _hydrateVaultMedia(card: HTMLElement, personalId: number): Promise<void> {
    try {
      const res = await api.cardMediaList("personal", personalId);
      // Личная карточка — всегда владелец: байты только с токеном.
      await this._attachCardMedia(card, this._cardMedia(res.media as never, { authorized: true }));
    } catch {
      /* fail-open: нет медиа/нет доступа — галереи просто не будет */
    }
  }

  /**
   * Медиа карточки в выдаче: своя → владельческий список (якоря → TDLib),
   * чужая публичная → превью из индекса (без токена). Провал запроса у своей
   * карточки НЕ оставляет карточку без галереи — падаем на индекс (fail-open).
   */
  private async _attachOwnOrIndexMedia(card: HTMLElement, item: SearchResultItem): Promise<void> {
    if (this._isOwnPublicCard(item)) {
      try {
        const res = await api.cardMediaList("file", item.id);
        const own = this._cardMedia(res.media as never, { authorized: true });
        if (own.length) {
          await this._attachCardMedia(card, own);
          return;
        }
      } catch {
        /* нет доступа/сеть — ниже индекс */
      }
    }
    await this._attachCardMedia(card, this._cardMedia(item.media));
  }

  /** Кнопка «📎 Добавить медиа» — показывается только владельцу карточки. */
  /**
   * Кнопка «Редагувати» для СВОЕЙ карточки (D-186).
   *
   * Чужой карточке правка недоступна вовсе (сервер ответит 403), поэтому кнопки
   * нет: показывать её значило бы обещать действие, которого не существует.
   * Состояние «уже правил» приходит с сервера при открытии формы — кнопка его
   * не угадывает (`can_edit`), иначе после перезапуска клиента она снова
   * выглядела бы доступной.
   */
  private _addEditButtonHtml(kind: "file" | "personal", cardId: number): string {
    // Потраченная попытка — состояние карточки, а не ошибка мастера: кнопка
    // остаётся на месте, но неактивна и сама говорит «використано» (D-187).
    const used = this._editUsedCards.has(SearchPage._editKey(kind, cardId));
    const label = this.esc(cardEditButtonLabel(used));
    return (
      `<button type="button" class="btn btn-secondary card-edit-btn"` +
      ` data-card-kind="${kind}" data-card-id="${cardId}"` +
      `${used ? " disabled" : ""}>${label}</button>`
    );
  }

  /**
   * Ряд «інструментів» карточки: дрібні дії власника (медіа + правка полів).
   *
   * ЕДИНСТВЕННОЕ место, где рендерится кнопка правки (D-187). Раньше она стояла
   * в одном flex-ряду с «Скачать» (`width:100%`), сжималась в узкий столбик и
   * текст переносился по буквам — карточка выглядела сломанной.
   *
   * `extraHtml` — дополнительные действия того же веса (у кабинета это
   * «Опублікувати»/«Поділитися»): одна строка с переносом вместо пяти
   * сжатых кнопок.
   */
  private _cardToolsRowHtml(
    kind: "file" | "personal",
    cardId: number,
    extraHtml = "",
  ): string {
    return (
      `<div class="card-tools-row">${extraHtml}` +
      `${this._addMediaButtonHtml(kind, cardId)}` +
      `${this._addEditButtonHtml(kind, cardId)}</div>`
    );
  }

  private _wireEdit(card: HTMLElement, kind: "file" | "personal", cardId: number): void {
    card.querySelector(".card-edit-btn")?.addEventListener("click", () => {
      void this.cardEditDialog.open(kind, cardId);
    });
  }

  private _addMediaButtonHtml(kind: "file" | "personal", cardId: number): string {
    return (
      `<button type="button" class="btn btn-secondary card-add-media-btn"` +
      ` data-kind="${kind}" data-id="${cardId}"` +
      ` title="${this.esc(t("media.add_hint"))}">${this.esc(t("media.add_btn"))}</button>`
    );
  }

  /** Публичная карточка принадлежит мне? (кнопка медиа — только владельцу). */
  private _isOwnPublicCard(item: SearchResultItem): boolean {
    const mine = getCurrentTgId();
    return mine > 0 && Number(item.uploader?.tg_id ?? 0) === mine;
  }

  /** Выбор фото → загрузка в тему карточки (SP-15 v3, D-069). */
  private _wireAddMedia(card: HTMLElement, kind: "file" | "personal", cardId: number): void {
    const btn = card.querySelector<HTMLButtonElement>(".card-add-media-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("change", () => {
        const file = input.files?.[0] as (File & { path?: string }) | undefined;
        const path = file?.path ?? "";
        if (!path) {
          this.log(t("media.need_path"), "warn");
          return;
        }
        void this._uploadCardMedia(card, kind, cardId, path);
      });
      input.click();
    });
  }

  private async _uploadCardMedia(
    card: HTMLElement,
    kind: "file" | "personal",
    cardId: number,
    filePath: string,
  ): Promise<void> {
    try {
      const uploader = new CardMediaUploader({
        init: (k, id) => api.cardMediaInit(k as never, id),
        startUpload: (args) => invoke<string>("tdlib_start_upload", args),
        waitUpload: (uploadId) => invoke("tdlib_wait_upload", { uploadId }),
        complete: (k, id, uploadId) => api.cardMediaComplete(k as never, id, uploadId),
      });
      const res = await uploader.addPhoto(kind as never, cardId, filePath);
      // Свежие медиа своей карточки: неодобренная публичная тоже защищена —
      // безопаснее тянуть байты с токеном (для одобренной публичной это no-op).
      await this._attachCardMedia(
        card,
        this._cardMedia(res.media as never, { authorized: true }),
      );
      this.log(t("media.added"), "info");
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.log(t("media.upload_failed", { reason }), "warn");
    }
  }

  // ─── Вложения карточки (SP-20, D-094) ──────────────────────────────────────

  /**
   * Форма вложений под карточкой: любой мастер прикладывает фото ISP/eMMC,
   * сервис-мануал, Repair Pictures или бюллетень. Публичная карточка — всем,
   * личная — только владельцу (права проверяет сервер; клиент лишь рисует).
   */
  private _mountAttachments(
    host: HTMLElement,
    kind: "file" | "personal",
    cardId: number,
    ownerTgId: number,
  ): void {
    const key = `${kind}:${cardId}`;
    let form = this.attachmentForms.get(key);
    if (!form) {
      form = new AttachmentForm(kind, cardId, {
        list: async (k, id) => {
          const res = await api.cardAttachmentList(k as never, id);
          return (res.attachments ?? []) as unknown as CardAttachmentItem[];
        },
        pickFile: () => this._pickAttachmentFile(),
        onPickOutcome: (outcome) => {
          const detail = outcome.status === "error" ? ` (${outcome.reason})` : "";
          this.log(
            `attachment pick: ${outcome.status}${detail}`,
            outcome.status === "picked" ? "info" : "warn",
          );
        },
        upload: (k, id, attKind, note, path) =>
          this._uploadAttachment(k, id, attKind, note, path),
        remove: async (k, id, attId) => {
          await api.cardAttachmentDelete(k as never, id, attId);
        },
        open: (item) => void this._openAttachment(kind, cardId, item),
        view: (item) => void this._viewAttachment(kind, cardId, item),
        canDelete: (item) => this._canDeleteAttachment(item, ownerTgId),
      });
      this.attachmentForms.set(key, form);
    }
    form.mount(host);
  }

  /**
   * Выбор файла вложения (любой тип: фото, PDF-мануал, архив).
   *
   * Три выхода ОБЯЗАТЕЛЬНЫ: `change` (выбрал), `cancel` (закрыл диалог) и
   * снятие input из DOM. Без `cancel` закрытие диалога оставляло промис
   * висеть навсегда — ни подсказки, ни строки в логе, ни RPC движку
   * (BUG-ATTACH-SILENT-001: 7 минут тишины). Input держим в DOM
   * (`display:none`): часть сборок Electron иначе не доставляет события выбора.
   */
  private _pickAttachmentFile(): Promise<{ path: string; name?: string } | null> {
    return new Promise((resolve) => {
      let settled = false;
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";
      const finish = (value: { path: string; name?: string } | null, why: string): void => {
        if (settled) return;
        settled = true;
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        input.remove();
        this.log(`attachment pick: ${why}`, why === "picked" ? "info" : "warn");
        resolve(value);
      };
      const onChange = (): void => {
        const file = input.files?.[0] as (File & { path?: string }) | undefined;
        const path = (file?.path ?? "").trim();
        // Пустой путь — не отмена: диалог дал файл, но Electron не отдал путь.
        if (!path) this.log("attachment pick: File.path is empty", "warn");
        finish(path ? { path, name: file?.name } : null, path ? "picked" : "no-path");
      };
      const onCancel = (): void => finish(null, "cancelled");
      input.addEventListener("change", onChange);
      input.addEventListener("cancel", onCancel);
      document.body.appendChild(input);
      this.log("attachment pick: open", "info");
      input.click();
    });
  }

  /** Полный цикл вложения: init → отправка своим TDLib → complete. */
  private async _uploadAttachment(
    kind: "file" | "personal",
    cardId: number,
    attKind: string,
    note: string,
    filePath: string,
  ): Promise<void> {
    const uploader = new AttachmentUploader({
      init: (k, id, ak, n) => api.cardAttachmentInit(k as never, id, ak, n),
      startUpload: (args) => invoke<string>("tdlib_start_upload", args),
      waitUpload: (uploadId) => invoke("tdlib_wait_upload", { uploadId }),
      complete: (k, id, uploadId) => api.cardAttachmentComplete(k as never, id, uploadId),
    });
    await uploader.add(kind as never, cardId, filePath, attKind, note);
  }

  /** Скачать вложение: байты с токеном → `blob:` → сохранение на диск. */
  private async _openAttachment(
    kind: "file" | "personal",
    cardId: number,
    item: CardAttachmentItem,
  ): Promise<void> {
    try {
      const url = api.cardAttachmentUrl(kind as never, cardId, item.id);
      const blobUrl = await api.attachmentObjectUrl(url);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = item.original_name || `attachment-${item.id}`;
      a.click();
      // Освобождаем адрес после того, как браузер забрал байты.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.log(t("attachment.download_failed", { reason }), "warn");
      this.onNotify?.(t("attachment.download_failed", { reason }), "error");
    }
  }
  /** Показать полноразмерное изображение вложения в лайтбоксе. */
  private async _viewAttachment(
    kind: "file" | "personal",
    cardId: number,
    item: CardAttachmentItem,
  ): Promise<void> {
    try {
      const url = api.cardAttachmentUrl(kind as never, cardId, item.id);
      const blobUrl = await api.attachmentObjectUrl(url);
      openMediaLightbox(
        [{ fullUrl: blobUrl, thumbUrl: blobUrl, width: null, height: null }],
        0,
      );
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.log(t("attachment.download_failed", { reason }), "warn");
      this.onNotify?.(t("attachment.download_failed", { reason }), "error");
    }
  }



  /** Права на снятие: автор вложения или владелец карточки (остальное — сервер). */
  private _canDeleteAttachment(item: CardAttachmentItem, ownerTgId: number): boolean {
    const mine = getCurrentTgId();
    if (!(mine > 0)) return false;
    if (Number(item.author_tg_id || 0) === mine) return true;
    return ownerTgId > 0 && ownerTgId === mine;
  }

  /**
   * Диалог «Надіслати другові» (SP-33, D-175).
   *
   * Получатель выбирается из справочника мастеров ARTEL, у которых АКТИВНО
   * личное хранилище (файл зачисляется в него при приёме). Вёрстка — на токенах
   * темы (без инлайн-стилей): диалог обязан выглядеть одинаково во всех пресетах.
   */
  private async _openShareDialog(item: VaultFileItem): Promise<void> {
    const prevFocus = document.activeElement as HTMLElement | null;
    const fileName = item.original_name || this.cardTitle(item) || `#${item.id}`;
    const overlay = document.createElement("div");
    overlay.className = "vault-share-overlay";
    overlay.innerHTML = `
      <div class="vault-share-dialog" role="dialog" aria-modal="true"
           aria-label="${this.esc(t("vault.share_title"))}">
        <div class="vault-share-head">
          <div class="vault-share-title">${this.esc(t("vault.share_title"))}</div>
          <button type="button" class="vault-share-close"
            aria-label="${this.esc(t("common.close"))}">✕</button>
        </div>
        <div class="vault-share-file">
          <span aria-hidden="true">📄</span>
          <span class="vault-share-file-name">${this.esc(fileName)}</span>
          <span class="vault-share-badge">🔒 ${this.esc(t("vault.share_vault_active"))}</span>
        </div>
        <div class="vault-share-note">
          ${this.esc(t("vault.share_ttl_warning", { hours: 72 }))}
        </div>
        <div class="vault-share-note">${this.esc(t("vault.share_only_with_vault"))}</div>
        <input class="vault-share-search" type="text"
          placeholder="${this.esc(t("vault.share_search"))}"
          aria-label="${this.esc(t("vault.share_search"))}" />
        <div class="vault-share-list" aria-live="polite"></div>
      </div>`;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector<HTMLElement>(".vault-share-list");
    const inputEl = overlay.querySelector<HTMLInputElement>(".vault-share-search");
    if (!listEl || !inputEl) {
      overlay.remove();
      return;
    }

    let timer = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const close = () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      overlay.remove();
      prevFocus?.focus?.();
    };
    document.addEventListener("keydown", onKey);
    overlay
      .querySelector(".vault-share-close")
      ?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    let sending = false;
    const send = async (entry: DirectoryEntry) => {
      if (sending) return;
      sending = true;
      const buttons = listEl.querySelectorAll<HTMLButtonElement>(".vault-share-user");
      buttons.forEach((b) => (b.disabled = true));
      try {
        await api.vaultShare(item.id, entry.user_ref);
        close();
        this.log(`Shared personal #${item.id} → ${entry.display_name}`, "success");
        this.onNotify?.(
          t("vault.share_sent", {
            name: entry.display_name,
            file: item.original_name || "",
          }),
          "success",
        );
      } catch (e: any) {
        sending = false;
        buttons.forEach((b) => (b.disabled = false));
        this.log(`Share error: ${e?.message}`, "error");
        this.onNotify?.(
          t("vault.share_failed", { err: e?.message ?? String(e) }),
          "error",
        );
        // Получатель мог потерять хранилище между загрузкой списка и отправкой:
        // перечитываем справочник, чтобы «мёртвая» строка не висела.
        void load(inputEl.value);
      }
    };

    let epoch = 0;
    const renderState = (text: string, isError = false) => {
      listEl.innerHTML = `<div class="vault-share-state${isError ? " error" : ""}">${
        this.esc(text)
      }</div>`;
    };

    const render = (entries: DirectoryEntry[]) => {
      if (!entries.length) {
        renderState(
          inputEl.value.trim()
            ? t("vault.share_search_empty")
            : t("vault.share_no_vault_users"),
        );
        return;
      }
      listEl.innerHTML = entries
        .map((entry) => {
          const name = (entry.display_name || "").trim() || "—";
          const nick = (entry.username || "").trim().replace(/^@/, "");
          return `
          <button type="button" class="vault-share-user"
            data-ref="${this.esc(entry.user_ref)}">
            <span class="vault-share-avatar" aria-hidden="true">${
              this.esc(directoryInitials(name))
            }</span>
            <span class="vault-share-user-main">
              <span class="vault-share-user-name">${this.esc(name)}</span>
              ${nick ? `<span class="vault-share-user-nick">@${this.esc(nick)}</span>` : ""}
            </span>
            <span class="vault-share-badge" title="${this.esc(t("vault.share_vault_active"))}"
              aria-label="${this.esc(t("vault.share_vault_active"))}">🔒</span>
          </button>`;
        })
        .join("");
      listEl.querySelectorAll<HTMLElement>(".vault-share-user").forEach((node) => {
        const ref = node.dataset.ref || "";
        const entry = entries.find((e) => e.user_ref === ref);
        if (entry) node.addEventListener("click", () => void send(entry));
      });
    };

    const load = async (q: string) => {
      const mine = ++epoch;
      renderState(t("vault.share_loading"));
      try {
        const resp = await api.vaultDirectory(q);
        if (mine !== epoch) return;
        render(filterDirectory(resp?.items ?? [], q));
      } catch (e: any) {
        if (mine !== epoch) return;
        this.log(`Directory error: ${e?.message}`, "error");
        renderState(t("vault.share_load_failed"), true);
      }
    };

    inputEl.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(inputEl.value), 250);
    });
    inputEl.focus();
    await load("");
  }

  private renderVaultCard(item: VaultFileItem): void {
    const card = document.createElement("div");
    card.className = "search-result-card";
    // D-180: по этому id App находит только что принятую карточку.
    card.dataset.personalId = String(item.id);
    const sizeStr = item.size_bytes > 0 ? this.formatSize(item.size_bytes) : "—";
    const published = item.published_file_id != null;

    card.innerHTML = `
      <div class="search-result-header">
        <span class="search-result-id">#${item.id} ${this.esc(this.kindLabel(item))}</span>
        <span class="search-result-size">${sizeStr}</span>
      </div>
      <div class="search-result-title">
        ${this.esc(this.cardTitle(item))}
      </div>
      <div class="search-result-meta">
        <span>📄 ${this.esc(item.original_name || "—")}</span>
        <span>${published
          ? this.esc(t("vault.card_published", { id: item.published_file_id as number }))
          : this.esc(t("vault.card_personal"))}</span>
      </div>
      ${item.description ? `<div class="search-result-desc">${this.esc(item.description)}</div>` : ""}
      <div class="search-result-media"></div>
      <div style="margin-top:8px;">
        <button class="btn btn-primary vault-download-btn" data-id="${item.id}"
          style="width:100%;">${this.esc(t("vault.card_download"))}</button>
      </div>
      ${this._cardToolsRowHtml(
        "personal",
        item.id,
        `<button class="btn btn-secondary vault-publish-btn" data-id="${item.id}"${
          published ? ' style="display:none;"' : ""
        }>${this.esc(t("vault.card_publish"))}</button>` +
          `<button class="btn btn-secondary vault-share-btn" data-id="${item.id}">` +
          `${this.esc(t("vault.card_share"))}</button>`,
      )}
      <div class="card-tools-row">
        <button class="btn btn-secondary vault-delete-btn" data-id="${item.id}"
          style="color:var(--error);">${this.esc(t("vault.card_delete"))}</button>
      </div>
      <div class="vault-attachment-host" style="margin-top:8px;"></div>
    `;

    // Медиа личной карточки (SP-15 v3): подтягиваем и рисуем галерею превью.
    void this._hydrateVaultMedia(card, item.id);
    this._wireAddMedia(card, "personal", item.id);
    this._wireEdit(card, "personal", item.id);

    // SP-20 (D-094): вложения личной карточки — только её владельцу (сервер 403).
    const attHost = card.querySelector<HTMLElement>(".vault-attachment-host");
    if (attHost) {
      this._mountAttachments(attHost, "personal", item.id, getCurrentTgId());
    }

    card.querySelector(".vault-download-btn")?.addEventListener("click", () => {
      if (this.onPersonalDownloadFile) {
        this.onPersonalDownloadFile(item.id);
      } else {
        this.log("Personal download unavailable (handler not wired)", "warn");
      }
    });

    card.querySelector(".vault-publish-btn")?.addEventListener("click", async () => {
      try {
        const resp = await api.vaultPublish([item.id]);
        // Publish может вернуть per-file error (host-copy failed) с HTTP 200.
        const res = resp?.results?.[0];
        if (res && res.error) {
          // SP-34/D-184: сервер віддає КОД причини — показуємо локалізований
          // текст, а англійська технічна строка (`res.error`) лишається в лозі.
          // Без кодів майстер бачив «Personal file has no bot-side file_id yet…»
          // і не знав, що робити (почекати чи завантажити ще раз).
          const codeMsg = res.error_code === "personal_anchor_pending"
            ? t("search.publish_anchor_pending", { id: item.id })
            : res.error_code === "personal_anchor_lost"
              ? t("search.publish_anchor_lost", { id: item.id })
              : null;
          const msg = codeMsg ?? t("search.publish_failed", { id: item.id, err: res.error });
          this.log(
            `Publish #${item.id} failed: ${res.error} (code=${res.error_code ?? "-"})`,
            "error",
          );
          this.onNotify?.(msg, codeMsg ? "info" : "error");
        } else if (res && res.duplicate && res.file_id != null) {
          // BUG-PUBLISH-DEDUP-002: дедуп (политика dedup.mode) — такой файл уже есть
          // в каталоге, новая карточка НЕ создана; личный файл привязан к
          // существующей публикации. Показываем заметное уведомление (как в паблик).
          this.log(
            `Duplicate: file already in catalog (File #${res.file_id}), personal #${item.id} linked`,
            "warn",
          );
          this.onNotify?.(
            t("search.publish_duplicate", { id: item.id, file: res.file_id }),
            "info",
          );
        } else if (res && res.file_id != null) {
          this.log(`Published #${item.id} -> File #${res.file_id}`, "success");
          this.onNotify?.(t("search.publish_ok", { id: item.id, file: res.file_id }), "success");
        } else {
          this.log(`Publish #${item.id}: empty result`, "error");
          this.onNotify?.(t("search.publish_empty", { id: item.id }), "error");
        }
      } catch (e: any) {
        this.log(`Publish error: ${e.message}`, "error");
        this.onNotify?.(t("search.publish_error", { err: e?.message ?? String(e) }), "error");
      }
      await this.doPersonalSearch();
    });
    // SP-33/D-175: «Отправить другу» — выбор получателя из справочника ARTEL.
    card.querySelector(".vault-share-btn")?.addEventListener("click", () => {
      void this._openShareDialog(item);
    });

    card.querySelector(".vault-delete-btn")?.addEventListener("click", async () => {
      // Если файл опубликован — удаляется ТОЛЬКО личная копия; публикация в
      // общем каталоге остаётся (её может удалить только админ).
      const msg = published
        ? t("search.delete_confirm_published", {
            id: item.id,
            pub: item.published_file_id as number,
          })
        : t("search.delete_confirm_personal", { id: item.id });
      if (!confirm(msg)) return;
      let pmDelete: { chat_id: number; message_ids: number[] } | null = null;
      let removed = false;
      try {
        const resp = await api.vaultDelete(item.id);
        removed = true;
        pmDelete = resp?.pm_delete?.chat_id ? resp.pm_delete : null;
        if (resp?.already_deleted) {
          // Идемпотентный повтор: сервер уже удалял запись (BUG-PERSONAL-DELETE-001).
          this.log(`Personal file #${item.id} already deleted (server)`, "warn");
        } else {
          this.log(`Personal file #${item.id} deleted from personal storage`, "warn");
        }
      } catch (e: any) {
        if (e?.status === 404) {
          // Сервер отвечает 404, если запись уже удалена, а карточка осталась в
          // поисковом индексе («призрак»): это успех — обновляем список ниже.
          removed = true;
          this.log(`Personal file #${item.id} already deleted on server (404)`, "warn");
        } else {
          this.log(`Delete error: ${e.message}`, "error");
        }
      }
      if (removed) {
        // Карточка обязана исчезнуть СРАЗУ, независимо от лага поискового
        // индекса (BUG-PERSONAL-DELETE-001): прячем id во всех будущих
        // перечитываниях личного списка (id-шники serial — повторов не бывает).
        this._hiddenPersonalIds.add(item.id);
      }
      // Self-delete своего PM-сообщения (файл физически в PM юзера; сервер не
      // может удалить чужое сообщение). Best-effort: ошибка не фатальна.
      if (pmDelete && pmDelete.message_ids.length > 0) {
        try {
          await invoke("tdlib_delete_messages", {
            chatId: pmDelete.chat_id,
            messageIds: pmDelete.message_ids,
          });
          this.log(`PM cleanup: deleted ${pmDelete.message_ids.length} message(s)`, "info");
        } catch (err: any) {
          this.log(
            `PM self-delete failed: ${err?.message || String(err)}`,
            "warn",
          );
        }
      }
      await this.doPersonalSearch();
    });

    this.resultsContainer.appendChild(card);
  }

  /** Карточка в выдаче поиска — тонкая обёртка над единым рендерером. */
  private renderResultCard(item: SearchResultItem): void {
    this.resultsContainer.appendChild(this._buildResultCard(item));
  }

  /**
   * ПОЛНАЯ карточка файла — единственный рендерер (D-136). Её видят и выдача
   * поиска, и переход «из чата в карточку»: поля формы, медиа, скачивание,
   * обсуждение, отзывы, сводка + вложения. Вторая копия разметки запрещена —
   * гейт `tests/focus-card-full.test.ts`.
   */
  private _buildResultCard(item: SearchResultItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "search-result-card";

    // Uploader info: имя + ID (tg_id, если сервер его отдал)
    const uploaderName = uploaderDisplayName(item.uploader);
    const uploaderKey = uploaderLabelKey(item.uploader);

    const sizeStr = item.size_bytes > 0 ? this.formatSize(item.size_bytes) : "—";

    // ── ВСЕ поля upload-формы (включая пустые — показываем "—") ──
    // Это даёт пользователю полную картину метаданных файла,
    // даже если часть полей не была заполнена при загрузке.
    const ALL_FORM_FIELDS: Array<{ key: keyof SearchResultItem; labelKey: string; icon: string }> = [
      { key: "device_category", labelKey: "search.field.category", icon: "📂" },
      { key: "chassis",        labelKey: "search.field.chassis", icon: "🖥️" },
      { key: "chipset",        labelKey: "search.field.chipset", icon: "🔲" },
      { key: "memory_type",    labelKey: "search.field.memory_type", icon: "💾" },
      { key: "firmware_type",  labelKey: "search.field.firmware_type", icon: "⚡" },
      { key: "source_status",  labelKey: "search.field.source_status", icon: "📡" },
      { key: "programmer",     labelKey: "search.field.programmer", icon: "🔧" },
      { key: "panel_model",    labelKey: "search.field.panel_model", icon: "📺" },
    ];

    const formFields: Array<{ label: string; value: string; icon: string }> = [];
    for (const fdef of ALL_FORM_FIELDS) {
      const raw = item[fdef.key];
      const val = (typeof raw === "string" && raw.trim().length > 0) ? raw : "—";
      formFields.push({ label: tLoose(fdef.labelKey), value: val, icon: fdef.icon });
    }

    // Рендерим строки полей
    let fieldsHtml = "";
    for (const f of formFields) {
      const valClass = f.value === "—" ? ' class="field-empty"' : '';
      fieldsHtml += `<span${valClass}><span class="field-icon">${f.icon}</span> ${this.esc(f.label)}: <strong>${this.esc(f.value)}</strong></span>`;
    }

    card.innerHTML = `
      <div class="search-result-header">
        <span class="search-result-id">#${item.id} ${this.esc(this.kindLabel(item))}</span>
        <span class="search-result-size">${sizeStr}</span>
      </div>
      <div class="search-result-title">
        ${this.esc(this.cardTitle(item))}
      </div>
      <div class="search-result-meta">
        <span>📄 ${this.esc(item.original_name || "—")}</span>
        <span>${this.esc(
          t(uploaderKey, {
            name: uploaderName,
            tg_id: item.uploader?.tg_id ?? "",
          }),
        )}</span>
      </div>
      ${item.description ? `<div class="search-result-desc">${this.esc(item.description)}</div>` : ""}
      <div class="search-result-media"></div>
      <div class="search-result-fields">${fieldsHtml}</div>
      <div style="margin-top:8px;">
        <button class="btn btn-primary search-dl-btn" data-file-id="${item.id}" style="width:100%;">
          ${this.esc(t("common.download_btn", { id: item.id }))}
        </button>
      </div>
      ${this._isOwnPublicCard(item) ? this._cardToolsRowHtml("file", item.id) : ""}
      <button type="button" class="btn btn-secondary community-discuss" data-i18n="community.discuss" style="margin-top:8px;">${this.esc(t("community.discuss"))}</button>
      <div class="file-reviews-host"></div>
      <div class="search-summary-host" data-file-id="${item.id}" style="margin-top:8px;"></div>
    `;

    // Медиа карточки (SP-15 v3/v5): у СВОЕЙ карточки берём владельческий список
    // (с якорями) — Desktop качает байты своим TDLib, без потолка Bot API 20 МБ.
    // Чужая публичная карточка — превью из индекса (без токена, тег `<img>`).
    void this._attachOwnOrIndexMedia(card, item);
    this._wireAddMedia(card, "file", item.id);
    this._wireEdit(card, "file", item.id);

    card.querySelector(".community-discuss")?.addEventListener("click", () => this.onDiscussion?.(item.id));
    let reviews = this.fileReviews.get(item.id);
    if (!reviews) reviews = new FileReviews({
      load: before => api.communityReviews(item.id, before),
      send: intent => api.communityReview(item.id, intent),
      remove: id => api.communityDelete(id), isActive: () => true,
    });
    reviews.mount(card.querySelector<HTMLElement>(".file-reviews-host")!);
    this.fileReviews.set(item.id, reviews);

    // Клик по кнопке — переключаем на вкладку Download
    const dlBtn = card.querySelector(".search-dl-btn") as HTMLButtonElement;
    dlBtn.addEventListener("click", () => {
      this.onDownloadFile(item.id);
    });

    // SP-19 S1b (D-087): сводка по файлу + «что ещё скачать по этому аппарату».
    // Сводка уже собрана фоном на сервере (`GET /card` — чтение кеша, без зовов
    // модели: прежние ~147 с ожидания ушли), список файлов строит SQL.
    const summaryHost = card.querySelector(
      ".search-summary-host",
    ) as HTMLElement | null;
    if (summaryHost) {
      let summary = this.summaryBlocks.get(item.id);
      if (!summary) {
        summary = new SummaryBlock(item.id, {
          loadCard: (id) => api.chatCard(id),
          onDownload: (id) => this.onDownloadFile(id),
          // SP-19 S4: опыт мастера («что помогло») уходит на сервер, ответ —
          // свежий блок (голоса и «Проверено» считает сервер, не клиент).
          submitForm: async (helped, text) =>
            api.summaryFeedback(item.id, helped, text),
        });
        this.summaryBlocks.set(item.id, summary);
      }
      summary.mount(summaryHost);
      // SP-20 (D-094): форма вложений — рядом со сводкой в том же хосте.
      // Публичная карточка: прикладывать может любой мастер (права — сервер).
      this._mountAttachments(
        summaryHost,
        "file",
        item.id,
        Number(item.uploader?.tg_id ?? 0),
      );
    }

    return card;
  }

  /**
   * Панель фасетов: группы top-N значений со счётчиками, кликабельные чипы.
   *
   * - `_lastFacets === null` → панель скрыта (legacy-режим / нет данных);
   * - `facetDistribution` сервер считает ПОСЛЕ применённых фильтров →
   *   выбор «kind» сужает счётчики брендов (эффект дерева kind→brand→…);
   * - активные значения вне top-N добавляются (FacetQuery) — выбор всегда
   *   можно снять.
   */
  private _renderFacets(): void {
    if (!this.facetsEl) return;

    if (!this._lastFacets) {
      this.facetsEl.style.display = "none";
      this.facetsEl.innerHTML = "";
      return;
    }

    const groups = facetGroups(
      this._lastFacets,
      SearchPage.FACET_FIELDS,
      this._selection,
    );
    const activeCount = countActive(this._selection);

    if (groups.length === 0 && activeCount === 0) {
      this.facetsEl.style.display = "none";
      this.facetsEl.innerHTML = "";
      return;
    }

    const clearHtml = activeCount
      ? `<button class="facet-clear" data-clear="1">${this.esc(t("search.facets_clear"))}</button>`
      : "";

    let html = `<div class="facet-panel"><h4><span>${this.esc(t("search.facets_title"))}${activeCount ? ` · ${activeCount}` : ""}</span>${clearHtml}</h4>`;

    for (const g of groups) {
      html += `<div class="facet-group"><div class="facet-group-title">${this.esc(this.facetLabel(g.field))}</div>`;
      for (const o of g.options) {
        // Подпись — каноническая (facetLabels); data-value остаётся СЫРЫМ
        // значением индекса: на нём работает клик-хендлер и Meili-фильтр.
        html += `<button class="facet-option${o.active ? " active" : ""}" data-field="${this.esc(g.field)}" data-value="${this.esc(o.value)}">
          <span>${this.esc(facetOptionLabel(g.field, o.value))}</span><span class="facet-count">${o.count}</span>
        </button>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    this.facetsEl.innerHTML = html;
    this.facetsEl.style.display = "block";
  }

  /**
   * Перерисовать статус и результаты после смены языка.
   *
   * ВАЖНО: перерисовываем ВСЕГДА, независимо от активности вкладки —
   * иначе неактивные вкладки «залипают» на старом языке до их повторного
   * открытия (инцидент: «язык переключается только после возврата на вкладку»).
   * Рендер из сохранённого состояния (_lastStatus/_lastResults) дешёвый.
   */
  /** Очистка результатов со снятием блоков сводки (тики не должны жить без DOM). */
  resetCommunity(): void {
    this.focusEpoch++;
    this.focusedFileId = null;
    this.focusFromCommunity = false;
    this.clearFocusCard();
    this.resultsContainer?.querySelectorAll("[data-return-community]").forEach(chip => chip.remove());
    for (const reviews of this.fileReviews.values()) reviews.unmount();
    this.fileReviews.clear();
    this.resultsContainer?.querySelectorAll(".file-reviews-host").forEach(host => {host.innerHTML="";});
  }

  private _clearResults(preserveCommunity=false): void {
    const focusHost = preserveCommunity ? this.focusHost : null;
    if (preserveCommunity) {
      for (const reviews of this.fileReviews.values()) reviews.unmount();
    } else this.resetCommunity();
    // SP-19 S1b: блоки сводки живут в DOM карточек — снимаем вместе с ними.
    for (const block of this.summaryBlocks.values()) block.unmount();
    this.summaryBlocks.clear();
    // SP-20 (D-094): формы вложений — тот же инвариант (нечего держать без DOM).
    for (const form of this.attachmentForms.values()) form.unmount();
    this.attachmentForms.clear();
    // DOM карточек сейчас исчезнет — вместе с ним освобождаем blob-адреса
    // защищённых превью (иначе утечка до перезапуска окна).
    if (this._mediaBlobs.length) revokeObjectUrls(this._mediaBlobs);
    this._mediaBlobs = [];
    this._cardMediaBlobs = new WeakMap<HTMLElement, string[]>();
    this.resultsContainer.innerHTML = "";
    if (focusHost) this.resultsContainer.prepend(focusHost);
  }

  private restoreFocusedCard(): void {
    if (this.focusedFileId === null) return;
    const button = this.resultsContainer.querySelector<HTMLButtonElement>(`.search-dl-btn[data-file-id="${this.focusedFileId}"]`);
    const card = button?.closest<HTMLElement>(".search-result-card");
    if (!card) return;
    if (this.focusHost?.contains(card) && button) button.textContent = t("common.download_btn", { id: this.focusedFileId });
    if (this.focusFromCommunity) this._attachReturnChip(card);
  }

  applyLang(): void {
    for (const reviews of this.fileReviews.values()) reviews.applyLang();
    // SP-19 S1b: подписи блока сводки («Источники», «та же модель») — из i18n.
    for (const block of this.summaryBlocks.values()) block.applyLang();
    // SP-20 (D-094): подписи формы вложений — тоже из i18n (без сброса ввода).
    for (const form of this.attachmentForms.values()) form.applyLang();
    const s = this._lastStatus;
    if (s) {
      if (s.kind === "searching") {
        this.searchStatus.textContent = t("search.searching");
        this.searchStatus.className = "search-status";
      } else if (s.kind === "not_found") {
        this.searchStatus.textContent = t("search.not_found", { query: s.query });
        this.searchStatus.className = "search-status error";
      } else if (s.kind === "found") {
        this.searchStatus.textContent = t("search.found", { n: s.n });
        this.searchStatus.className = "search-status success";
      } else if (s.kind === "found_personal") {
        this.searchStatus.textContent = t("search.personal_found", { n: s.n });
        this.searchStatus.className = "search-status success";
      } else if (s.kind === "empty_personal") {
        this.searchStatus.textContent = t("search.empty_personal");
        this.searchStatus.className = "search-status";
      } else if (s.kind === "min_chars") {
        this.searchStatus.textContent = t("search.min_chars");
        this.searchStatus.className = "search-status";
      } else if (s.kind === "catalog") {
        this.searchStatus.textContent = t("search.tree_total", { n: s.n });
        this.searchStatus.className = "search-status success";
      } else if (s.kind === "catalog_empty") {
        this.searchStatus.textContent = t("search.tree_empty");
        this.searchStatus.className = "search-status";
      } else if (s.kind === "error") {
        this.searchStatus.textContent = t("search.error", { err: s.err });
        this.searchStatus.className = "search-status error";
      }
    }

    // Панель фасетов: подписи групп из i18n → перерисовка при смене языка.
    this._renderFacets();

    // Перерисовка результатов по режиму последнего рендера:
    // public-каталог и личный кабинет рендерятся РАЗНЫМИ карточками.
    if (this._lastMode === "tree") {
      // Дерево: подписи папок (kind — бейдж) и крошек локализуются заново.
      this._renderTree(true);
      this.restoreFocusedCard();
      return;
    }

    if (this._lastMode === "vault") {
      if (this._lastVaultResults) {
        this._clearResults(true);
        for (const item of this._lastVaultResults) {
          this.renderVaultCard(item);
        }
      }
      this.restoreFocusedCard();
      return;
    }

    if (this._lastResults) {
      this._clearResults(true);
      for (const item of this._lastResults) {
        this.renderResultCard(item);
      }
    }
    this.restoreFocusedCard();
  }

  private esc(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}
