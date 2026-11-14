import { ChatNotifications } from "./ChatNotifications";
import { chatSoundUrl } from "./chatSoundUrls";
import { ChatSoundPlayer } from "./ChatSoundPlayer";
import type { ChatSoundId } from "../../shared/chatSettings";
import { SettingsPage } from './SettingsPage';
import { normalizeTheme, themeAttrValue } from './ThemePresets';
import { ActivityHeartbeat } from './ActivityHeartbeat';
/**
 * Главный модуль UI — управление вкладками, авторизацией,
 * состоянием подключения.
 *
 * Flow (v3.0 — TDLib auth):
 *   1. main.ts вызывает tdlib_start_runtime() до создания App.
 *   2. При запуске (init) — проверяем store на наличие сохранённой API-сессии.
 *   3. Затем TdlibAuthPage.checkAndShow():
 *      - Если TDLib уже авторизован (сохранённая сессия) → onAuthenticated().
 *      - Иначе → показать authPage с выбором QR/телефон.
 *   4. После успешной TDLib авторизации → onAuthenticated().
 *   5. Кнопка "Выйти" → disconnect() → tdlib_logout() (auth.logOut, каталог
 *      состояния СОХРАНЯЕТСЯ: future-auth-token → мгновенный повторный вход)
 *      + очистка API сессии.
 *   6. При 401 от API → вызывается forceReauth().
 *
 * v3.6 — Единая авторизация:
 *   Все модули используют централизованное состояние из auth.ts.
 *   App.ts устанавливает флаг через setAppAuthenticated() после
 *   успешного TDLib auth, а модули проверяют через requireAuth().
 *   Auth происходит ОДИН раз при входе и работает для ВСЕХ модулей.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { store } from "../store";
import { UploadPage } from "./UploadPage";
import { DownloadPage } from "./DownloadPage";
import { SearchPage } from "./SearchPage";
import { TdlibAuthPage } from "./TdlibAuthPage";
import { BillingPage } from "./BillingPage";
import { CommunityPage } from "./CommunityPage";
import { FaqPage } from "./FaqPage";
import { OwnerPage } from "./OwnerPage";
import { ArchivePage } from "./ArchivePage";
import { ToolsPage } from "./ToolsPage";
import { setTdlibUserAuthorized } from "../tdlibAuth";
import { setAppAuthenticated, getCurrentTgId } from "../auth";
import { t, tLoose, subscribe, applyStaticI18n } from "../i18n";
import { syncTabTitles, layoutTabStrip, enableTabStripWheelScroll } from "./TabLabels";
import { setVaultEntitlement, setVaultScope, isPersonalScope, isVaultEntitled, subscribeVault } from "../vaultMode";
import { ShareInbox } from "./ShareInbox";
import {
  promptRemoveChatCopy,
  removePersonalChatCopy,
} from "./vaultCleanup";
import { liveChatCopyRemovalDeps } from "./vaultCleanupWiring";
import { setOwner, isOwner } from "../ownerMode";
import {
  newHeaderBalance,
  beginHeaderFetch,
  settleHeaderFetch,
  endHeaderFetch,
  applyHeaderPush,
  headerHint,
  resetHeaderBalance,
  HeaderBalanceState,
} from "./headerBalance";

export class App {
  private uploadPage: UploadPage;
  private downloadPage: DownloadPage;
  private searchPage: SearchPage;
  private tdlibAuthPage: TdlibAuthPage;
  private billingPage: BillingPage;
  private faqPage: FaqPage;
  private communityPage: CommunityPage;
  private settingsPage: SettingsPage;
  private chatNotifications: ChatNotifications;
  private activityHeartbeat = new ActivityHeartbeat(() => api.communityHeartbeat());
  private ownerPage!: OwnerPage;
  private archivePage!: ArchivePage;
  private toolsPage!: ToolsPage;

  // DOM рефы
  private mainSection!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private logoutBtn!: HTMLElement;
  // v4.1: Пилюли нового header — скрыты в HTML через display:none,
  // показываются только после успешной авторизации.
  private userPill!: HTMLElement;
  private pointsPill!: HTMLElement;
  // Версия клиента в шапке
  private versionPill!: HTMLElement;
  private versionText!: HTMLElement;
  // Прогресс обновления в шапке
  private updateProgress!: HTMLElement;
  private updateProgressBar!: HTMLElement;
  private updateProgressText!: HTMLElement;
  // Личное хранилище (Vault)
  private vaultToggle!: HTMLElement;
  private vaultToggleLabel!: HTMLElement;
  private vaultBanner!: HTMLElement;
  /** SP-33/D-180: компактные входящие передачи личных файлов (шапка + поповер). */
  private shareInbox!: ShareInbox;
  /**
   * Личные файлы, копию которых юзер решил ОСТАВИТЬ в чате с ботом
   * (решение владельца 2026-11-10) — больше не спрашиваем в этой сессии.
   */
  private readonly _chatCopyKeep = new Set<number>();
  // Owner-backdoor (T6.4): скрытая вкладка владельца
  private ownerTabBtn!: HTMLElement;
  // Баннер режима показываем только после авторизации (когда виден переключатель).
  private _vaultUiShown: boolean = false;

  // Состояние auth — централизовано в auth.ts (setAppAuthenticated / isFullyAuthenticated)
  private currentTgId: number = 0;
  private currentUsername: string = "";

  // i18n: состояние для перерисовки user-facing header при смене языка на лету
  private _lastConnected: boolean | null = null;
  private _lastUsername: string = "";
  private _lastBalance: {
    balance: number;
    banned: boolean;
    banReason: string | null;
    unlimited: boolean;
  } | null = null;

  // Состояние заголовка баланса без мигания (D-BP-5): «⏳» только пока значение
  // не известно ни разу; _refetchQueued — перезапрос, пришедший во время in-flight.
  private _hb: HeaderBalanceState = newHeaderBalance();
  private _refetchQueued: boolean = false;

  // Billing WebSocket
  private wsBilling: WebSocket | null = null;
  private wsBillingReconnectTimer: number | null = null;
  // Billing polling fallback (периодический опрос, если WS не работает)
  private _billingPollTimer: number | null = null;
  // Последний известный баланс — для детекта изменения через polling
  private _lastKnownBalance: number = -1;
  // Последняя известная ревизия пакетов магазина — polling fallback для packages_update
  private _lastPackagesRevision: number = -1;

  /**
   * BUG-AUTH-SAFETY-001: App принимает safetyTimer ID от main.ts для передачи
   * в TdlibAuthPage. Таймер очищается при первом tdlib-auth-state событии,
   * а НЕ в finally main.ts — иначе TDLib может не успеть прислать ответ за 20с.
   */
  private _safetyTimer: ReturnType<typeof setTimeout>;

  constructor(safetyTimer: ReturnType<typeof setTimeout>) {
    this._safetyTimer = safetyTimer;
    this.uploadPage = new UploadPage(
      () => this.currentTgId || getCurrentTgId(),
      // Успешный /complete → личный кабинет должен перечитать свой список
      // (BUG-CABINET-STALE-001); пользователь остаётся на вкладке «Завантажити».
      () => this.onUploadComplete(),
      // BUG-CANCEL-FINAL-001: общий кеш TDLib — отмена upload не должна
      // сносить кеш активного скачивания (см. JanitorPolicy).
      () => this.downloadPage.isTransferActive(),
    );
    this.downloadPage = new DownloadPage(
      () => this.currentTgId || getCurrentTgId(),
      () => this.fetchAndShowBalance(),
      // BUG-CANCEL-FINAL-001: кеш TDLib общий для обеих вкладок — отмена
      // download не должна сносить кеш активного upload (и наоборот).
      () => this.uploadPage.isUploadActive(),
    );
    // Файл забрали на диск → предлагаем убрать копию из чата с ботом
    // (решение владельца 2026-11-10).
    this.downloadPage.onPersonalDownloaded = (pfId: number) => {
      this._offerRemoveChatCopy(pfId);
    };
    this._applyChatSound(this.chatSounds.id);
    this.chatNotifications=new ChatNotifications({
      load:(after,maximum,signal)=>api.communityNotifications(after,maximum,signal),
      call:invoke,listen:async(name,cb)=>listen(name,e=>cb(e.payload)),
      reading:()=>this.communityPage?.readingState() ?? {thread_id:null,pinned:false},
      windowChanged:()=>this.communityPage?.reportReading(),
      openThread:id=>{this._switchTab("community");void this.communityPage.openThread(id);},
      unread:count=>{
        const tab=document.querySelector<HTMLElement>('[data-tab="community"]');
        tab?.classList.toggle('has-unread',count>0);
        const badge=tab?.querySelector<HTMLElement>('.chat-tab-unread');
        if(badge) {badge.hidden=count===0;badge.textContent=String(count);}
      },
      sound:()=>this._playChatSound(),
      stopSound:()=>this._stopChatSounds(),
      labels:()=>({open:t("notifications.open"),exit:t("notifications.exit"),messages:t("notifications.messages"),general:t("community.general")}),
      multipleTitle:n=>t("notifications.multiple",{n}),
    });
    this.settingsPage = new SettingsPage(document.getElementById("settingsContainer")!, {
      get:()=>invoke("chat_settings_get"), save:value=>invoke("chat_settings_set",{...value}),
      // Проба: мастер выбирает звук на слух. Выбор применяется сразу (onSaved),
      // поэтому сохранённый звук слышен в следующем уведомлении без перезапуска.
      preview:id=>this._playChatSound(id),
      onSaved:value=>this._applyChatSound(value.sound_id),
    });
    this.communityPage = new CommunityPage(document.getElementById("communityContainer") ?? document.createElement("div"), {
      byId:id=>api.communityThreadById(id),
      isWindowFocused:()=>{const state=this.chatNotifications.window;return state.visible && state.focused && !state.minimized;},
      reading:()=>this.chatNotifications.syncReading(),
      ensure: id => api.communityThread(id), feed: offset => api.communityFeed(offset),
      presence: offset => api.communityPresence(offset),
      messages: (id,before) => api.communityMessages(id,before), send: (id,intent) => api.communitySend(id,intent),
      read: (id,last) => api.communityRead(id,last), remove: id => api.communityDelete(id),
      // D-135: чип «Открыть карточку» в чате — прыжок на карточку с возвратом.
      openCard: fileId => { this._switchTab("search"); void this.searchPage.focusCard(fileId, { fromCommunity: true }); },
    });
    this.searchPage = new SearchPage(
      (fileId: number) => this.onSearchDownload(fileId),
      (pfId: number) => this.onPersonalSearchDownload(pfId),
      (message: string, type: "success" | "error" | "info") => this.showToast(message, type),
      (fileId: number) => { this._switchTab("community"); void this.communityPage.openFile(fileId); },
      () => this._switchTab("community"), // D-135: чип возврата на открытый чат
    );
    this.tdlibAuthPage = new TdlibAuthPage(
      () => this.onTdlibAuthenticated(),
      this._safetyTimer,
    );
    this.billingPage = new BillingPage(
      document.getElementById("billingContainer")!,
      () => this.currentTgId || getCurrentTgId(),
      (message: string, type: "success" | "error" | "info") => this.showToast(message, type),
      () => this.fetchAndShowBalance(),  // onBalanceUpdate — после оплаты сразу обновить баланс
    );

    // FAQ (справка клиента): публичный эндпоинт, контент грузится лениво —
    // первый запрос уходит при открытии вкладки (см. bindEvents → ensureLoaded).
    // Если вёрстка без #faqContainer — рисуем в оффскрин-элементе, чтобы не
    // ронять конструктор (как сделано для OwnerPage).
    const faqContainer = document.getElementById("faqContainer");
    this.faqPage = new FaqPage((faqContainer as HTMLElement) ?? document.createElement("div"));

    // Owner-backdoor (T6.4): контейнер вкладки Owner. Если вёрстка вдруг без
    // #ownerContainer — рисуем в оффскрин-элементе, чтобы не ронять конструктор.
    const ownerContainer = document.getElementById("ownerContainer");
    this.ownerPage = new OwnerPage(
      (ownerContainer as HTMLElement) ?? document.createElement("div"),
      {
        onDownload: (targetTgId: number, pfId: number, name: string) =>
          this.onOwnerDownload(targetTgId, pfId, name),
        onToast: (message: string, type?: "success" | "error" | "info") =>
          this.showToast(message, type),
      },
    );

    // Archiver (Фаза 3): вкладка ручной упаковки/распаковки локальных архивов.
    // Если вёрстка без #archiveContainer — рисуем в оффскрин-элементе, чтобы
    // не ронять конструктор (как для FAQ/Owner).
    const archiveContainer = document.getElementById("archiveContainer");
    this.archivePage = new ArchivePage(
      (archiveContainer as HTMLElement) ?? document.createElement("div"),
    );

    // Інструменти (GEO Unlock, D-148/D-150): локальні правки дампів Samsung/LG.
    // Розмітка статична в index.html (data-i18n), тут — лише поведінка; якщо
    // контейнера немає — оффскрін-елемент, щоб не роняти конструктор.
    const toolsContainer = document.getElementById("toolsContainer");
    this.toolsPage = new ToolsPage(
      (toolsContainer as HTMLElement) ?? document.createElement("div"),
    );


    // Применить сохранённую тему оформления (класс data-theme на <html>).
    this._applyTheme();

    // D-170: равные ширины вкладок зависят от метрик подписей (шрифт, язык,
    // тема с другим letter-spacing) и от ширины окна. Пересчёт: на старте,
    // при resize (с дебаунсом), после загрузки шрифтов и при смене темы
    // (атрибут data-theme ставит кто угодно — ловим наблюдателем).
    layoutTabStrip();
    // D-170: колесо мыши над панелью вкладок скроллит её по горизонтали
    // (один раз — обработчик идемпотентен по data-атрибуту).
    enableTabStripWheelScroll();
    let tabLayoutTimer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener("resize", () => {
      clearTimeout(tabLayoutTimer);
      tabLayoutTimer = setTimeout(() => layoutTabStrip(), 120);
    });
    document.fonts.ready.then(() => layoutTabStrip());
    new MutationObserver(() => layoutTabStrip()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  /**
   * Применить сохранённый пресет оформления к документу.
   * Базовый пресет (`artel`) живёт в :root и атрибута не ставит.
   */
  private _applyTheme(): void {
    const theme = normalizeTheme(store.getTheme());
    const attr = themeAttrValue(theme);
    if (attr) document.documentElement.dataset.theme = attr;
    else document.documentElement.removeAttribute('data-theme');
  }

  /**
   * Чип активной передачи на вкладке поиска (Phase 3, гибридный старт).
   * Показывается, пока DownloadPage ведёт передачу; клик → вкладка передачи.
   */
  private _updateTransferChip(): void {
    const chip = document.getElementById("searchTransferChip");
    if (!chip) return;
    const active = this.downloadPage.isTransferActive();
    chip.style.display = active ? "inline-flex" : "none";
    if (active) chip.textContent = tLoose("search.transfer_active");
  }

  /**
   * Показать всплывающее toast-уведомление.
   * Уведомление автоматически исчезает через 5 секунд.
   */
  public showToast(message: string, type: "success" | "error" | "info" = "info"): void {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Авто-удаление через 5 секунд с анимацией
    setTimeout(() => {
      toast.classList.add("toast-hiding");
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 350);
    }, 5000);
  }

  /**
   * Предложение убрать копию личного файла из чата с ботом (после скачивания).
   *
   * Честно предупреждаем: файл пропадёт из ARTEL и повторно скачать его
   * уже нельзя (копии в чате не будет). «Оставить» запоминаем — в этой
   * сессии больше не спрашиваем про этот файл.
   */
  private _offerRemoveChatCopy(pfId: number): void {
    if (this._chatCopyKeep.has(pfId)) return;
    promptRemoveChatCopy({
      text: t("vault.chat_copy_offer_text"),
      removeLabel: t("vault.chat_copy_remove"),
      keepLabel: t("vault.chat_copy_keep"),
      onRemove: () => void this._removeChatCopy(pfId),
      onKeep: () => {
        this._chatCopyKeep.add(pfId);
      },
    });
  }

  /** Убрать копию: запись в ARTEL + сообщения-документы в PM. */
  private async _removeChatCopy(pfId: number): Promise<void> {
    try {
      const res = await removePersonalChatCopy(pfId, liveChatCopyRemovalDeps());
      if (res.removed) {
        this.showToast(t("vault.chat_copy_removed"), "success");
        await this.searchPage.refreshPersonalList();
      } else {
        this.showToast(
          t("vault.chat_copy_remove_failed", { err: res.error ?? "" }),
          "error",
        );
      }
    } catch (e: any) {
      this.showToast(
        t("vault.chat_copy_remove_failed", { err: e?.message ?? String(e) }),
        "error",
      );
    }
  }

  /**
   * SP-33/D-180: входящие передачи личных файлов.
   *
   * Отрисовку и поповер держит `ShareInbox` (кнопка в шапке со счётчиком и
   * пульсирующей точкой), App только опрашивает сервер и выполняет действия.
   */
  private async _refreshShareInbox(): Promise<void> {
    await this.shareInbox?.refresh();
  }

  /**
   * «Зберегти»: файл зачисляется в личное хранилище получателя.
   *
   * D-180: сразу после приёма НЕ уводим на страницу скачивания — открываем
   * личный кабинет и подсвечиваем новую карточку. Скачать на ПК можно с
   * карточки кнопкой «Скачати» (файл уже доставлен в PM получателя).
   */
  private async _acceptShare(shareId: number): Promise<void> {
    try {
      const resp = await api.vaultAcceptShare(shareId);
      this.showToast(
        t("vault.share_accepted", { file: resp?.name || "" }),
        "success",
      );
      await this._refreshShareInbox();
      this.shareInbox?.dismiss();
      if (!resp?.personal_file_id) return;
      // Право личного хранилища проверяет setVaultScope: если оно истекло
      // после отправки, карточка останется в хранилище до продления, а
      // пользователь — в текущем режиме (без 403 от личного поиска).
      if (setVaultScope("personal") !== "personal") return;
      this._switchTab("search");
      await this.searchPage.showPersonal();
      await this.searchPage.flashPersonalCard(resp.personal_file_id);
    } catch (e: any) {
      this.showToast(
        t("vault.share_failed", { err: e?.message ?? String(e) }),
        "error",
      );
      await this._refreshShareInbox();
    }
  }

  /** «Відхилити»: передача закрывается, копия со склада удаляется. */
  private async _declineShare(shareId: number): Promise<void> {
    try {
      await api.vaultDeclineShare(shareId);
      this.showToast(t("vault.share_declined"), "info");
    } catch (e: any) {
      this.showToast(
        t("vault.share_failed", { err: e?.message ?? String(e) }),
        "error",
      );
    }
    await this._refreshShareInbox();
  }

  /**
   * Личное хранилище: скачать СВОЙ личный файл.
   * Вызывается из SearchPage в личном режиме (renderVaultCard).
   */
  private onPersonalSearchDownload(pfId: number): void {
    this._switchTab("download");
    this.downloadPage.downloadPersonal(pfId);
  }

  /**
   * Переключиться на вкладку Download и начать скачивание файла.
   * Вызывается из SearchPage при клике на результат поиска.
   */
  private onSearchDownload(fileId: number): void {
    this._switchTab("download");
    this.downloadPage.setFileId(fileId);
  }

  /**
   * Загрузка завершилась успешно (UploadPage зовёт на успешном `/complete`).
   *
   * BUG-CABINET-STALE-001: личный кабинет берёт список одним GET и держит его
   * в DOM — после личной загрузки список не перечитывался, и свежий файл был
   * виден только после перезапуска клиента (личный репорт владельца
   * 2026-11-11, personal #33). Пользователя НЕ уводим с вкладки
   * «Завантажити» (там инструмент медиа карточки): помечаем список устаревшим
   * и, если кабинет открыт прямо сейчас, перечитываем сразу — иначе это
   * сделает открытие вкладки «Пошук».
   */
  private onUploadComplete(): void {
    if (!isPersonalScope()) return;
    this.searchPage.markPersonalCabinetStale();
    void this.searchPage.refreshPersonalCabinetIfStale(this._activeTab());
  }
  /**
   * Звук уведомлений чатов (выбор владельца 2026-10-31, SP-30, D-144).
   *
   * Воспроизведение живёт в `ChatSoundPlayer` (там же инвариант «не звать load()
   * на играющем элементе» — иначе проба из Настроек обрывалась сразу после старта,
   * BUG-CHAT-SOUND-PREVIEW-001). Здесь только боевая фабрика элементов: url из
   * сборки (`?url` — относительный путь, иначе `file://` уедет в корень диска).
   */
  private readonly chatSounds = new ChatSoundPlayer((id) => {
    const audio = new Audio(chatSoundUrl(id));
    audio.preload = "auto";
    return audio;
  });

  /** Проиграть звук: по умолчанию — сохранённый в настройках. */
  private _playChatSound(id: ChatSoundId = this.chatSounds.id): void {
    this.chatSounds.play(id);
  }

  /** Сохранённый звук сменился: запоминаем и прогреваем (без перезапуска клиента). */
  private _applyChatSound(id: ChatSoundId): void {
    this.chatSounds.apply(id);
  }

  /** Выход/стоп мониторинга: глушим все звуки, включая пробу. */
  private _stopChatSounds(): void {
    this.chatSounds.stopAll();
  }



  /**
   * Переключить активную вкладку по data-tab атрибуту.
   */
  private _switchTab(tabName: string): void {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

    const tab = document.querySelector<HTMLElement>(`[data-tab="${tabName}"]`);
    if (tab) tab.classList.add("active");

    const content = document.getElementById(`tab-${tabName}`);
    if (content) content.classList.add("active");

    this._onTabActivated(tabName);
  }

  /**
   * Побочные эффекты открытия вкладки (ленивая догрузка данных).
   *
   * Вызывается И из клика по .tab, И из _switchTab() — иначе программный
   * переход на вкладку (напр. из SearchPage) не инициирует загрузку.
   */
  private _onTabActivated(tabName: string): void {
    this.communityPage.setActive(tabName === "community");
    if (tabName === "faq") {
      // FAQ: публичный контент, грузится при первом открытии;
      // повторные клики — no-op (FaqPage кэширует по языку).
      void this.faqPage.ensureLoaded();
    }
    if (tabName === "tools") {
      // Остаток разблокировок GEO_Unlock мог измениться, пока вкладка была
      // закрыта (патч по платному дампу, покупка пакета, правка админом) —
      // обновляем счётчик при каждом открытии. Это ЧТЕНИЕ: grant не выдаётся
      // и разблокировка не списывается (D-173).
      void this.toolsPage.refreshStatus();
    }
    if (tabName === "search") {
      // BUG-CABINET-STALE-001: список личного кабинета живёт в DOM до
      // следующего действия пользователя, поэтому после личной загрузки
      // свежий файл был виден только после перезапуска клиента. Перечитываем
      // ТОЛЬКО помеченный список и ТОЛЬКО в личном режиме — правило живёт в
      // `CabinetRefresh` (публичный каталог не трогаем, A3).
      void this.searchPage.refreshPersonalCabinetIfStale(tabName);
    }
  }

  /** `data-tab` активной вкладки ('' — если ни одна не помечена). */
  private _activeTab(): string {
    return document.querySelector<HTMLElement>(".tab.active")?.dataset.tab ?? "";
  }

  /**
   * Owner-backdoor (T6.4): скачать личный файл ЦЕЛЕВОГО юзера — переключить на
   * вкладку Download и запустить ownerDownload (host-copy + single-download).
   */
  private onOwnerDownload(targetTgId: number, pfId: number, name: string): void {
    this._switchTab("download");
    this.downloadPage.ownerDownload(targetTgId, pfId, name);
  }

  /** Показать/скрыть скрытую вкладку «Owner» по флагу владельца (ownerMode). */
  private _applyOwnerUi(): void {
    if (!this.ownerTabBtn) return;
    this.ownerTabBtn.style.display = isOwner() ? "" : "none";
  }


  async init(): Promise<void> {
    this.cacheDom();
    this.bindEvents();

    // SP-33/D-180: компактные входящие передачи личных файлов. Кнопка живёт
    // в шапке, список — в поповере; App отвечает только за действия.
    this.shareInbox = new ShareInbox({
      load: async () => (await api.vaultIncomingShares())?.items ?? [],
      accept: (id) => this._acceptShare(id),
      decline: (id) => this._declineShare(id),
    });

    // Версия клиента в шапке (получаем из main-процесса через IPC)
    void this._loadClientVersion();

    // Прогресс скачивания обновления в шапке (событие updater-progress из main)
    this._initUpdateProgressListener();

    // i18n: переключение языка на лету (header + активная страница)
    subscribe(() => this._applyUiLang());

    // Чип активной передачи (Phase 3, гибридный старт): лёгкий опрос
    // состояния DownloadPage раз в секунду + обновление при смене языка.
    setInterval(() => this._updateTransferChip(), 1000);
    this._updateTransferChip();

    // D-181: входящие передачи личных файлов НЕ опрашиваются таймером.
    // Сервер присылает `share_received` по уже открытому billing WebSocket,
    // а один GET списка делается по событию и при каждом `onopen` (включая
    // переподключение) — так не теряются передачи, пришедшие без WS.

    // Регистрируем обработчик 401 — принудительная реавторизация
    api.onUnauthorized = () => this.forceReauth();

    // v3.7: Слушаем tdlib-my-id (ответ getMe от TDLib) для обновления currentTgId.
    // После успешной TDLib-авторизации TdlibAuthPage._doApiPairing() создаёт
    // API-сессию (authPair + save + setToken). Этот слушатель обновляет
    // currentTgId и currentUsername в App.ts, чтобы UploadPage/DownloadPage
    // могли получить tg_id через callback.
    // Устанавливаем ДО checkAndShow(), чтобы не пропустить событие.
    listen<any>("tdlib-my-id", (event) => {
      const { tg_id, first_name, last_name, username } = event.payload;
      this.currentTgId = tg_id;
      this.currentUsername = username || `${first_name} ${last_name}`.trim();
    }).catch((e) => {
      console.warn("[App] Failed to listen tdlib-my-id:", e);
    });

    // Загружаем сохранённую API-сессию (auth.json)
    const auth = await store.load();
    if (auth) {
      // BUG-AUTH-015: диагностика токена из store
      console.debug("[App.init] store.load() OK, calling api.setToken",
        `token=${auth.access_token.slice(0, 20)}...`, `tg_id=${auth.tg_id}`);
      api.setToken(auth.access_token);
      this.currentTgId = auth.tg_id;
      this.currentUsername = auth.username;

      // Billing: подключаем WebSocket и загружаем пакеты
      this._connectBillingWs();
      this.billingPage.loadPackages();
    } else {
      console.debug("[App.init] store.load() returned null — no saved auth");
    }

    // TDLib user auth — первая страница при запуске
    await this.tdlibAuthPage.checkAndShow();

    // Если после checkAndShow() есть токен — подключаем billing WS
    if (api.getToken() && !this.wsBilling) {
      this._connectBillingWs();
      this.billingPage.loadPackages();
    }
  }

  /** Принудительная реавторизация после 401 или разлогина */
  private async forceReauth(): Promise<void> {
    // Предотвращаем двойную реавторизацию — проверяем централизованный флаг
    if (!this.mainSection.style.display || this.mainSection.style.display === "none") return;
    setAppAuthenticated(false);
    this.activityHeartbeat.stop();
    this.chatNotifications.stop();
    this.communityPage.reset();
    this.searchPage.resetCommunity();
    api.setToken(null);
    await store.clear();
    setTdlibUserAuthorized(false);
    this._lastConnected = false;
    this._lastUsername = "";
    this._lastKnownBalance = -1;
    this._lastPackagesRevision = -1;
    this._hb = resetHeaderBalance();
    this._refetchQueued = false;
    // Owner-backdoor: скрыть вкладку владельца при реавторизации
    if (isOwner()) setOwner(false);
    this._applyOwnerUi();
    this.setStatus(false, t("header.disconnected"));

    // Показываем auth page заново (reset + show)
    this.mainSection.style.display = "none";
    this.logoutBtn.style.display = "none";
    this._setHeaderUserVisible(false);
    // Fail-closed (BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001): если TDLib не подтвердил
    // сброс, экран входа не показываем «поверх живой сессии» — вместо этого
    // переспрашиваем состояние (checkAndShow сам доведёт вход до конца, если
    // TDLib уже авторизован). Иначе пользователь остаётся на пустом экране.
    const reset = await this.tdlibAuthPage.resetAuth();
    if (!reset) await this.tdlibAuthPage.checkAndShow();
  }

  private cacheDom(): void {
    this.mainSection = document.getElementById("mainSection")!;
    this.statusDot = document.getElementById("statusDot")!;
    this.statusText = document.getElementById("statusText")!;
    this.logoutBtn = document.getElementById("logoutBtn")!;
    this.userPill = document.getElementById("userPill")!;
    this.pointsPill = document.getElementById("pointsPill")!;
    this.vaultToggle = document.getElementById("vaultToggle")!;
    this.vaultToggleLabel = document.getElementById("vaultToggleLabel")!;
    this.vaultBanner = document.getElementById("vaultBanner")!;
    this.ownerTabBtn = document.getElementById("ownerTabBtn")!;
    // Версия клиента и прогресс обновления в шапке
    this.versionPill = document.getElementById("versionPill")!;
    this.versionText = document.getElementById("versionText")!;
    this.updateProgress = document.getElementById("updateProgress")!;
    this.updateProgressBar = document.getElementById("updateProgressBar")!;
    this.updateProgressText = document.getElementById("updateProgressText")!;
  }

  /** Показать/скрыть пилюли пользователя и баллов в header */
  private _setHeaderUserVisible(visible: boolean): void {
    this.userPill.style.display = visible ? "flex" : "none";
    this.pointsPill.style.display = visible ? "flex" : "none";
  }

  /** Загрузить версию клиента и показать в шапке. */
  private async _loadClientVersion(): Promise<void> {
    try {
      const res = await invoke<{ version: string; arch: string }>(
        "updater.version",
      );
      const ver = res?.version;
      if (ver) {
        this.versionText.textContent = `v${ver}`;
        this.versionPill.style.display = "flex";
      }
    } catch (e) {
      // main-процесс ещё не готов — версия не критична, шапка просто останется без неё
      console.warn("[updater] не удалось получить версию клиента:", e);
    }
  }

  /** Подписаться на событие прогресса скачивания обновления (main → renderer). */
  private _initUpdateProgressListener(): void {
    listen<{ received: number; total: number }>(
      "updater-progress",
      (e) => {
        const received = Number(e?.payload?.received) || 0;
        const total = Number(e?.payload?.total) || 0;
        if (total > 0) {
          const percent = Math.min(100, Math.floor((received * 100) / total));
          this.updateProgress.style.display = "flex";
          // progress-bar рисуется через CSS ::before, меняем width через CSS-переменную
          (this.updateProgressBar as HTMLElement).style.setProperty(
            "--progress",
            `${percent}%`,
          );
          this.updateProgressText.textContent = `${percent}%`;
          if (percent >= 100) {
            this.updateProgressText.textContent = "Проверка…";
          }
        } else {
          this.updateProgress.style.display = "none";
          this.updateProgressText.textContent = "";
        }
      },
    );
  }

  private bindEvents(): void {
    // Вкладки
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        const target = document.getElementById(`tab-${(tab as HTMLElement).dataset.tab}`);
        if (target) target.classList.add("active");
        this._onTabActivated((tab as HTMLElement).dataset.tab || "");
      });
    });

    // Кнопка "Выйти"
    this.logoutBtn.addEventListener("click", () => this.disconnect());

    // Переключатель «Личный кабинет ⇄ Публичное поле»
    this.vaultToggle.addEventListener("click", () => {
      const target = isPersonalScope() ? "public" : "personal";
      // Кнопка видна всем, но личный режим доступен ТОЛЬКО при активном entitlement.
      if (target === "personal" && !isVaultEntitled()) {
        this.showToast(
          tLoose("vault.entitlement_required"),
          "info",
        );
        return;
      }
      setVaultScope(target);
      if (target === "personal") {
        this.searchPage.showPersonal();
      } else {
        this.searchPage.resetPublic();
      }
    });

    // Баннер «Публичное поле» без активного ЛХ — клик ведёт в «Магазин»
    this.vaultBanner.addEventListener("click", () => {
      if (!isPersonalScope() && !isVaultEntitled()) this._openBillingTab();
    });

    // Гибридный старт (Phase 3): чип «Идёт передача — открыть» на вкладке
    // поиска → возвращает в консоль передачи (DownloadPage). Вся логика
    // передачи остаётся в DownloadPage — чип только навигация.
    document
      .getElementById("searchTransferChip")
      ?.addEventListener("click", () => this._switchTab("download"));

    // Передаём события загрузки/скачивания/поиска
    this.uploadPage.bindEvents();
    this.downloadPage.bindEvents();
    this.searchPage.bindEvents();
    this.archivePage.bindEvents();
    // Інструменти (GEO Unlock): кнопки/поля вкладки «Інструменти».
    this.toolsPage.bindEvents();

    // Owner-backdoor: при каждом открытии вкладки — свежая загрузка списка.
    this.ownerTabBtn.addEventListener("click", () => {
      this.ownerPage.open().catch((e) => {
        console.warn("[App] OwnerPage.open failed:", e);
      });
    });
  }

  /**
   * Запросить entitlement личного хранилища у сервера и показать переключатель,
   * если юзер имеет активный доступ. Вызывается после успешной авторизации.
   */
  private async _initVaultEntitlement(): Promise<void> {
    try {
      const res = await api.vaultStatus();
      const vault = res?.vault;
      setVaultEntitlement(vault && vault.is_active
        ? { is_active: !!vault.is_active, expires_at: vault.expires_at }
        : null);
    } catch (e: any) {
      console.warn("[App] vault status unavailable:", e?.message ?? e);
      setVaultEntitlement(null);
    }
    this._applyVaultUi();
    subscribeVault(() => this._applyVaultUi());
  }

  /** Обновить состояние переключателя/баннера по vaultMode.
   *
   * Кнопка переключателя ВИДНА всем авторизованным (после onAuthenticated/
   * onTdlibAuthenticated вызывается _setVaultUiVisible(true)). Сам переход в
   * личный режим доступен только при активном entitlement (гейт в клике +
   * серверная проверка). Баннер-подсветка показывается И в «Личном кабинете»,
   * и в «Публичном поле» (в публичном — подсказка, как включить ЛХ: покупка
   * пакета в «Магазине» или переключатель в шапке); виден только после auth.
   */
  private _applyVaultUi(): void {
    if (!this.vaultToggle) return;
    const personal = isPersonalScope();
    const entitled = isVaultEntitled();
    this.vaultToggle.classList.toggle("vault-mode-active", personal);
    this.vaultToggleLabel.textContent = personal
      ? tLoose("vault.toggle_personal")
      : tLoose("vault.toggle_public");

    // Баннер показываем после авторизации. В «Публичном поле» тоже даём
    // подсветку-подсказку, как включить «Личный кабинет» (магазин/переключатель).
    if (!this._vaultUiShown && !personal) {
      this.vaultBanner.className = "vault-banner";
      this.vaultBanner.style.display = "none";
      return;
    }
    if (personal) {
      this.vaultBanner.textContent = tLoose("vault.banner_personal");
      this.vaultBanner.className = "vault-banner vault-mode-active";
    } else if (entitled) {
      this.vaultBanner.textContent =
        `${tLoose("vault.banner_public")} · ${tLoose("vault.hint_public_entitled")}`;
      this.vaultBanner.className = "vault-banner vault-mode-public";
    } else {
      this.vaultBanner.textContent =
        `${tLoose("vault.banner_public")} · ${tLoose("vault.hint_public_store")}`;
      this.vaultBanner.className = "vault-banner vault-mode-public clickable";
    }
    this.vaultBanner.style.display = "block";
  }

  /** Показать/скрыть переключатель «Личный кабинет» в шапке (после auth). */
  private _setVaultUiVisible(visible: boolean): void {
    this._vaultUiShown = visible;
    if (this.vaultToggle) {
      this.vaultToggle.style.display = visible ? "inline-block" : "none";
    }
    // Обновляем баннер (в публичном поле тоже показываем подсказку).
    this._applyVaultUi();
  }

  /** Перейти на вкладку «Магазин» (для подсказки про покупку ЛХ). */
  private _openBillingTab(): void {
    const btn = document.querySelector('.tab[data-tab="billing"]') as HTMLElement | null;
    if (btn) {
      btn.click();
    } else {
      this.showToast(tLoose("vault.hint_public_store"), "info");
    }
  }

  private setStatus(connected: boolean, text: string, extra?: string): void {
    this.statusDot.className = `status-dot ${connected ? "connected" : "disconnected"}`;
    this.statusText.textContent = text;
    // Дополнительная информация (баланс, безлимит, бан)
    const extraEl = document.getElementById("statusExtra");
    if (extraEl) {
      extraEl.textContent = extra || "";
    }
  }

  /** Перерисовать user-facing состояние после смены языка (header + активные модули). */
  private _applyUiLang(): void {
    applyStaticI18n();
    // Полное название вкладки кладём в title/aria-label ПОСЛЕ локализации
    // (иначе тултип на прошлом языке), затем равные ширины вкладок: самая
    // широкая подпись другая. Гейт: tests/tabs-overflow.test.ts (T6).
    syncTabTitles();
    layoutTabStrip();
    if (this._lastConnected !== null) {
      if (this._lastConnected) {
        this.setStatus(
          true,
          this._lastUsername
            ? t("header.connected", { name: this._lastUsername })
            : t("header.tdlib_authorized"),
        );
      } else {
        this.setStatus(false, t("header.disconnected"));
      }
    }
    this._applyBalanceExtra();
    // Чип передачи: подпись зависит от языка.
    this._updateTransferChip();
    // Vault-переключатель и баннер режима тоже зависят от языка.
    this._applyVaultUi();
    // Входящие файлы: подписи строк/подсказки — динамические, перерисовываем.
    this.shareInbox?.applyLang();
    this.uploadPage.applyLang();
    this.searchPage.applyLang();
    this.billingPage.applyLang();
    this.downloadPage.applyLang();
    // FAQ: контент серверный → applyLang() перезапрашивает документ для нового
    // языка (если вкладка ещё не открывалась — остаётся плейсхолдер).
    this.faqPage.applyLang();
    this.communityPage.applyLang();
    this.settingsPage.applyLang();
    // Owner-вкладка (скрытая) тоже перерисовывается из сохранённого состояния.
    this.ownerPage.applyLang();
    // Archiver (Фаза 3): подписи кнопок/селекта — только textContent.
    this.archivePage.applyLang();
    // Інструменти (GEO Unlock): шляхи/бейдж тарифу — динамічні, решта через data-i18n.
    this.toolsPage.applyLang();
  }

  /** Перерисовать блок баллов/статуса в header из сохранённого состояния. */
  private _applyBalanceExtra(): void {
    const infoEl = document.getElementById("statusExtra");
    if (!infoEl || !this._lastBalance) return;
    const b = this._lastBalance;
    if (b.banned) {
      infoEl.textContent = t("header.banned", { reason: b.banReason || "SPAM UPLOAD" });
    } else {
      const parts: string[] = [];
      if (b.unlimited) parts.push(t("header.unlimited"));
      parts.push(t("header.balance", { n: b.balance }));
      infoEl.textContent = parts.join(" | ");
    }
  }

  /** Подключиться к Billing WebSocket для получения balance_update */
  private _connectBillingWs(): void {
    const token = api.getToken();
    const tgId = this.currentTgId;
    if (!token || !tgId) {
      console.warn("[App] _connectBillingWs: no token or tgId, skipping");
      return;
    }

    // Закрыть предыдущее соединение и остановить polling
    this._stopBillingPolling();
    if (this.wsBilling) {
      this.wsBilling.close();
      this.wsBilling = null;
    }
    if (this.wsBillingReconnectTimer) {
      clearTimeout(this.wsBillingReconnectTimer);
      this.wsBillingReconnectTimer = null;
    }

    const baseUrl = api.getBaseUrl();
    const wsBase = baseUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/api/v1/billing/ws?tg_id=${tgId}&token=${token}`;

    console.log("[App] Billing WS connecting...", wsUrl.replace(/token=([^&]+)/, "token=***"));

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log("[App] Billing WS connected (onopen)");
        // D-181: один GET входящих на каждое подключение/переподключение.
        // Пока WS был недоступен, push-события не доходили — этот запрос
        // добирает пропущенное. Это не опрос: запрос только по факту
        // установки соединения.
        void this._refreshShareInbox();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "balance_update" && data.tg_id === tgId) {
            console.log("[App] Billing WS balance_update:", data);
            // Значение уже пришло с сервера — применяем мгновенно, без GET (D-BP-5):
            // иначе каждый push давал лишний запрос и мигание заголовка.
            this._applyPushedBalance(data.balance);
            // Показать toast-уведомление о начислении баллов
            if (data.delta > 0) {
              this.showToast(
                t("billing.toast_earned", { n: data.delta, balance: data.balance }),
                "success",
              );
              // Показать сообщение об успешной оплате в UI вкладки Магазин
              this.billingPage.onPaymentSuccess(data.delta);
            } else if (data.delta < 0) {
              this.showToast(
                t("billing.toast_spent", { n: Math.abs(data.delta), balance: data.balance }),
                "info",
              );
            }
          } else if (data.type === "packages_update") {
            // Админ изменил пакеты магазина (создание/редактирование/удаление) —
            // перезагружаем список пакетов сразу, не дожидаясь polling.
            console.log("[App] Billing WS packages_update:", data.action, data.package_key ?? data.package_id);
            this.billingPage.loadPackages().catch((e) => {
              console.warn("[App] Failed to reload packages after packages_update:", e);
            });
          } else if (data.type === "share_received" && data.tg_id === tgId) {
            // D-181: другому мастеру пришла входящая передача — один GET
            // списка. Пульс на кнопке `📨 N` живёт, пока карточка не принята
            // или не отклонена; повторных опросов сервера нет.
            console.log("[App] Billing WS share_received:", data.share_id ?? "");
            void this._refreshShareInbox();
          }
        } catch (e) {
          console.warn("[App] WS billing message error:", e);
        }
      };

      ws.onerror = (err) => {
        console.error("[App] Billing WS error:", err);
        ws.close();
      };

      ws.onclose = (event) => {
        console.log(
          "[App] Billing WS closed: code=%d, reason=%s",
          event.code,
          event.reason || "none",
        );
        // Auto-reconnect через 30 секунд (кроме случая намеренного закрытия при disconnect)
        this.wsBillingReconnectTimer = window.setTimeout(
          () => this._connectBillingWs(),
          30000,
        );
      };

      this.wsBilling = ws;
    } catch (e) {
      console.error("[App] Failed to connect billing WS:", e);
      // Повторная попытка через 30 секунд
      this.wsBillingReconnectTimer = window.setTimeout(
        () => this._connectBillingWs(),
        30000,
      );
    }

    // Fallback polling: опрашиваем баланс каждые 15 секунд независимо от WS
    // Это гарантирует обновление баланса, даже если WebSocket отвалился
    this._startBillingPolling();
  }

  /** Запустить периодический опрос баланса (fallback для WebSocket) */
  private _startBillingPolling(): void {
    this._stopBillingPolling(); // избежать дублирования
    console.debug("[App] _startBillingPolling: polling every 15s");
    this._billingPollTimer = window.setInterval(() => {
      this.fetchAndShowBalance();
    }, 15000);
  }

  /** Остановить периодический опрос баланса */
  private _stopBillingPolling(): void {
    if (this._billingPollTimer !== null) {
      clearInterval(this._billingPollTimer);
      this._billingPollTimer = null;
      console.debug("[App] _stopBillingPolling: polling stopped");
    }
  }

  private async fetchAndShowBalance(): Promise<void> {
    const began = beginHeaderFetch(this._hb);
    this._hb = began.state;
    if (!began.started) {
      // Дедуп: GET уже в полёте — параллельный не делаем, но помним, что данные
      // могли измениться, и перезапросим после завершения (D-BP-5).
      this._refetchQueued = true;
      return;
    }
    // «⏳» — только пока баланс не известен ни разу; повторные опросы/пуш
    // текст заголовка не трогают (анти-мигание, D-BP-5).
    const infoEl = document.getElementById("statusExtra");
    if (infoEl && headerHint(this._hb) === "loading") {
      infoEl.textContent = t("header.loading_balance");
    }
    // BUG-AUTH-015: диагностика токена перед запросом баланса
    const currentToken = api.getToken();
    console.debug("[App] fetchAndShowBalance: token=",
      currentToken ? `${currentToken.slice(0, 20)}...` : "NULL/EMPTY");
    try {
      const appState = await api.getAppState();
      // ── Детект изменения пакетов магазина через polling (fallback для WS) ──
      // Сравниваем ревизию из app-state с последней известной. Если изменилась —
      // админ изменил пакеты, а WS packages_update мог не дойти.
      if (appState && appState.billing_packages_revision !== undefined
          && this._lastPackagesRevision >= 0
          && appState.billing_packages_revision !== this._lastPackagesRevision) {
        console.log(
          "[App] fetchAndShowBalance: packages revision changed",
          this._lastPackagesRevision, "→", appState.billing_packages_revision,
          "(polling fallback)",
        );
        this.billingPage.loadPackages().catch((e) => {
          console.warn("[App] Failed to reload packages after revision change:", e);
        });
      }
      if (appState && appState.billing_packages_revision !== undefined) {
        this._lastPackagesRevision = appState.billing_packages_revision;
      }
      if (appState?.user) {
        const u = appState.user;
        // Owner-backdoor (T6.4): детект владельца из app-state.
        const appOwner = !!u.is_owner;
        if (appOwner !== isOwner()) {
          setOwner(appOwner);
          this._applyOwnerUi();
        }
        // ── Детект изменения баланса через polling ──────────────────────
        // Если баланс увеличился с прошлого опроса — значит оплата прошла,
        // но WebSocket balance_update мог не дойти.
        if (u.balance !== undefined && this._lastKnownBalance >= 0 && u.balance > this._lastKnownBalance) {
          const delta = u.balance - this._lastKnownBalance;
          console.log("[App] fetchAndShowBalance: balance increased by +" + delta + " (polling fallback)");
          this.billingPage.onPaymentSuccess(delta);
        }
        if (u.balance !== undefined) {
          this._lastKnownBalance = u.balance;
        }
        this._finishFetch(endHeaderFetch(this._hb, u.balance ?? 0).state);
        // ── Отображение баланса в заголовке ────────────────────────────
        let extraParts: string[] = [];
        let banned = false;
        let banReason: string | null = null;
        let unlimited = false;
        if (u.is_banned) {
          banned = true;
          banReason = u.ban_reason || "SPAM UPLOAD";
          extraParts.push(t("header.banned", { reason: banReason }));
        } else {
          unlimited = !!u.is_unlimited;
          if (unlimited) {
            extraParts.push(t("header.unlimited"));
          }
          extraParts.push(t("header.balance", { n: u.balance ?? 0 }));
        }
        const extraStr = extraParts.join(" | ");
        this._lastBalance = { balance: u.balance ?? 0, banned, banReason, unlimited };
        if (infoEl) {
          infoEl.textContent = extraStr;
        }
        // Если пользователь забанен — меняем статус
        if (banned) {
          this.setStatus(false, t("header.account_banned"), extraStr);
        }
      } else {
        // Сервер вернул ответ, но user=null (нет сессии или токен протух)
        this._finishFetch(settleHeaderFetch(this._hb));
        if (isOwner()) { setOwner(false); this._applyOwnerUi(); }
        // Прежний баланс (если был) не затираем — нет дребезга (D-BP-5)
        if (infoEl && headerHint(this._hb) === "loading") {
          infoEl.textContent = t("header.no_data");
        }
      }
    } catch (e: any) {
      console.warn("[App] Failed to fetch balance:", e);
      this._finishFetch(settleHeaderFetch(this._hb));
      // Ошибка не стирает уже показанный баланс (D-BP-5)
      if (infoEl && headerHint(this._hb) === "loading") {
        infoEl.textContent = t("header.balance_error", { err: e?.message ?? "unknown" });
      }
    }
  }

  /**
   * Терминальная точка fetch баланса: закрывает in-flight и, если во время
   * запроса пришёл перезапрос (данные могли измениться), выполняет его.
   */
  private _finishFetch(next: HeaderBalanceState): void {
    this._hb = next;
    if (this._refetchQueued) {
      this._refetchQueued = false;
      queueMicrotask(() => {
        void this.fetchAndShowBalance();
      });
    }
  }

  /**
   * Push с сервера (WS balance_update): применяем значение мгновенно, без GET —
   * заголовок обновляется сразу и не мигает (D-BP-5).
   */
  private _applyPushedBalance(balance: unknown): void {
    if (typeof balance !== "number" || !Number.isFinite(balance)) return;
    this._hb = applyHeaderPush(this._hb, balance).state;
    this._lastKnownBalance = balance;
    if (!this._lastBalance) {
      // Значение ещё ни разу не рисовали (или после logout): показываем баланс;
      // banned/unlimited пришлёт ближайший обычный fetch.
      this._lastBalance = { balance, banned: false, banReason: null, unlimited: false };
    } else {
      this._lastBalance.balance = balance;
    }
    this._applyBalanceExtra();
  }

  private onAuthenticated(username: string): void {
    setAppAuthenticated(true);
    this.activityHeartbeat.start();
    void this.chatNotifications.start();

    this.mainSection.style.display = "block";
    this._onTabActivated(document.querySelector<HTMLElement>(".tab.active")?.dataset.tab ?? "upload");
    this.logoutBtn.style.display = "inline-block";
    this._setHeaderUserVisible(true);
    this._setVaultUiVisible(true);
    this._lastConnected = true;
    this._lastUsername = username;
    this.setStatus(true, t("header.connected", { name: username }));

    // BUG-AUTH-015: диагностика токена при onAuthenticated
    console.debug("[App] onAuthenticated called, username=", username,
      "token=", api.getToken() ? `${api.getToken()!.slice(0, 20)}...` : "NULL");

    // Асинхронно подгружаем баланс
    this.fetchAndShowBalance();

    // Личное хранилище: entitlement + переключатель
    this._initVaultEntitlement();

    // Billing: WebSocket + загрузка пакетов
    this._connectBillingWs();
    this.billingPage.loadPackages();
  }

  /** Вызывается после успешной TDLib авторизации (QR/телефон/пароль) */
  private onTdlibAuthenticated(): void {
    setAppAuthenticated(true);
    this.activityHeartbeat.start();
    void this.chatNotifications.start();

    this.mainSection.style.display = "block";
    this._onTabActivated(document.querySelector<HTMLElement>(".tab.active")?.dataset.tab ?? "upload");
    this.logoutBtn.style.display = "inline-block";
    this._setHeaderUserVisible(true);
    this._setVaultUiVisible(true);
    this._lastConnected = true;
    this._lastUsername = this.currentUsername;

    if (this.currentUsername) {
      this.setStatus(true, t("header.connected", { name: this.currentUsername }));
    } else {
      this.setStatus(true, t("header.tdlib_authorized"));
    }

    // BUG-AUTH-015: диагностика токена при onTdlibAuthenticated
    console.debug("[App] onTdlibAuthenticated called",
      "token=", api.getToken() ? `${api.getToken()!.slice(0, 20)}...` : "NULL");

    // Асинхронно подгружаем баланс
    this.fetchAndShowBalance();

    // Личное хранилище: entitlement + переключатель
    this._initVaultEntitlement();

    // Billing: WebSocket + загрузка пакетов
    this._connectBillingWs();
    this.billingPage.loadPackages();
  }

  async disconnect(): Promise<void> {
    // Fail-closed (BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001, 2026-10-31): сначала
    // спрашиваем TDLib. Если выход НЕ принят движком (например, мост не
    // маршрутизирует команду и отвечает NOT_IMPLEMENTED), локальную сессию НЕ
    // рвём: иначе экран входа показывается поверх живой авторизации, а вход по
    // номеру отвечает PHONE_AUTH_ALREADY_AUTHORIZED — тупик без перезапуска.
    const loggedOut = await this.tdlibAuthPage.resetAuth("logout");
    if (!loggedOut) {
      const msg = t("auth.logout_failed");
      console.error("[App] disconnect: TDLib refused to log out — локальная сессия сохранена");
      this.setStatus(false, msg);
      return;
    }

    // Сбрасываем состояние баланса и останавливаем polling
    this._lastKnownBalance = -1;
    this._lastPackagesRevision = -1;
    this._hb = resetHeaderBalance();
    this._refetchQueued = false;
    this._stopBillingPolling();
    this.activityHeartbeat.stop();
    this.chatNotifications.stop();
    this.communityPage.reset();
    this.searchPage.resetCommunity();
    api.setToken(null);
    await store.clear();
    setAppAuthenticated(false);
    this.currentUsername = "";
    this._lastConnected = false;
    this._lastUsername = "";
    this._lastBalance = null;
    setTdlibUserAuthorized(false);
    this.setStatus(false, t("header.disconnected"));

    // Скрываем основное содержимое
    this.mainSection.style.display = "none";
    this.logoutBtn.style.display = "none";
    this._setHeaderUserVisible(false);
    this._setVaultUiVisible(false);

    // Закрываем Billing WebSocket
    if (this.wsBilling) {
      this.wsBilling.close();
      this.wsBilling = null;
    }
    if (this.wsBillingReconnectTimer) {
      clearTimeout(this.wsBillingReconnectTimer);
      this.wsBillingReconnectTimer = null;
    }

    // Останавливаем polling баланса
    this._stopBillingPolling();

    // Личное хранилище: сброс режима/баннера
    setVaultEntitlement(null);
    setVaultScope("public");
    // Входящие не должны «пережить» выход из аккаунта.
    this.shareInbox?.reset();
    this._vaultUiShown = false;
    this.vaultBanner.className = "vault-banner";
    this.vaultBanner.style.display = "none";
    this.vaultToggle.style.display = "none";

    // Owner-backdoor: скрыть вкладку владельца при выходе
    if (isOwner()) setOwner(false);
    this._applyOwnerUi();
  }
}
