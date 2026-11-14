/**
 * ToolsPage — вкладка «Інструменти»: GEO Unlock (D-148, D-150).
 *
 * Два ЛОКАЛЬНІ інструменти, без хмари і без завантажень:
 *   1. **Samsung eeprom** — байт регіону (логічна адреса 0x3E65) у всіх
 *      резервних копіях разом із parity та CRC32C;
 *   2. **LG NVM (Area Option)** — країна/регіон у дампі 24C256, адреса шукається
 *      автопошуком, а не хардкодом.
 *
 * Платність вирішує ВМІСТ дампа, а не кнопка: main-процес
 * (`classifySamsungDump`) повертає `dumpKind`/`needsGrant` зі скану, і рендерер
 * лише користується цим вердиктом — жодних власних правил тарифу тут немає:
 *   • дамп мікросхеми NVM 24C512 (рівно 64 КіБ) — безкоштовно, grant не питаємо;
 *   • дамп 2 МіБ із eMMC — платно: спершу `POST /desktop/tools/geo-unlock/grant`,
 *     і тільки з отриманим grant'ом викликаємо патч.
 *
 * Два методи Samsung подані окремо за поколіннями (D-154): старі моделі —
 * мікросхема, нові — дамп із eMMC. Панель кнопок спільна, тип дампа визначає main.
 *
 * Чому grant приходить із сервера, а не «галочкою»: рендерер — недовірений код,
 * тож main-процес вимагає `{id, kind}` від сервера; без нього платний патч не
 * починається взагалі (див. electron/geo-unlock/service.ts).
 *
 * UI-правила проєкту: текст — через `t()`, форми НЕ пересоздаються при зміні
 * мови (лише `textContent`), логи — англійською (конвенція репозиторію).
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type GeoUnlockStatusResponse } from "../api";
import { t } from "../i18n";

/** Копія, знайдена ядром: плоский образ (`image`) або запис журналу (`record`). */
interface CopyInfo {
  kind: "record" | "image";
  regionPos: number;
  oldRegion: number | null;
  record?: number;
  arrayBase?: number;
  span?: number;
  seq?: number;
  tag?: string;
  valid?: boolean;
  imageBase?: number;
  crcOk?: boolean;
}

/** Вердикт main-процесу: що за дамп перед нами. */
type DumpKind = "emmc-journal" | "nvm24c512";

/** Відповідь `geo_samsung_scan` — звіт + готовий тарифний вердикт. */
interface SamsungScanResult {
  ok: boolean;
  copies: CopyInfo[];
  log: string[];
  dumpKind: DumpKind;
  needsGrant: boolean;
}

/** Відповідь `geo_samsung_patch`. */
interface SamsungPatchResult {
  ok: boolean;
  target: string | null;
  license: "free" | "paid";
  /**
   * `true` — у дампі не було журналу NVRAM-пулу: поправлено лише плоскі копії,
   * тому регіон на працюючому ТВ не зміниться. Вердикт дає main, рендерер лише
   * показує текст (правила тут не дублюються).
   */
  flatOnly: boolean;
  log: string[];
}

interface LgCandidate {
  offset: number;
  value: number;
  score: number;
  lang: number;
  hw: number;
  country: string;
  notes: string[];
}

interface LgScanResult {
  ok: boolean;
  looksLikeLgNvm: boolean;
  candidates: LgCandidate[];
  log: string[];
  rc: number;
}

interface LgPatchResult {
  ok: boolean;
  offset: number;
  oldValue: number;
  newValue: number;
  lang: number;
  hw: number;
  country: string;
  target: string | null;
  log: string[];
}

/** Grant, який сервер видав на платну операцію (main перевіряє його форму). */
interface GeoGrant {
  id: string;
  kind: "owner" | "package" | "trial" | "paid";
}

export class ToolsPage {
  private readonly root: HTMLElement;

  private samsungPath: string | null = null;
  private lgPath: string | null = null;
  /** Вердикт скану: чи платний дамп (з нього ж беремо текст підказки). */
  private samsungNeedsGrant: boolean = false;
  private samsungKind: DumpKind | null = null;
  /** Поки операція виконується — кнопки не дублюють виклик. */
  private busy: boolean = false;
  /**
   * Останній стан доступу з `GET /desktop/tools/geo-unlock/status` (D-173).
   *
   * `null` — ще не запитано (або запит не вдався). Спрашивати остаток через
   * grant НЕ можна: видача списує розблокування, тому відкриття вкладки
   * коштувало б мастеру операції.
   */
  private unlockStatus: GeoUnlockStatusResponse | null = null;

  private samsungPathEl!: HTMLElement;
  private samsungLogEl!: HTMLElement;
  private tierBadgeEl!: HTMLElement;
  /** Счётчик «залишилось розблокувань TIZEN 2026+» у спойлері Samsung. */
  private unlocksLeftEl!: HTMLElement;
  private pickSamsungBtn!: HTMLButtonElement;
  private checkSamsungBtn!: HTMLButtonElement;
  private patchSamsungBtn!: HTMLButtonElement;
  private regionInput!: HTMLInputElement;

  private lgPathEl!: HTMLElement;
  private lgLogEl!: HTMLElement;
  private pickLgBtn!: HTMLButtonElement;
  private scanLgBtn!: HTMLButtonElement;
  private patchLgBtn!: HTMLButtonElement;
  private lgValueInput!: HTMLInputElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  bindEvents(): void {
    this.samsungPathEl = this.root.querySelector("#geoSamsungPath") as HTMLElement;
    this.samsungLogEl = this.root.querySelector("#geoSamsungLog") as HTMLElement;
    this.tierBadgeEl = this.root.querySelector("#geoTierBadge") as HTMLElement;
    this.unlocksLeftEl = this.root.querySelector("#geoUnlocksLeft") as HTMLElement;
    this.pickSamsungBtn = this.root.querySelector("#geoPickSamsungBtn") as HTMLButtonElement;
    this.checkSamsungBtn = this.root.querySelector("#geoCheckSamsungBtn") as HTMLButtonElement;
    this.patchSamsungBtn = this.root.querySelector("#geoPatchSamsungBtn") as HTMLButtonElement;
    this.regionInput = this.root.querySelector("#geoRegionInput") as HTMLInputElement;

    this.lgPathEl = this.root.querySelector("#geoLgPath") as HTMLElement;
    this.lgLogEl = this.root.querySelector("#geoLgLog") as HTMLElement;
    this.pickLgBtn = this.root.querySelector("#geoPickLgBtn") as HTMLButtonElement;
    this.scanLgBtn = this.root.querySelector("#geoScanLgBtn") as HTMLButtonElement;
    this.patchLgBtn = this.root.querySelector("#geoPatchLgBtn") as HTMLButtonElement;
    this.lgValueInput = this.root.querySelector("#geoLgValueInput") as HTMLInputElement;

    this.pickSamsungBtn.addEventListener("click", () => void this.pickSamsung());
    this.checkSamsungBtn.addEventListener("click", () => void this.patchSamsung(true));
    this.patchSamsungBtn.addEventListener("click", () => void this.patchSamsung(false));

    this.pickLgBtn.addEventListener("click", () => void this.pickLg());
    this.scanLgBtn.addEventListener("click", () => void this.scanLg());
    this.patchLgBtn.addEventListener("click", () => void this.patchLg());
    // «Застосувати…» доступна лише з валідним значенням: без цього слухача кнопка
    // лишалася б заблокованою і після того, як майстер вписав регіон (D-154).
    this.lgValueInput?.addEventListener("input", () => this.setButtons());

    // D-169: тайл тулзи (3D-иконка «намекает — нажми») раскрывает рабочую
    // область с функционалом. Логика ОБЩАЯ для всех тулз: новые тулзы НЕ требуют
    // JS — только разметку .tool-entry (button.tool-tile[aria-controls] +
    // .tool-workspace[hidden]). Аккордеон: открыта максимум одна тулза, блоки
    // никогда не перекрывают друг друга; повторный клик закрывает.
    const tiles = Array.from(this.root.querySelectorAll<HTMLButtonElement>(".tool-tile"));
    const setToolOpen = (tile: HTMLButtonElement, open: boolean): void => {
      const workspaceId = tile.getAttribute("aria-controls");
      const workspace = workspaceId ? document.getElementById(workspaceId) : null;
      if (!workspace) return;
      workspace.hidden = !open;
      tile.setAttribute("aria-expanded", open ? "true" : "false");
    };
    tiles.forEach((tile) => {
      tile.addEventListener("click", () => {
        const willOpen = tile.getAttribute("aria-expanded") !== "true";
        tiles.forEach((other) => setToolOpen(other, other === tile ? willOpen : false));
      });
    });

    // Счётчик «залишилось розблокувань» — окреме ЧИТАННЯ стану: grant не
    // видаємо й нічого не списуємо (D-173), інакше відкриття вкладки коштувало б
    // мастеру операції.
    void this.refreshStatus();
    this.applyLang();
  }

  /** Динамічні тексти (статичні — через `data-i18n`, їх оновлює App). */
  applyLang(): void {
    if (this.samsungPathEl) {
      this.samsungPathEl.textContent = this.samsungPath ?? t("tools.not_selected");
    }
    if (this.lgPathEl) {
      this.lgPathEl.textContent = this.lgPath ?? t("tools.not_selected");
    }
    this.renderTier();
    this.renderUnlockCounter();
  }

  /**
   * Перезапросить остаток разблокировок (виклик з App при відкритті вкладки).
   *
   * Помилку НЕ показуємо в лог патча: це фоновий запит за довідкою, а не
   * операція майстра — при збої просто лишається попередній текст.
   */
  async refreshStatus(): Promise<void> {
    try {
      this.unlockStatus = await api.geoUnlockStatus();
    } catch {
      // Мережа/401: counter лишається у попередньому стані (fail-open).
    }
    this.renderUnlockCounter();
  }

  /**
   * Счётчик у спойлері Samsung: скільки разблокировок TIZEN 2026+ залишилось.
   *
   * Безкоштовний шлях (мікросхема NVM TIZEN до 2026) стоїть окремим текстом
   * розмітки (`tools.free_nvm_note`) — счётчик його не стосується.
   */
  private renderUnlockCounter(): void {
    if (!this.unlocksLeftEl) return;
    const status = this.unlockStatus;
    if (status === null) {
      this.unlocksLeftEl.textContent = t("tools.unlocks_loading");
      return;
    }
    switch (status.kind) {
      case "owner":
        this.unlocksLeftEl.textContent = t("tools.unlocks_owner");
        return;
      case "package":
        this.unlocksLeftEl.textContent =
          status.unlocks_left === null
            ? t("tools.unlocks_unlimited")
            : t("tools.unlocks_left", { n: status.unlocks_left });
        return;
      case "trial":
        this.unlocksLeftEl.textContent = t("tools.unlocks_trial", {
          left: status.trial_left,
          limit: status.trial_limit,
        });
        return;
      default:
        this.unlocksLeftEl.textContent = t("tools.unlocks_none");
    }
  }


  // ── Samsung ───────────────────────────────────────────────────────────────

  private async pickSamsung(): Promise<void> {
    try {
      const picked = (await open({
        multiple: false,
        directory: false,
        title: t("tools.pick_dump"),
      })) as string;
      if (!picked) return;
      this.samsungPath = picked;
      this.samsungNeedsGrant = false;
      this.samsungKind = null;
      this.clearLog(this.samsungLogEl);
      this.samsungPathEl.textContent = picked;
      this.renderTier();
      this.setButtons();
      this.log(this.samsungLogEl, `Selected: ${picked}`, "info");
      await this.scanSamsung();
    } catch (e: any) {
      this.log(this.samsungLogEl, `❌ Pick error: ${e?.message ?? String(e)}`, "error");
    }
  }

  /** Скан дампа (безкоштовний): звіт по копіях + тарифний вердикт. */
  private async scanSamsung(): Promise<void> {
    if (!this.samsungPath) return;
    const path = this.samsungPath;
    this.setBusy(true);
    try {
      const scan = await invoke<SamsungScanResult>("geo_samsung_scan", { path });
      this.clearLog(this.samsungLogEl);
      for (const line of scan.log) this.log(this.samsungLogEl, line, "info");
      this.log(this.samsungLogEl, t("tools.copies_found", { n: scan.copies.length }), "info");

      this.samsungKind = scan.dumpKind;
      this.samsungNeedsGrant = scan.needsGrant;
      this.renderTier();

      for (const copy of scan.copies) {
        this.log(this.samsungLogEl, describeCopy(copy), "info");
      }
      if (!scan.ok) {
        this.log(this.samsungLogEl, t("tools.scan_failed", { reason: "no copies found" }), "warn");
      } else if (scan.needsGrant) {
        this.log(this.samsungLogEl, `⚠️ ${t("tools.need_grant")}`, "warn");
      }
    } catch (e: any) {
      this.log(this.samsungLogEl, t("tools.scan_failed", { reason: e?.message ?? String(e) }), "error");
      this.samsungNeedsGrant = false;
      this.samsungKind = null;
      this.renderTier();
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Патч дампа Samsung.
   *
   * `checkOnly` — лише звіт (безкоштовно завжди). Для запису платного дампа
   * спершу питаємо grant у сервера: без нього main відмовить, і файл не
   * створиться. Порядок навмисний — grant ДО діалогу збереження, щоб майстер не
   * вибирав шлях для операції, яку не буде виконано.
   */
  private async patchSamsung(checkOnly: boolean): Promise<void> {
    if (!this.samsungPath || this.busy) return;
    const region = this.parseRegion();
    if (region === null) return;

    const path = this.samsungPath;
    let grant: GeoGrant | undefined;
    let out: string | undefined;

    if (!checkOnly) {
      if (this.samsungNeedsGrant) {
        grant = await this.requestGrant();
        if (grant === undefined) return;
      }
      const picked = await this.pickOutput(path);
      if (!picked) return;
      out = picked;
    }

    this.setBusy(true);
    try {
      const res = await invoke<SamsungPatchResult>("geo_samsung_patch", {
        path,
        out,
        region,
        checkOnly,
        grant,
      });
      this.clearLog(this.samsungLogEl);
      for (const line of res.log) this.log(this.samsungLogEl, line, "info");
      if (res.ok && res.target) {
        this.log(this.samsungLogEl, `✅ ${t("tools.done", { path: res.target })}`, "success");
        // Жива копія не тронута: у дампі не було журналу NVRAM-пулу розділу eMMC
        // (або це дамп мікросхеми 24C512). Це НЕ відмова — операція виконана, —
        // але регіон на працюючому ТВ такий патч не змінить, тому майстер бачить
        // чесне попередження, а не зелений успіх без пояснень.
        if (res.flatOnly) {
          this.log(this.samsungLogEl, `⚠️ ${t("tools.warn_flat_only")}`, "warn");
        }
      } else if (res.ok) {
        this.log(this.samsungLogEl, "✅ Check-only: nothing written", "success");
      }
    } catch (e: any) {
      this.log(
        this.samsungLogEl,
        t("tools.patch_failed", { reason: e?.message ?? String(e) }),
        "error",
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Запросити grant у сервера (тільки для дампа розділу eMMC).
   *
   * `undefined` — відмова/мережа: патч не запускаємо, показуємо причину. Власник
   * отримує `kind: "owner"` без списання; майстер із ДІЮЧИМ пакетом — `package`
   * (ціна платної операції і є строк пакета, D-151: бали не списуються, пробні
   * спроби не витрачаються); без пакета працює ліміт пробних спроб
   * (`geo_unlock.trial_limit`), після нього сервер віддає 402.
   */
  private async requestGrant(): Promise<GeoGrant | undefined> {
    try {
      const res = await api.geoUnlockGrant("samsung_p31");
      const grant: GeoGrant = { id: res.id, kind: res.kind };
      // Счётчик у карточці оновлюємо ТІЄЮ ж відповіддю, що видала grant:
      // окремий запит /status після кожної операції тут зайвий (D-173).
      this.unlockStatus = {
        kind: res.kind === "paid" ? "package" : res.kind,
        unlocks_left: res.package_unlocks_left,
        trial_left: res.trial_left,
        trial_limit: res.trial_limit,
        tool: res.tool,
      };
      if (res.kind === "owner") {
        this.log(this.samsungLogEl, `🔓 ${t("tools.grant_owner")}`, "success");
      } else if (res.kind === "package") {
        // Ціна операції — одна разблокировка пакета; показуємо остаток, щоб
        // майстер бачив, на скільки ще вистачить (D-173).
        this.log(
          this.samsungLogEl,
          `✅ ${
            res.package_unlocks_left === null
              ? t("tools.grant_package_unlimited")
              : t("tools.grant_package", { left: res.package_unlocks_left })
          }`,
          "success",
        );
      } else if (res.kind === "trial") {
        this.log(
          this.samsungLogEl,
          `🎟 ${t("tools.grant_trial", { left: res.trial_left, limit: res.trial_limit })}`,
          "success",
        );
      }
      this.renderUnlockCounter();
      return grant;
    } catch (e: any) {
      // 402 — пакет не діє і пробні спроби вичерпані: показуємо людську причину,
      // а не сирий `API 402: {"error":...}`.
      const reason =
        e?.status === 402 ? t("tools.grant_no_package") : (e?.message ?? String(e));
      this.log(this.samsungLogEl, `❌ ${t("tools.grant_failed", { reason })}`, "error");
      return undefined;
    }
  }

  /** Вердикт тарифу в бейджі (free / paid). */
  private renderTier(): void {
    if (!this.tierBadgeEl) return;
    if (this.samsungKind === null) {
      this.tierBadgeEl.textContent = "";
      return;
    }
    this.tierBadgeEl.textContent =
      this.samsungKind === "nvm24c512"
        ? `💚 ${t("tools.tier_free")}`
        : `💰 ${t("tools.tier_paid")}`;
  }


  // ── LG NVM ────────────────────────────────────────────────────────────────

  private async pickLg(): Promise<void> {
    try {
      const picked = (await open({
        multiple: false,
        directory: false,
        title: t("tools.pick_dump"),
      })) as string;
      if (!picked) return;
      this.lgPath = picked;
      this.clearLog(this.lgLogEl);
      this.lgPathEl.textContent = picked;
      this.setButtons();
      this.log(this.lgLogEl, `Selected: ${picked}`, "info");
      await this.scanLg();
    } catch (e: any) {
      this.log(this.lgLogEl, `❌ Pick error: ${e?.message ?? String(e)}`, "error");
    }
  }

  /** Скан LG NVM (безкоштовно, без grant'а — розблокування старих моделей). */
  private async scanLg(): Promise<void> {
    if (!this.lgPath) return;
    const path = this.lgPath;
    this.setBusy(true);
    try {
      const scan = await invoke<LgScanResult>("geo_lg_scan", { path });
      this.clearLog(this.lgLogEl);
      for (const line of scan.log) this.log(this.lgLogEl, line, "info");
      this.log(this.lgLogEl, t("tools.lg_candidates", { n: scan.candidates.length }), "info");
      for (const cand of scan.candidates) {
        this.log(
          this.lgLogEl,
          `offset=0x${cand.offset.toString(16)} value=0x${cand.value.toString(16)} ` +
            `country=${cand.country} lang=${cand.lang} hw=${cand.hw} score=${cand.score}`,
          "info",
        );
      }
      if (!scan.ok) {
        this.log(this.lgLogEl, `⚠️ ${t("tools.lg_none")}`, "warn");
      }
    } catch (e: any) {
      this.log(this.lgLogEl, t("tools.scan_failed", { reason: e?.message ?? String(e) }), "error");
    } finally {
      this.setBusy(false);
    }
  }

  /** Патч Area Option LG — безкоштовний для всіх (grant не потрібен). */
  private async patchLg(): Promise<void> {
    if (!this.lgPath || this.busy) return;
    const value = this.parseLgValue();
    if (value === null) return;

    // Запис — ЗАВЖДИ в новий файл (in-place заборонений контрактом main). Режиму
    // «тільки перевірка» тут більше немає: для звіту є кнопка «Перевірити дамп»,
    // а 0 у полі — це справжній регіон (NORDIC), а не «нічого не писати» (D-154).
    const path = this.lgPath;
    const out = await this.pickOutput(path, this.lgLogEl);
    if (!out) return;

    this.setBusy(true);
    try {
      const res = await invoke<LgPatchResult>("geo_lg_patch", {
        path,
        out,
        newValue: value,
        dryRun: false,
      });
      this.clearLog(this.lgLogEl);
      for (const line of res.log) this.log(this.lgLogEl, line, "info");
      if (res.ok && res.target) {
        this.log(this.lgLogEl, `✅ ${t("tools.done", { path: res.target })}`, "success");
      }
    } catch (e: any) {
      this.log(this.lgLogEl, t("tools.patch_failed", { reason: e?.message ?? String(e) }), "error");
    } finally {
      this.setBusy(false);
    }
  }


  // ── Допоміжне ─────────────────────────────────────────────────────────────

  /** Код регіону з поля вводу: hex 0..FF або null (помилку показано в лог). */
  private parseRegion(): number | null {
    const raw = (this.regionInput?.value ?? "").trim().replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,2}$/i.test(raw)) {
      this.log(this.samsungLogEl, `❌ region: очікується hex 0..FF (отримано "${raw}")`, "error");
      return null;
    }
    return parseInt(raw, 16);
  }

  /** Area Option LG: десяткове число або 0x-hex, 0..0xFFFF; null — значення немає. */
  private lgValueOrNull(): number | null {
    const raw = (this.lgValueInput?.value ?? "").trim();
    if (raw === "") return null;
    const isHex = /^0x[0-9a-f]+$/i.test(raw);
    // Порожній рядок НЕ можна віддавати в Number(): Number("") === 0, і порожнє поле
    // мовчки стало б регіоном NORDIC (D-154).
    if (!isHex && !/^\d+$/.test(raw)) return null;
    const value = isHex ? parseInt(raw.slice(2), 16) : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    return value;
  }

  /** Те саме, але з поясненням у лог (клік по кнопці). */
  private parseLgValue(): number | null {
    const value = this.lgValueOrNull();
    if (value === null) {
      const raw = (this.lgValueInput?.value ?? "").trim();
      this.log(this.lgLogEl, `❌ Area Option: очікується 0..65535 (отримано "${raw}")`, "error");
      return null;
    }
    return value;
  }

  /**
   * Куди зберегти результат: НОВИЙ файл поруч із дампом (in-place заборонено).
   *
   * `logEl` — куди писати причину відмови: у LG-картці свій лог, і повідомлення
   * про скасований діалог не має з'являтися в логу Samsung.
   */
  private async pickOutput(
    inputPath: string,
    logEl: HTMLElement = this.samsungLogEl,
  ): Promise<string | undefined> {
    try {
      const base = inputPath.replace(/\.[^./\\]+$/, "");
      const picked = (await save({
        title: t("tools.save_title"),
        defaultPath: `${base}.patched.bin`,
      })) as string;
      if (!picked) {
        this.log(logEl, "Cancelled by the user", "warn");
        return undefined;
      }
      return picked;
    } catch (e: any) {
      this.log(logEl, `❌ Save dialog error: ${e?.message ?? String(e)}`, "error");
      return undefined;
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.setButtons();
  }

  private setButtons(): void {
    const hasSamsung = !!this.samsungPath && !this.busy;
    const hasLg = !!this.lgPath && !this.busy;
    // «Застосувати…» потребує і дампу, і ВАЛІДНОГО значення: порожнє поле — не 0,
    // а «значення ще не введене», тому кнопка мовчить, а не пише помилку в лог (D-154).
    const lgValueOk = this.lgValueOrNull() !== null;
    if (this.checkSamsungBtn) this.checkSamsungBtn.disabled = !hasSamsung;
    if (this.patchSamsungBtn) this.patchSamsungBtn.disabled = !hasSamsung;
    if (this.scanLgBtn) this.scanLgBtn.disabled = !hasLg;
    if (this.patchLgBtn) this.patchLgBtn.disabled = !hasLg || !lgValueOk;
  }

  private clearLog(el: HTMLElement | undefined): void {
    if (el) el.innerHTML = "";
  }

  private log(
    el: HTMLElement | undefined,
    message: string,
    kind: "info" | "success" | "warn" | "error" = "info",
  ): void {
    if (!el) return;
    const line = document.createElement("div");
    line.className = `log-line log-${kind}`;
    line.textContent = message;
    el.appendChild(line);
    while (el.childElementCount > 400) {
      el.removeChild(el.firstChild as Node);
    }
    el.scrollTop = el.scrollHeight;
  }
}

/** Один рядок звіту по знайденій копії (логи — англійською, конвенція репозиторію). */
function describeCopy(copy: CopyInfo): string {
  if (copy.kind === "record") {
    const array = copy.arrayBase === undefined ? "?" : `0x${copy.arrayBase.toString(16)}`;
    const span = copy.span === undefined ? "?" : `0x${copy.span.toString(16)}`;
    return (
      `record: array=${array} span=${span} seq=${copy.seq ?? "?"} ` +
      `region=0x${copy.regionPos.toString(16)} valid=${copy.valid === true}`
    );
  }
  const base = copy.imageBase === undefined ? "?" : `0x${copy.imageBase.toString(16)}`;
  const old = copy.oldRegion === null ? "?" : `0x${copy.oldRegion.toString(16)}`;
  return `image: base=${base} region=${old} crcOk=${copy.crcOk === true}`;
}

