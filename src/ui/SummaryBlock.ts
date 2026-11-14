/**
 * SummaryBlock — сводка по файлу + блок «что ещё скачать» (SP-19 S1b, `D-087`).
 *
 * Приказ владельца (2026-10-15): поверхность карточки — не чат, а **готовая
 * сводка** («что это, что болит, что проверить»), под ней — список того, что
 * лежит рядом по тому же аппарату. Сводку строит фоном сервер
 * (`scripts/ai_summary_worker.py`), HTTP-путь карточки её только читает: у
 * мастера нет 147-секундного ожидания. Список файлов строит SQL на сервере —
 * клиент ничего не выдумывает и не сортирует по-своему.
 *
 * Инварианты:
 * - сводка приходит уже готовой; клиент НЕ показывает «анализ идёт» на весь
 *   экран: `summary_status` = `pending` → короткая строка «готовится»
 *   (Fail-open: карточка работает и без текста);
 * - ссылки-источники — отдельным списком (`sources[]`): в самом тексте сводки
 *   сырых `href` не бывает (§4 п.9), поэтому текст всегда экранируется;
 * - блок скачивания — кнопки-файлы из `storage[]`; клик отдаётся наверх
 *   (`onDownload`) — сам блок цену/лимиты не считает (SP-09);
 * - смена языка (`applyLang`) перерисовывает подписи из уже полученных данных,
 *   без нового запроса.
 */
import { formatSources, type SourcePayload } from "./sources";
import { formatBytes } from "./format";
import { t, type Key } from "../i18n";

/** Один соседний файл в блоке «что ещё скачать» (контракт §3, S1b). */
export interface CardStorageItem {
  id: number;
  brand: string;
  model: string;
  version: string;
  size_bytes: number;
  content_kind: string;
  download_strategy: string;
  /** 1 — та же модель, 2 — то же шасси, 3 — тот же бренд (сервер решает, клиент подписывает). */
  tier: number;
}

/** Запись опыта мастера под сводкой (SP-19 S4) — «что помогло». */
export interface CardFormEntry {
  dm_id: number;
  text: string;
  votes: number;
  verified: boolean;
  mine: boolean;
}

/** «Кто скачал» (D-134): имена без телефонов/ID/токенов (D-127/D-128). */
export interface CardDownloaders {
  total: number;
  users: { name: string; mine?: boolean }[];
}

/** Ответ `GET /api/v1/files/{id}/card` (SP-19 S1 + S1b + S4 + D-134). */
export interface CardPayload {
  file_id: number;
  rag_summary: string | null;
  summary_status: string;
  summary_sources: SourcePayload[];
  storage: CardStorageItem[];
  form: CardFormEntry[];
  /** D-134: опционально — старый сервер без ключа просто не даёт спойлера. */
  downloaders?: CardDownloaders | null;
}

/** Статус «выключено» (D-093): база знаний/сводки отключены владельцем. */
export const SUMMARY_DISABLED = "disabled";

/** Сводка выключена? Тогда текст, источники и форма «что помогло» не рисуются. */
export function isSummaryDisabled(payload: Partial<CardPayload> | null): boolean {
  return (payload?.summary_status || "").trim() === SUMMARY_DISABLED;
}

/** Статус, при котором текста ещё/уже нет — показываем подпись, а не пустоту. */
export function summaryHintKey(status: string | null | undefined): Key | null {
  switch ((status || "").trim()) {
    case "ready":
      return null;
    case SUMMARY_DISABLED:
      // D-093: база знаний выключена — никаких «готовится» (это была бы ложь).
      return null;
    case "empty":
      return "summary.empty";
    case "failed":
      return "summary.failed";
    default:
      // Нет строки в кеше / устарела / идёт сборка — «готовится».
      return "summary.pending";
  }
}

/** Что показать вместо текста: готовая сводка или подпись по статусу. */
export function summaryView(payload: Partial<CardPayload> | null): {
  text: string;
  hintKey: Key | null;
  sources: string[];
} {
  const text = (payload?.rag_summary || "").trim();
  const sources = formatSources(payload?.summary_sources ?? []);
  if (text) return { text, hintKey: null, sources };
  return { text: "", hintKey: summaryHintKey(payload?.summary_status), sources: [] };
}

/** Подпись ступени соседства: «та же модель» / «то же шасси».
 *
 * D-095 (2026-10-17): ступень «тот же бренд» из `peers_for_card` убрана — один
 * бренд ничего не доказывает (это разные аппараты), поэтому третьей подписи нет.
 */
export function tierLabel(tier: number): string {
  if (tier === 1) return t("summary.tier_same_model");
  return t("summary.tier_same_chassis");
}

/** Строка файла в блоке скачивания: «LG 42LB730V · 05.00.55 · 1.0 МБ». */
export function storageLabel(item: CardStorageItem): string {
  const head = [item.brand, item.model].filter((p) => (p || "").trim()).join(" ");
  return [head, (item.version || "").trim(), formatBytes(item.size_bytes || 0)]
    .filter((p) => p.length > 0)
    .join(" · ");
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Подпись записи опыта: текст мастера + сколько мастеров подтвердили. */
export function formEntryLabel(entry: CardFormEntry): string {
  return `${entry.text} — 👍 ${entry.votes}`;
}

/**
 * Разметка блока «что помогло» (SP-19 S4, `D-087` п.6).
 *
 * Показываем записи ДРУГИХ мастеров (и свои — с пометкой) и поле ввода: мастер
 * пишет, что помогло. Отметка «Проверено» рисуется ТОЛЬКО когда сервер сказал
 * `verified` (≥2 👍 от РАЗНЫХ мастеров) — клиент пороги не считает.
 */
export function renderFormHtml(payload: Partial<CardPayload> | null): string {
  const entries = (payload?.form ?? []).filter((e) => e && e.dm_id > 0);
  const list = entries.length
    ? entries
        .map(
          (e) =>
            `<div class="summary-form-item${e.verified ? " verified" : ""}">` +
            `<span class="summary-form-text">${escapeHtml(e.text)}</span>` +
            `<span class="summary-form-votes">👍 ${e.votes}` +
            (e.verified ? ` · <strong>${escapeHtml(t("summary.form_verified"))}</strong>` : "") +
            (e.mine ? ` · ${escapeHtml(t("summary.form_mine"))}` : "") +
            `</span></div>`,
        )
        .join("")
    : `<div class="summary-form-empty" style="opacity:.6;">${escapeHtml(
        t("summary.form_empty"),
      )}</div>`;
  return (
    `<div class="summary-form"><strong>${escapeHtml(t("summary.form_title"))}</strong>` +
    list +
    `<div class="summary-form-compose" style="display:flex; gap:6px; margin-top:6px;">` +
    `<input class="summary-form-input" type="text" maxlength="600" placeholder="${escapeHtml(
      t("summary.form_placeholder"),
    )}" style="flex:1; padding:6px 8px;">` +
    `<button class="btn btn-primary summary-form-helped">${escapeHtml(
      t("summary.form_helped"),
    )}</button>` +
    `<button class="btn btn-secondary summary-form-not-helped">${escapeHtml(
      t("summary.form_not_helped"),
    )}</button>` +
    `</div>` +
    `<div class="summary-form-hint" style="opacity:.6; font-size:.9em; margin-top:4px;"></div>` +
    `</div>`
  );
}

/**
 * Спойлер «Кто скачал» (D-134) — вертикальный список мастеров.
 *
 * Данные даёт сервер из книги учёта (тип `download`, D-127/D-128: только
 * имена, «это я», без телефонов/ID/токенов). Спойлер НЕ зависит от ИИ:
 * виден и при выключенной базе знаний (в отличие от сводки/формы, D-093).
 * Пустой список не рисуется вовсе; скрытый за воротами (50 записей)
 * остаток подсказывает счётчик «… ещё N» — число считает сервер, клиент
 * только подписывает.
 */
export function renderDownloadersHtml(payload: Partial<CardPayload> | null | undefined): string {
  const dl = payload?.downloaders;
  if (!dl || !(dl.total > 0) || !dl.users?.length) return "";
  const items = dl.users
    .map(
      (u) =>
        `<li class="card-downloaders-item${u.mine ? " mine" : ""}">` +
        `${escapeHtml(u.name || "Master")}` +
        (u.mine ? ` <span class="card-downloaders-mine">${escapeHtml(t("summary.form_mine"))}</span>` : "") +
        `</li>`,
    )
    .join("");
  const hidden = dl.total - dl.users.length;
  const more =
    hidden > 0
      ? `<div class="card-downloaders-more">${escapeHtml(t("summary.downloaders_more", { n: hidden }))}</div>`
      : "";
  return (
    `<details class="card-downloaders">` +
    `<summary>${escapeHtml(t("summary.downloaders_title"))}</summary>` +
    `<ul class="card-downloaders-list">${items}</ul>` +
    more +
    `</details>`
  );
}

/**
 * Разметка блока (чистая функция — её и проверяет `summary-block.test.ts`):
 * текст сводки экранирован, источники — отдельными строками, файлы рядом —
 * кнопками с `data-file-id` (клик навешивает хостер блока).
 */
export function renderSummaryHtml(payload: Partial<CardPayload> | null): string {
  const items = (payload?.storage ?? []).filter((it) => it && it.id > 0);
  const storageHtml = items.length
    ? `<div class="summary-storage"><strong>${escapeHtml(
        t("summary.storage_title"),
      )}</strong>${items
        .map(
          (it) =>
            `<button class="btn btn-secondary summary-storage-item" ` +
            `data-file-id="${it.id}" title="${escapeHtml(
              tierLabel(it.tier),
            )}">${escapeHtml(storageLabel(it))}</button>`,
        )
        .join("")}</div>`
    : ``;

  // D-093: база знаний выключена — сводки, источников и формы «что помогло» нет.
  // Остаётся то, что не зависит от ИИ: соседние файлы (`storage[]`, строит SQL)
  // и «кто скачал» (D-134, книга учёта).
  const downloadersHtml = renderDownloadersHtml(payload);
  if (isSummaryDisabled(payload)) {
    return storageHtml + downloadersHtml;
  }

  const view = summaryView(payload);
  const body = view.text
    ? `<div class="summary-text">${escapeHtml(view.text)}</div>`
    : `<div class="summary-status" style="opacity:.65;">${escapeHtml(
        t(view.hintKey || "summary.pending"),
      )}</div>`;

  const sourcesHtml = view.sources.length
    ? `<div class="summary-sources"><strong>${escapeHtml(
        t("summary.sources_title"),
      )}</strong>${view.sources
        .map((label) => `<div class="summary-source">${escapeHtml(label)}</div>`)
        .join("")}</div>`
    : "";

  return (
    `<div class="summary-head"><strong>${escapeHtml(t("summary.title"))}</strong></div>` +
    body +
    sourcesHtml +
    storageHtml +
    downloadersHtml +
    renderFormHtml(payload)
  );
}

/** Загрузчик карточки (инжектируется: тесты не ходят в сеть). */
export interface SummaryBlockDeps {
  loadCard: (fileId: number) => Promise<CardPayload>;
  onDownload?: (fileId: number) => void;
  /** «Что помогло»: отправить опыт мастера (SP-19 S4). */
  submitForm?: (
    helped: boolean,
    text: string,
  ) => Promise<{ votes: number; verified: boolean }>;
}

/**
 * Блок под карточкой: один запрос на карточку, перерисовка — из памяти.
 *
 * Поколение операции (`epoch`) — правило проекта: размонтированный или
 * перерисованный блок не должен дописать ответ устаревшего запроса в живой DOM.
 */
export class SummaryBlock {
  private root: HTMLElement | null = null;
  private payload: CardPayload | null = null;
  private epoch = 0;

  constructor(
    private readonly fileId: number,
    private readonly deps: SummaryBlockDeps,
  ) {}

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.root = document.createElement("div");
    this.root.className = "summary-block";
    container.appendChild(this.root);
    this.render();
    void this.reload();
  }

  unmount(): void {
    this.epoch += 1;
    this.root?.remove();
    this.root = null;
    this.payload = null;
  }

  get mounted(): boolean {
    return this.root != null;
  }

  /** Смена языка: подписи из уже полученных данных, без нового запроса. */
  applyLang(): void {
    if (!this.root) return;
    this.render();
  }

  private render(): void {
    if (!this.root) return;
    this.root.innerHTML = renderSummaryHtml(this.payload);
    this.root
      .querySelectorAll<HTMLButtonElement>(".summary-storage-item")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = Number(btn.dataset.fileId || 0);
          if (id > 0) this.deps.onDownload?.(id);
        });
      });
    // SP-19 S4: «что помогло» — отправка опыта мастера.
    const helped = this.root.querySelector<HTMLButtonElement>(".summary-form-helped");
    helped?.addEventListener("click", () => void this._sendForm(true));
    const notHelped = this.root.querySelector<HTMLButtonElement>(
      ".summary-form-not-helped",
    );
    notHelped?.addEventListener("click", () => void this._sendForm(false));
  }

  /** Отправить опыт мастера и перерисовать блок свежими данными сервера. */
  private async _sendForm(helped: boolean): Promise<void> {
    if (!this.root) return;
    const input = this.root.querySelector<HTMLInputElement>(".summary-form-input");
    const hint = this.root.querySelector<HTMLElement>(".summary-form-hint");
    const text = (input?.value || "").trim();
    if (helped && text.length < 3) {
      // Пустая отметка бесполезна другим мастерам — и сервер её не примет.
      if (hint) hint.textContent = t("summary.form_short");
      return;
    }
    if (!this.deps.submitForm) return;
    const gen = this.epoch;
    if (hint) hint.textContent = t("summary.form_sending");
    try {
      await this.deps.submitForm(helped, text);
      if (gen !== this.epoch) return;
      if (input) input.value = "";
      await this.reload();
      const fresh = this.root?.querySelector<HTMLElement>(".summary-form-hint");
      if (fresh) fresh.textContent = t("summary.form_saved");
    } catch {
      if (gen !== this.epoch) return;
      if (hint) hint.textContent = t("summary.form_failed");
    }
  }

  private async reload(): Promise<void> {
    const gen = ++this.epoch;
    try {
      const payload = await this.deps.loadCard(this.fileId);
      if (gen !== this.epoch) return;
      this.payload = payload;
      this.render();
    } catch {
      // Fail-open: карточка живёт без сводки (SP-19 §4 п.2).
      if (gen !== this.epoch) return;
      this.payload = null;
      this.render();
    }
  }
}
