/**
 * BillingPage — UI магазина пакетов баллов (Monobank Personal).
 *
 * Flow:
 *   1. Загружает список пакетов с /api/v1/billing/packages
 *   2. Отображает карточки с ценами в гривнах
 *   3. При клике на карточку → открывается модалка подтверждения
 *   4. Кнопка "Оплатити Monobank" → createInvoice → pay_url
 *   5. Копирует payment_code в буфер обмена
 *   6. Кнопка "Відкрити Monobank" → open_url (Tauri)
 *   7. После оплаты (через WebSocket) → обновление баланса
 */

import { invoke } from "@tauri-apps/api/core";
import { api, BillingPackage, CreateInvoiceResponse } from "../api";
import { t, tLoose } from "../i18n";

/**
 * 3D-иконка карточки пакета (ассет лежит в `public/`, копируется в корень сборки).
 *
 * ⚠️ Путь ОБЯЗАН быть относительным («btn-coins-3d.png»), а не «/btn-coins-3d.png»
 * (BUG-ELECTRON-ASSET-001): релизный renderer Electron открывает по `file://`
 * (`win.loadFile("…/dist-renderer/index.html")`), где абсолютный путь уводит в
 * корень файловой системы (на Windows — в корень диска `C:`), и иконки в карточках
 * магазина молча не загружаются. В dev (Vite-сервер по http) тот же абсолютный
 * путь работает, поэтому дефект виден только в сборке/e2e/релизе.
 * Vite переписывает пути ассетов только в `index.html`, runtime-шаблоны
 * TypeScript не трогает — значит корректный путь задаётся здесь.
 * Резолвится от документа → работает и в dev (http), и в сборке (file://),
 * и в Tauri-mainline (`http://tauri.localhost/`).
 *
 * Гейт: `npm run verify:renderer-assets` (scripts/verify-renderer-assets.mjs).
 */
const PKG_CARD_ICON_URL = new URL("btn-coins-3d.png", document.baseURI).href;

export class BillingPage {
  private container: HTMLElement;
  private tgIdCallback: () => number;
  private onNotify: (message: string, type: "success" | "error" | "info") => void;
  private onBalanceUpdate: () => void;

  // Состояние
  private packages: BillingPackage[] = [];
  private currentInvoice: CreateInvoiceResponse | null = null;
  private isLoading: boolean = false;
  // Последний купленный пакет (для отображения success-сообщения в UI)
  private _lastPurchasedPkg: BillingPackage | null = null;

  constructor(
    container: HTMLElement,
    tgIdCallback: () => number,
    onNotify?: (message: string, type: "success" | "error" | "info") => void,
    onBalanceUpdate?: () => void,
  ) {
    this.container = container;
    this.tgIdCallback = tgIdCallback;
    this.onNotify = onNotify || (() => {});
    this.onBalanceUpdate = onBalanceUpdate || (() => {});
  }

  /**
   * Название пакета — ТОЛЬКО серверное: админка (таблица `billing_packages`) —
   * источник истины (BUG-ADMIN-PKG-TEXT-001).
   *
   * Раньше здесь сначала искался ключ локали `billing.packages.<id>.name`, и для
   * известных пакетов он был захардкожен с устаревшими баллами. Владелец правил
   * пакет в админке, а карточка магазина продолжала показывать старое («25 баллов»)
   * — выглядело как «в админке сохранилось, в клиенте ничего не изменилось».
   * Данные пакета не переводятся: i18n — только «хром» интерфейса.
   */
  private _pkgName(pkg: BillingPackage): string {
    return pkg.name;
  }

  /** Описание пакета — ТОЛЬКО серверное (см. `_pkgName`). */
  private _pkgDesc(pkg: BillingPackage): string {
    return pkg.description;
  }

  /** Загрузить пакеты и отрендерить карточки */
  async loadPackages(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      const res = await api.listPackages();
      this.packages = res.packages;
      this.render();
    } catch (e: any) {
      console.error("[BillingPage] Failed to load packages:", e);
      this.container.innerHTML = `
        <div class="card" style="padding:24px; text-align:center;">
          <p style="color:var(--danger);">${t("billing.load_error", { err: e?.message ?? "unknown" })}</p>
          <button class="btn btn-secondary" onclick="location.reload()">${t("billing.retry")}</button>
        </div>
      `;
    } finally {
      this.isLoading = false;
    }
  }

  /** Локализованная строка бонуса личного хранилища пакета (пусто — нет бонуса). */
  private _vaultBonus(pkg: BillingPackage): { label: string; standalone: boolean } {
    if (pkg.is_vault_standalone) {
      const days = pkg.vault_days ?? 0;
      return {
        label: `🗄️ ${tLoose("vault.package_standalone", { days })}`,
        standalone: true,
      };
    }
    const days = pkg.grants_vault_bonus_days ?? 0;
    if (days > 0) {
      return {
        label: `🗄️ ${tLoose("vault.package_bonus", { days })}`,
        standalone: false,
      };
    }
    return { label: "", standalone: false };
  }

  /** Локализованное пояснение «Личное хранилище» для описания пакета (пусто — нет ЛХ). */
  private _vaultNote(pkg: BillingPackage): string {
    if (pkg.is_vault_standalone) {
      return tLoose("vault.note_standalone", { days: pkg.vault_days ?? 0 });
    }
    const days = pkg.grants_vault_bonus_days ?? 0;
    if (days > 0) {
      return tLoose("vault.note_bonus", { days });
    }
    return "";
  }

  /** Рендер карточек пакетов */
  private render(): void {
    if (this.packages.length === 0) {
      this.container.innerHTML = `
        <div class="card" style="padding:24px; text-align:center;">
          <p style="color:var(--text-dim);">${t("billing.no_packages")}</p>
        </div>
      `;
      return;
    }

    let html = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px;">`;

    for (const pkg of this.packages) {
      const isPopular = pkg.popular ?? false;
      const popularBadge = isPopular
        ? `<span class="billing-badge-popular">${t("billing.popular")}</span>`
        : "";
      const vault = this._vaultBonus(pkg);
      const vaultLine = vault.label
        ? `<div class="billing-card-vault">${vault.label}</div>`
        : "";
      const vaultNote = vault.label ? this._vaultNote(pkg) : "";
      const vaultNoteLine = vaultNote
        ? `<div class="billing-card-vault-note">${vaultNote}</div>`
        : "";
      const pointsLine = vault.standalone
        ? `<div class="billing-card-points">🗄️ ${pkg.vault_days ?? 0} ${tLoose("vault.days_short")}</div>`
        : `<div class="billing-card-points">${t("header.balance", { n: pkg.points })}</div>`;
      html += `
        <div class="billing-package-card" data-package-id="${pkg.id}"${isPopular ? ' data-popular="true"' : ""}>
          ${popularBadge}
          <img src="${PKG_CARD_ICON_URL}" alt="" class="billing-card-icon" />
          <div class="billing-card-name">${this._pkgName(pkg)}</div>
          <div class="billing-card-desc">${this._pkgDesc(pkg)}</div>
          ${vaultLine}
          ${vaultNoteLine}
          <div class="billing-card-price">${pkg.price_uah} ₴</div>
          ${pointsLine}
        </div>
      `;
    }

    html += `</div>
      <div id="billingModal" class="modal-overlay" style="display:none;">
        <div class="modal-content" style="max-width:420px;">
          <div id="billingModalBody"></div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;

    // Привязка событий клика на карточки — с переключением .selected
    const allCards = this.container.querySelectorAll(".billing-package-card");
    allCards.forEach((card) => {
      card.addEventListener("click", () => {
        // Снимаем .selected со всех карточек
        allCards.forEach((c) => c.classList.remove("selected"));
        // Ставим .selected на кликнутую
        card.classList.add("selected");

        const pkgId = (card as HTMLElement).dataset.packageId;
        const pkg = this.packages.find((p) => p.id === pkgId);
        if (pkg) this.showModal(pkg);
      });
    });
  }

  /** Показать модалку подтверждения для выбранного пакета */
  private showModal(pkg: BillingPackage): void {
    const modal = document.getElementById("billingModal");
    const body = document.getElementById("billingModalBody");
    if (!modal || !body) return;

    const tgId = this.tgIdCallback();
    if (!tgId || tgId <= 0) {
      body.innerHTML = `
        <div style="text-align:center;">
          <h3 style="margin-bottom:8px;">❌ ${t("common.error")}</h3>
          <p style="color:var(--text-dim); font-size:13px;">${t("billing.no_tgid")}</p>
          <button class="btn btn-secondary" onclick="document.getElementById('billingModal').style.display='none'">${t("common.close")}</button>
        </div>
      `;
      modal.style.display = "flex";
      return;
    }

    this.currentInvoice = null;

    const vault = this._vaultBonus(pkg);
    const vaultModalLine = vault.label
      ? `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
          <span style="font-size:14px;">🗄️ ${tLoose("vault.package_label")}</span>
          <span style="font-size:14px; font-weight:600; color:var(--success, #10b981);">${vault.label}</span>
        </div>`
      : "";
    const vaultNote = vault.label ? this._vaultNote(pkg) : "";
    const vaultNoteLine = vaultNote
      ? `<p style="font-size:12px; color:var(--text-dim); line-height:1.45; background:var(--surface2); border-radius:6px; padding:8px 10px; margin:0 0 12px;">${vaultNote}</p>`
      : "";

    body.innerHTML = `
      <h3 style="margin-bottom:12px;">${this._pkgName(pkg)}</h3>
      <p style="font-size:13px; color:var(--text-dim); margin-bottom:16px;">${this._pkgDesc(pkg)}</p>
      ${vaultModalLine}
      ${vaultNoteLine}
      <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
        <span style="font-size:14px;">${t("billing.sum")}</span>
        <span style="font-size:16px; font-weight:700; color:var(--accent);">${pkg.price_uah} ₴</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
        <span style="font-size:14px;">${t("billing.points_label")}</span>
        <span style="font-size:16px; font-weight:700;">💰 ${pkg.points}</span>
      </div>
      <div style="display:flex; justify-content:space-between; padding:8px 0; margin-bottom:16px;">
        <span style="font-size:14px;">${t("billing.payment_code_label")}</span>
        <span style="font-size:13px; font-family:monospace; background:var(--surface2); padding:2px 8px; border-radius:4px;" id="paymentCodeDisplay">FW-${tgId}</span>
      </div>
      <div id="invoiceProgress" style="display:none; text-align:center; padding:12px 0;">
        <span style="color:var(--text-dim);">${t("billing.generating_invoice")}</span>
      </div>
      <div id="invoiceResult" style="display:none;">
        <div style="background:var(--surface2); border-radius:8px; padding:12px; margin-bottom:12px; word-break:break-all;">
          <div style="font-size:11px; color:var(--text-dim); margin-bottom:4px;">${t("billing.payment_link")}</div>
          <div style="font-size:12px; font-family:monospace;" id="payUrlDisplay"></div>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
          <button class="btn btn-primary" id="openMonobankBtn" style="flex:1;">${t("billing.open_monobank")}</button>
          <button class="btn btn-secondary" id="copyUrlBtn" style="flex:1;">${t("common.copy")}</button>
        </div>
        <p style="font-size:11px; color:var(--text-dim); text-align:center;">
          ${t("billing.after_payment_note")}
        </p>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn btn-primary" id="payMonobankBtn" style="flex:1;">${t("billing.pay_monobank")}</button>
        <button class="btn btn-secondary" id="closeModalBtn">✕</button>
      </div>
    `;

    modal.style.display = "flex";

    // Привязка событий
    const payBtn = document.getElementById("payMonobankBtn");
    const closeBtn = document.getElementById("closeModalBtn");
    const openMonoBtn = document.getElementById("openMonobankBtn");
    const copyBtn = document.getElementById("copyUrlBtn");

    payBtn?.addEventListener("click", () => this.handlePayment(pkg, tgId));
    closeBtn?.addEventListener("click", () => { modal.style.display = "none"; });

    if (openMonoBtn) {
      openMonoBtn.addEventListener("click", () => {
        if (this.currentInvoice) {
          this.openInBrowser(this.currentInvoice.pay_url);
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        if (this.currentInvoice) {
          this.copyToClipboard(this.currentInvoice.pay_url);
        }
      });
    }

    // Закрытие по клику на overlay
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
  }

  /** Обработка платежа — вызов createInvoice */
  private async handlePayment(pkg: BillingPackage, tgId: number): Promise<void> {
    const progress = document.getElementById("invoiceProgress");
    const result = document.getElementById("invoiceResult");
    const payBtn = document.getElementById("payMonobankBtn");
    const paymentCodeEl = document.getElementById("paymentCodeDisplay");

    if (progress) progress.style.display = "block";
    if (payBtn) (payBtn as HTMLButtonElement).disabled = true;

    try {
      const invoice = await api.createInvoice(tgId, pkg.id);
      this.currentInvoice = invoice;
      // Запоминаем пакет для отображения success-сообщения после оплаты
      this._lastPurchasedPkg = pkg;

      if (progress) progress.style.display = "none";
      if (result) result.style.display = "block";
      if (payBtn) payBtn.style.display = "none";

      // Показываем payment URL
      const urlDisplay = document.getElementById("payUrlDisplay");
      if (urlDisplay) urlDisplay.textContent = invoice.pay_url;

      // Копируем payment_code в буфер обмена
      if (paymentCodeEl) {
        paymentCodeEl.textContent = invoice.payment_code;
      }
      this.copyToClipboard(invoice.payment_code);

      console.log("[BillingPage] Invoice created:", invoice);

      // Показываем toast-уведомление об успешном создании инвойса
      this.onNotify(
        t("billing.toast_created", { price: pkg.price_uah }),
        "success",
      );

      // Немедленно обновить баланс в заголовке (страховка, если WS ещё не подключён)
      this.onBalanceUpdate();
    } catch (e: any) {
      console.error("[BillingPage] createInvoice failed:", e);
      if (progress) progress.style.display = "none";

      const payBtnNew = document.getElementById("payMonobankBtn");
      if (payBtnNew) {
        payBtnNew.textContent = t("billing.retry_pay");
        (payBtnNew as HTMLButtonElement).disabled = false;
      }

      // Показываем ошибку в модалке
      const body = document.getElementById("billingModalBody");
      if (body) {
        const errDiv = document.createElement("div");
        errDiv.style.cssText = "color:var(--danger); font-size:12px; margin-top:8px; text-align:center;";
        errDiv.textContent = `❌ ${e?.message ?? t("billing.invoice_error_fallback")}`;
        body.appendChild(errDiv);
      }

      // Показываем toast-уведомление об ошибке
      this.onNotify(
        t("billing.toast_create_error", { err: e?.message ?? "unknown" }),
        "error",
      );
    }
  }

  /**
   * Показать сообщение об успешной оплате.
   * - Если модалка с pay_url открыта — заменяет её содержимое на success
   * - Добавляет success-бanner в контейнер магазина (не исчезает)
   * - Сохраняется до следующей покупки или перезапуска клиента
   * Вызывается из App.ts при получении balance_update через WebSocket.
   */
  public onPaymentSuccess(delta: number): void {
    const pkg = this._lastPurchasedPkg;
    this._lastPurchasedPkg = null; // сбрасываем

    // Удаляем предыдущее success-сообщение в контейнере, если есть
    const oldMsg = this.container.querySelector(".billing-success-msg");
    if (oldMsg) oldMsg.remove();

    let message: string;
    if (pkg) {
      message = t("billing.payment_success_pkg", { n: delta, name: this._pkgName(pkg) });
    } else {
      message = t("billing.payment_success", { n: delta });
    }

    // 1. Если модальное окно с pay_url открыто — заменяем его содержимое
    const modal = document.getElementById("billingModal");
    const modalBody = document.getElementById("billingModalBody");
    if (modal && modalBody && modal.style.display !== "none") {
      modalBody.innerHTML = `
        <div style="text-align:center; padding:24px 12px;">
          <div style="font-size:48px; margin-bottom:12px;">✅</div>
          <h3 style="color:#2ecc71; margin-bottom:8px;">${t("billing.payment_success_title")}</h3>
          <p style="font-size:16px; font-weight:600; color:var(--text); margin-bottom:4px;">
            ${t("billing.payment_success_points", { n: delta })}
          </p>
          ${pkg ? `<p style="font-size:13px; color:var(--text-dim);">${t("billing.package_name", { name: this._pkgName(pkg) })}</p>` : ""}
          <p style="font-size:12px; color:var(--text-dim); margin-top:12px;">
            ${t("billing.thanks")}
          </p>
          <button class="btn btn-secondary" style="margin-top:16px;"
            onclick="document.getElementById('billingModal').style.display='none'">
            ${t("common.close")}
          </button>
        </div>
      `;
    }

    // 2. Persistent banner в контейнере магазина (сохраняется до след. покупки)
    const successEl = document.createElement("div");
    successEl.className = "billing-success-msg";
    successEl.style.cssText = `
      padding: 16px 20px;
      margin-bottom: 16px;
      border-radius: 10px;
      background: linear-gradient(135deg, #1a3a2a 0%, #0d2818 100%);
      border: 1px solid #2ecc7140;
      color: #2ecc71;
      font-size: 14px;
      font-weight: 600;
      text-align: center;
      animation: toastIn 0.3s ease-out;
    `;
    successEl.textContent = message;

    // Вставляем в начало контейнера (перед карточками)
    this.container.insertBefore(successEl, this.container.firstChild);
  }

  /** Открыть URL в системном браузере через Tauri */
  private async openInBrowser(url: string): Promise<void> {
    try {
      await invoke("open_url", { url });
    } catch (e: any) {
      console.error("[BillingPage] Failed to open URL:", e);
      // Fallback: копируем в буфер и показываем сообщение
      this.copyToClipboard(url);
      alert(t("billing.browser_failed", { url }));
    }
  }

  /**
   * Перерисовать пакеты после смены языка.
   *
   * Выполняется независимо от активности вкладки — иначе «Магазин» останется
   * на старом языке до повторного открытия (инцидент: «язык переключается с
   * задержкой»). render() работает из сохранённого this.packages (без сети).
   */
  applyLang(): void {
    if (this.packages.length > 0) {
      this.render();
    }
  }

  /** Копирование текста в буфер обмена */
  private copyToClipboard(text: string): void {
    try {
      navigator.clipboard.writeText(text).catch(() => {
        // Fallback для старых WebView
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      });
    } catch (e) {
      console.warn("[BillingPage] Clipboard copy failed:", e);
    }
  }
}
