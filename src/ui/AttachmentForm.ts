/**
 * Форма вложений под карточкой (SP-20, `D-094`).
 *
 * Приказ владельца (2026-10-17): под каждым файлом — форма «если вам есть что
 * добавить к данному файлу, выберите из списка и нажмите "Добавить файл"».
 * Любой авторизованный мастер прикладывает к ПУБЛИЧНОЙ карточке фото ISP/eMMC,
 * сервис-мануал, Repair Pictures или бюллетень; личной карточки — только владелец
 * (права решает СЕРВЕР, `D-094`: 403 на чужую личную).
 *
 * Инварианты:
 * - вложение — не файл каталога: баллы не списываются и не начисляются, поэтому
 *   форма никогда не показывает цену/лимиты скачивания;
 * - байты живут в Telegram (тема карточки / исходное сообщение) — здесь только
 *   строка списка и кнопка скачивания;
 * - перерисовка (`applyLang`, обновление списка) НЕ сбрасывает выбранный тип и
 *   введённое описание: состояние живёт в полях экземпляра, а не в DOM
 *   (правило i18n-дока: страница обязана применять язык без пересоздания форм);
 * - Fail-open: список не загрузился → форма всё равно работает (пустой список).
 *
 * Зависимости инжектируются — блок покрыт тестами без Electron/TDLib/сети
 * (`tests/attachment-form.test.ts`).
 */
import { formatBytes } from "./format";
import { t, type Key } from "../i18n";
import {
  ATTACHMENT_KINDS,
  MAX_ATTACHMENTS_FALLBACK,
  MAX_ATTACHMENT_NOTE_CHARS,
  type AttachmentCardKind,
  type AttachmentKind,
} from "./AttachmentUploader";

/** Одно вложение карточки — ответ `GET .../attachments` (`_row_to_dict` сервера). */
export interface CardAttachmentItem {
  id: number;
  att_kind: string;
  note: string;
  mime: string;
  size_bytes: number;
  original_name: string;
  author_tg_id: number;
  created_at: string | null;
  has_anchor: boolean;
  /** Абсолютный URL полного изображения (для просмотра/скачивания). */
  full_url?: string;
  /** Абсолютный URL превью (для image/* — тот же поток, иначе пусто). */
  thumb_url?: string;
}

const KIND_LABEL_KEYS: Record<AttachmentKind, Key> = {
  isp_emmc: "attachment.kind_isp_emmc",
  repair_pictures: "attachment.kind_repair_pictures",
  service_manual: "attachment.kind_service_manual",
  bulletin: "attachment.kind_bulletin",
  other: "attachment.kind_other",
};

/** Подпись типа вложения; неизвестный тип показываем как есть (не прячем). */
export function attachmentKindLabel(kind: string): string {
  const key = KIND_LABEL_KEYS[kind as AttachmentKind];
  return key ? t(key) : kind;
}

/** Строка вложения: «ISP eMMC · isp.jpg · 1.2 МБ». */
export function attachmentLabel(item: CardAttachmentItem): string {
  const name = (item.original_name || "").trim() || `#${item.id}`;
  return [attachmentKindLabel(item.att_kind), name, formatBytes(item.size_bytes || 0)]
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

/**
 * Сколько ждём ответа от диалога выбора файла.
 *
 * Мастер может долго искать мануал на диске, поэтому минута-две — норма.
 * А вот «вечно» нельзя: если диалог не открылся (сбой ОС, пустой ответ,
 * умерший обработчик), форма обязана честно сказать об этом, а не молчать
 * (BUG-ATTACH-SILENT-001: 7 минут тишины на x32, движок не получил ни одного RPC).
 */
export const ATTACHMENT_PICK_TIMEOUT_MS = 120_000;

/** Чем закончился выбор файла — каждый исход обязан дойти до мастера. */
export type PickOutcome =
  | { status: "picked"; path: string; name?: string }
  | { status: "cancelled" }
  | { status: "no_path" }
  | { status: "timeout" }
  | { status: "error"; reason: string };

/** Нормализуем ответ `pickFile`: `null` → отмена, пустой путь → отдельный исход. */
async function readPick(
  pick: () => Promise<{ path: string; name?: string } | null>,
): Promise<PickOutcome> {
  try {
    const picked = await pick();
    if (!picked) return { status: "cancelled" };
    const filePath = (picked.path || "").trim();
    if (!filePath) return { status: "no_path" };
    return { status: "picked", path: filePath, name: picked.name };
  } catch (err) {
    return { status: "error", reason: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Ждём выбор файла, но не бесконечно.
 *
 * Таймер снимаем ВСЕГДА: иначе на «висящем» setTimeout висит тестовый раннер,
 * а мастер получает ложный таймаут уже после того, как файл выбран.
 * Отменённый таймаут ничего не отменяет в диалоге ОС — исход просто игнорируется.
 */
export async function resolvePickedFile(
  pick: () => Promise<{ path: string; name?: string } | null>,
  timeoutMs: number = ATTACHMENT_PICK_TIMEOUT_MS,
): Promise<PickOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PickOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([readPick(pick), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Подсказка под формой для неуспешного выбора (`""` = показывать нечего). */
export function pickOutcomeHint(outcome: PickOutcome): string {
  switch (outcome.status) {
    case "cancelled":
      return t("attachment.pick_cancelled");
    case "no_path":
      return t("attachment.pick_no_path");
    case "timeout":
      return t("attachment.pick_timeout");
    case "error":
      return t("attachment.pick_failed", { reason: outcome.reason });
    default:
      return "";
  }
}



/** Состояние формы (живёт в экземпляре, чтобы перерисовка не сбрасывала ввод). */
export interface AttachmentFormState {
  attKind: AttachmentKind;
  note: string;
  busy: boolean;
  /** Открыт диалог выбора файла: второй клик не открывает второй диалог. */
  picking: boolean;
  /** Серверный предел вложений (до первого ответа — `MAX_ATTACHMENTS_FALLBACK`). */
  maxAttachments: number;
  /** Текст-статус последней операции (пусто = ничего не показываем). */
  hint: string;
}

export function defaultAttachmentState(): AttachmentFormState {
  return {
    attKind: "isp_emmc",
    note: "",
    busy: false,
    picking: false,
    maxAttachments: MAX_ATTACHMENTS_FALLBACK,
    hint: "",
  };
}

/** Предел достигнут? Кнопка «Добавить файл» гаснет (сервер всё равно проверит). */
export function attachmentLimitReached(
  count: number,
  state: Pick<AttachmentFormState, "maxAttachments">,
): boolean {
  return count >= Math.max(1, state.maxAttachments);
}

/**
 * Разметка формы (чистая функция — её и проверяет `attachment-form.test.ts`).
 *
 * `canDelete` — предикат хоста (автор / владелец / OWNER); сам блок права не
 * вычисляет: список владельцев знает вызывающая страница.
 */
export function renderAttachmentFormHtml(
  items: readonly CardAttachmentItem[],
  state: AttachmentFormState,
  canDelete?: (item: CardAttachmentItem) => boolean,
): string {
  const list = items.filter((it) => it && it.id > 0);
  const rows = list.length
    ? list
        .map((it) => {
          const note = (it.note || "").trim();
          const removable = !!canDelete?.(it);
          const isImage = /^image\//i.test(it.mime || "");
          const src = it.thumb_url || it.full_url;
          const kindLabel = escapeHtml(attachmentKindLabel(it.att_kind));
          // Превью в реальном времени — только для изображений с адресом;
          // при ошибке загрузки прячем битую иконку, а не пустой квадрат.
          // alt — название вида вложения, а не имя файла.
          const preview = isImage && src
            ? `<img class="attachment-preview" src="${escapeHtml(src)}" alt="${kindLabel}" data-att-id="${it.id}" onerror="this.style.display='none'" loading="eager" />`
            : "";
          return (
            `<div class="attachment-item" data-att-id="${it.id}">` +
            `<div class="attachment-row">` +
            preview +
            // Название вида вложения — тактическая кнопка «Просмотр»
            // (ISP connection eMMC, Repair Pictures, Service Manual…),
            // вместо имени файла.
            `<button class="attachment-kind-btn" data-att-id="${it.id}" title="${t(
              "attachment.view",
            )}">${kindLabel}</button>` +
            `<button class="btn btn-secondary attachment-open" data-att-id="${
              it.id
            }">${escapeHtml(t("attachment.open"))}</button>` +
            (removable
              ? `<button class="btn btn-secondary attachment-remove" data-att-id="${
                  it.id
                }" title="${escapeHtml(t("attachment.remove"))}">✕</button>`
              : "") +
            `</div>` +
            (note ? `<div class="attachment-note">${escapeHtml(note)}</div>` : "") +
            `</div>`
          );
        })
        .join("")
    : `<div class="attachment-empty" style="opacity:.6;">${escapeHtml(
        t("attachment.empty"),
      )}</div>`;

  const options = ATTACHMENT_KINDS.map(
    (kind) =>
      `<option value="${kind}"${
        kind === state.attKind ? " selected" : ""
      }>${escapeHtml(attachmentKindLabel(kind))}</option>`,
  ).join("");

  const reached = attachmentLimitReached(list.length, state);
  const addDisabled = state.busy || state.picking || reached;

  return (
    `<div class="attachment-form">` +
    `<div class="attachment-list">${rows}</div>` +
    `<div class="attachment-head"><strong>${escapeHtml(t("attachment.title"))}</strong></div>` +
    `<div class="attachment-compose" style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">` +
    `<select class="attachment-kind-select" title="${escapeHtml(
      t("attachment.kind_label"),
    )}">${options}</select>` +
    `<input class="attachment-note-input" type="text" maxlength="${MAX_ATTACHMENT_NOTE_CHARS}"` +
    ` placeholder="${escapeHtml(t("attachment.note_placeholder"))}"` +
    ` value="${escapeHtml(state.note)}" style="flex:1; min-width:180px; padding:6px 8px;">` +
    `<button class="btn btn-primary attachment-add-btn"${
      addDisabled ? " disabled" : ""
    }${
      reached ? ` title="${escapeHtml(t("attachment.limit", { max: state.maxAttachments }))}"` : ""
    }>${escapeHtml(t("attachment.add_btn"))}</button>` +
    `</div>` +
    `<div class="attachment-hint" style="opacity:.65; font-size:.9em; margin-top:4px;">${escapeHtml(
      state.hint,
    )}</div>` +
    `</div>`
  );
}

/** Зависимости формы (инжектируются: тесты не ходят ни в сеть, ни в TDLib). */
export interface AttachmentFormDeps {
  /** Список вложений карточки. */
  list: (kind: AttachmentCardKind, cardId: number) => Promise<CardAttachmentItem[]>;
  /** Выбор файла мастером (диалог ОС) → локальный путь; `null` = отменил. */
  pickFile: () => Promise<{ path: string; name?: string } | null>;
  /** Предел ожидания диалога выбора (по умолчанию `ATTACHMENT_PICK_TIMEOUT_MS`). */
  pickTimeoutMs?: number;
  /** Диагностика выбора файла: исход каждого клика уходит в файловый лог хоста. */
  onPickOutcome?: (outcome: PickOutcome) => void;
  /** Полный цикл «init → отправка своим TDLib → complete» (`AttachmentUploader`). */
  upload: (
    kind: AttachmentCardKind,
    cardId: number,
    attKind: AttachmentKind,
    note: string,
    filePath: string,
  ) => Promise<void>;
  /** Снять вложение (сервер удалит сообщение из темы). */
  remove?: (kind: AttachmentCardKind, cardId: number, attId: number) => Promise<void>;
  /** Открыть/скачать байты вложения (не-изображения). */
  open?: (item: CardAttachmentItem) => void;
  /** Показать полноразмерное изображение вложения (только image/*). */
  view?: (item: CardAttachmentItem) => void;
  canDelete?: (item: CardAttachmentItem) => boolean;
}

/**
 * Форма под карточкой: список вложений + выбор типа + описание + «Добавить файл».
 *
 * Поколение операции (`epoch`) — правило проекта: размонтированный или
 * перерисованный блок не должен дописать ответ устаревшего запроса в живой DOM.
 */
export class AttachmentForm {
  private root: HTMLElement | null = null;
  private items: CardAttachmentItem[] = [];
  private state: AttachmentFormState = defaultAttachmentState();
  private epoch = 0;

  constructor(
    private readonly cardKind: AttachmentCardKind,
    private readonly cardId: number,
    private readonly deps: AttachmentFormDeps,
  ) {}

  mount(container: HTMLElement): void {
    if (this.root) return;
    this.root = document.createElement("div");
    this.root.className = "attachment-block";
    container.appendChild(this.root);
    this.render();
    void this.reload();
  }

  unmount(): void {
    this.epoch += 1;
    this.root?.remove();
    this.root = null;
    this.items = [];
  }

  get mounted(): boolean {
    return this.root != null;
  }

  /** Текущее состояние (для тестов и хоста). */
  get formState(): Readonly<AttachmentFormState> {
    return this.state;
  }

  /** Смена языка: подписи из уже полученных данных, без нового запроса. */
  applyLang(): void {
    if (!this.root) return;
    this.render();
  }

  /** Перечитать список (после загрузки/снятия). */
  async reload(): Promise<void> {
    const gen = ++this.epoch;
    try {
      const items = await this.deps.list(this.cardKind, this.cardId);
      if (gen !== this.epoch) return;
      this.items = Array.isArray(items) ? items : [];
    } catch {
      // Fail-open: карточка живёт без вложений.
      if (gen !== this.epoch) return;
      this.items = [];
    }
    this.render();
  }

  private render(): void {
    if (!this.root) return;
    this.root.innerHTML = renderAttachmentFormHtml(
      this.items,
      this.state,
      this.deps.canDelete,
    );
    const select = this.root.querySelector<HTMLSelectElement>(".attachment-kind-select");
    select?.addEventListener("change", () => {
      const value = (select.value || "").trim();
      if ((ATTACHMENT_KINDS as readonly string[]).includes(value)) {
        this.state.attKind = value as AttachmentKind;
      }
    });
    const note = this.root.querySelector<HTMLInputElement>(".attachment-note-input");
    note?.addEventListener("input", () => {
      this.state.note = note.value;
    });
    const add = this.root.querySelector<HTMLButtonElement>(".attachment-add-btn");
    add?.addEventListener("click", () => void this._pickAndUpload());
    this.root
      .querySelectorAll<HTMLButtonElement>(".attachment-open")
      .forEach((btn) =>
        btn.addEventListener("click", () => {
          const item = this._item(btn.dataset.attId);
          if (item) this.deps.open?.(item);
        }),
      );
    // Кнопка вида вложения — открыть превью (Просмотр).
    this.root
      .querySelectorAll<HTMLButtonElement>(".attachment-kind-btn")
      .forEach((btn) =>
        btn.addEventListener("click", () => {
          const item = this._item(btn.dataset.attId);
          if (item) this.deps.view?.(item);
        }),
      );
    // Превью / кнопка просмотра (изображения): показать полноразмерное.
    const onPreview = (el: Element): void => {
      const item = this._item((el as HTMLElement).dataset.attId);
      if (item) this.deps.view?.(item);
    };
    this.root
      .querySelectorAll<HTMLImageElement>(".attachment-preview")
      .forEach((img) => img.addEventListener("click", () => onPreview(img)));
    this.root
      .querySelectorAll<HTMLButtonElement>(".attachment-remove")
      .forEach((btn) =>
        btn.addEventListener("click", () => void this._remove(btn.dataset.attId)),
      );
  }

  private _item(rawId: string | undefined): CardAttachmentItem | null {
    const id = Number(rawId || 0);
    return this.items.find((it) => it.id === id) ?? null;
  }


  private async _pickAndUpload(): Promise<void> {
    if (this.state.busy || this.state.picking) return;
    if (attachmentLimitReached(this.items.length, this.state)) {
      this._setHint(t("attachment.limit", { max: this.state.maxAttachments }));
      return;
    }
    this.state.picking = true;
    this._setHint(t("attachment.pick_opening"));
    let outcome: PickOutcome = { status: "error", reason: "pick failed" };
    try {
      outcome = await resolvePickedFile(
        this.deps.pickFile,
        this.deps.pickTimeoutMs ?? ATTACHMENT_PICK_TIMEOUT_MS,
      );
    } finally {
      this.state.picking = false;
    }
    // Диагностика: клик, отмена, пустой путь и таймаут оставляют строку в логе.
    this.deps.onPickOutcome?.(outcome);
    if (outcome.status !== "picked") {
      // Тишины быть не может: мастер должен видеть, что клик сработал и чем кончился.
      this._setHint(pickOutcomeHint(outcome));
      return;
    }
    const picked = { path: outcome.path, name: outcome.name };

    const gen = this.epoch;
    this.state.busy = true;
    this._setHint(t("attachment.uploading"));
    try {
      await this.deps.upload(
        this.cardKind,
        this.cardId,
        this.state.attKind,
        this.state.note.trim(),
        picked.path,
      );
      if (gen !== this.epoch) return;
      this.state.busy = false;
      this.state.note = "";
      await this.reload();
      if (gen === this.epoch) this._setHint(t("attachment.uploaded"));
    } catch (err) {
      if (gen !== this.epoch) return;
      this.state.busy = false;
      const reason = (err as Error)?.message ?? String(err);
      this._setHint(t("attachment.upload_failed", { reason }));
    }
  }

  private async _remove(rawId: string | undefined): Promise<void> {
    const item = this._item(rawId);
    if (!item || !this.deps.remove || this.state.busy) return;
    const gen = this.epoch;
    this.state.busy = true;
    this._setHint(t("attachment.uploading"));
    try {
      await this.deps.remove(this.cardKind, this.cardId, item.id);
      if (gen !== this.epoch) return;
      this.state.busy = false;
      await this.reload();
      if (gen === this.epoch) this._setHint(t("attachment.removed"));
    } catch (err) {
      if (gen !== this.epoch) return;
      this.state.busy = false;
      const reason = (err as Error)?.message ?? String(err);
      this._setHint(t("attachment.remove_failed", { reason }));
    }
  }

  /** Подсказку обновляем точечно, чтобы не терять ввод в поле описания. */
  private _setHint(text: string): void {
    this.state.hint = text;
    const el = this.root?.querySelector<HTMLElement>(".attachment-hint");
    if (el) el.textContent = text;
    const add = this.root?.querySelector<HTMLButtonElement>(".attachment-add-btn");
    if (add) {
      add.disabled =
        this.state.busy ||
        this.state.picking ||
        attachmentLimitReached(this.items.length, this.state);
    }
  }
}

