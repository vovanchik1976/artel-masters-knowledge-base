/**
 * FaqPage — справка клиента (FAQ).
 *
 * Источник контента — публичный `GET /api/v1/faq?lang=uk|ru|en` (без авторизации).
 * Сервер отдаёт ПЛОСКИЙ локализованный документ: разделы уже переведены, поэтому
 * клиент ничего не переводит — только рендерит.
 *
 * Язык контента = язык интерфейса (i18n), но серверная цепочка языков шире:
 *   запрошенный → UK → RU.
 * Если перевода для запрошенного языка ещё нет, сервер отдаёт RU и выставляет
 * `fallback_used` — в этом случае над списком показывается честный баннер
 * («перевод недоступен, показан RU»), иначе пользователь решит, что это перевод.
 *
 * Особенности:
 *   • ленивая загрузка — первый запрос только при открытии вкладки (`ensureLoaded`);
 *   • `applyLang()` перезапрашивает документ при смене языка (контент серверный!);
 *   • каждая секция — карточка с icon + title + body (переносы строк сохраняются);
 *   • ошибка сети не роняет вкладку: рисуется сообщение + кнопка «Повторить».
 *
 * Спецификация: docs/FAQ_ARCHITECTURE.md §7 (Desktop UI).
 */

import { api } from "../api";
import type { FaqSection } from "../api";
import { t, getLang } from "../i18n";

export class FaqPage {
  private container: HTMLElement;

  /** Загруженные разделы (уже локализованы сервером). */
  private sections: FaqSection[] = [];
  /** Язык, для которого загружен текущий документ (ключ кэша). */
  private loadedLang: string | null = null;
  /** Фактически отданный сервером язык, если он отличается от запрошенного. */
  private fallbackUsed: string | null = null;
  /** Ревизия документа (диагностика/инвалидация кэша). */
  private revision: number = -1;
  /** Защита от параллельных запросов (быстрые клики по вкладке). */
  private isLoading: boolean = false;
  /**
   * Поколение запроса: инкремент на каждый `load()`. Ответ устаревшего
   * поколения отбрасывается — иначе при смене языка во время запроса
   * отрисовывался документ ПРЕДЫДУЩЕГО языка (язык «залипал» до след. клика).
   * Тот же паттерн, что в DownloadPage/UploadPage (см. BUG-CANCEL-RESUME-001).
   */
  private _epoch: number = 0;
  /** Последняя ошибка загрузки (null — ошибки нет). */
  private lastError: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderPlaceholder();
  }

  /** Каркас до первой загрузки. */
  private renderPlaceholder(): void {
    this.container.innerHTML = `
      <div style="padding:24px; text-align:center; color:var(--text-dim); font-size:13px;">
        <div style="font-size:32px; margin-bottom:8px;">❓</div>
        ${t("faq.loading")}
      </div>
    `;
  }

  /** Ленивая загрузка: первый запрос при открытии вкладки. */
  async ensureLoaded(): Promise<void> {
    await this.load();
  }

  /** Принудительное обновление (кнопка «Обновить»). */
  async refresh(): Promise<void> {
    await this.load(true);
  }

  /**
   * Загрузить документ для текущего языка интерфейса.
   *
   * @param force — игнорировать кэш (кнопка «Обновить»/смена языка).
   */
  private async load(force: boolean = false): Promise<void> {
    const lang = getLang();
    // Идёт запрос: обычный клик по вкладке не должен плодить дубликаты,
    // а смена языка/«Обновить» (force) — обязана перебить текущий запрос.
    if (this.isLoading && !force) return;
    if (!force && this.loadedLang === lang && !this.lastError) return;

    const epoch = ++this._epoch;
    this.isLoading = true;
    this.lastError = null;

    try {
      const res = await api.getFaq(lang);
      if (epoch !== this._epoch) return;  // устаревший ответ — не рисуем
      this.sections = res.sections || [];
      this.fallbackUsed = res.fallback_used ?? null;
      this.revision = res.revision;
      this.loadedLang = lang;
      this.render();
    } catch (e: any) {
      if (epoch !== this._epoch) return;
      console.error("[FaqPage] Failed to load FAQ:", e);
      this.lastError = String(e?.message ?? e);
      this.loadedLang = null;
      this.render();
    } finally {
      if (epoch === this._epoch) {
        this.isLoading = false;
        // Язык мог смениться, пока шёл запрос: контент серверный, поэтому нужен
        // документ нового языка (loadedLang уже «наш» → ensureLoaded вернул бы
        // кэш, и на экране остался бы старый язык).
        if (!this.lastError && this.loadedLang !== getLang()) void this.load(true);
      }
    }
  }

  /** Строка статуса (пусто/загрузка) — переиспользуется в render(). */
  private renderStatus(text: string): void {
    this.container.innerHTML = `
      <div style="padding:20px; text-align:center; color:var(--text-dim); font-size:13px;">
        ${text}
      </div>
    `;
  }

  /**
   * Отрендерить документ из сохранённого состояния (без сети).
   *
   * Вызывается и после загрузки, и при смене языка — поэтому обязана полностью
   * восстанавливать вид из полей класса.
   */
  private render(): void {
    if (this.lastError) {
      this.container.innerHTML = `
        <div style="padding:20px; border-radius:10px; border:1px solid #ef444440;
                    background:#ef44441a; color:var(--error); font-size:13px;">
          <div style="margin-bottom:10px;">
            ${t("faq.error", { err: this.escapeHtml(this.lastError) })}
          </div>
          <button id="faqRetryBtn"
                  style="font-size:12px; padding:6px 14px; border-radius:6px;
                         background:var(--surface2); border:1px solid var(--glass-border);
                         color:var(--text); cursor:pointer;">
            ${t("faq.refresh")}
          </button>
        </div>
      `;
      this.container
        .querySelector<HTMLElement>("#faqRetryBtn")
        ?.addEventListener("click", () => void this.refresh());
      return;
    }

    if (this.sections.length === 0) {
      this.renderStatus(t("faq.empty"));
      return;
    }

    const banner = this.fallbackUsed
      ? `<div style="margin-bottom:12px; padding:8px 12px; border-radius:8px;
                     background:#f59e0b1a; border:1px solid #f59e0b40;
                     color:var(--warning); font-size:12px;">
           ${t("faq.fallback_banner", { lang: this.fallbackUsed.toUpperCase() })}
         </div>`
      : "";

    const cards = this.sections.map((s) => this.renderSection(s)).join("");

    this.container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:flex-end;
                  gap:12px; margin-bottom:10px; flex-wrap:wrap;">
        <button id="faqRefreshBtn"
                style="font-size:12px; padding:5px 12px; border-radius:6px;
                       background:var(--surface2); border:1px solid var(--glass-border);
                       color:var(--text); cursor:pointer;">
          ${t("faq.refresh")}
        </button>
      </div>
      ${banner}
      <div style="display:flex; flex-direction:column; gap:10px;">${cards}</div>
    `;

    this.container
      .querySelector<HTMLElement>("#faqRefreshBtn")
      ?.addEventListener("click", () => void this.refresh());
  }

  /** Карточка раздела: icon + title + body (переносы строк сохраняются). */
  private renderSection(section: FaqSection): string {
    const icon = section.icon
      ? `<span style="font-size:18px; flex:0 0 auto;">${this.escapeHtml(section.icon)}</span>`
      : "";
    return `
      <div style="padding:14px 16px; border-radius:10px; background:var(--surface2);
                  border:1px solid var(--glass-border);">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          ${icon}
          <span style="font-size:15px; font-weight:600; color:var(--text);">
            ${this.escapeHtml(section.title)}
          </span>
        </div>
        <div style="font-size:13px; line-height:1.55; color:var(--text-dim);
                    white-space:pre-wrap;">${this.escapeHtml(section.body)}</div>
      </div>
    `;
  }

  /**
   * Смена языка: контент FAQ серверный → документ перезапрашивается.
   * Если загрузки ещё не было, остаётся плейсхолдер (запрос сделает
   * ensureLoaded() при открытии вкладки — не грузим FAQ «в фоне»).
   */
  applyLang(): void {
    if (this.loadedLang === null && !this.lastError) {
      this.renderPlaceholder();
      return;
    }
    void this.load(true);
  }

  /** HTML-экранирование серверного текста (FAQ — недоверенный контент). */
  private escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}