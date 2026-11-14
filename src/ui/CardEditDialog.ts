/**
 * Форма «Редагувати» — разовая самоправка ТЕКСТА карточки владельцем (D-186).
 *
 * Решение владельца: «поменять всё, но один раз». Поэтому форма:
 * - правит ТОЛЬКО текст карточки: бренд, модель, версию, описание и
 *   характеристики (`properties`). Класс контента (`content_kind`) и файл
 *   (имя, размер, хэш, `cloud_key`) не меняются — их нет в форме;
 * - набор полей берёт С СЕРВЕРА (`editable_scalars` / `editable_property_keys`):
 *   у прошивки, документации и софта разные поля, и клиент не угадывает;
 * - после успешной правки кнопка «Редагувати» больше не активна (`used_at`),
 *   а 409 `edit_already_used` показывается человеческим текстом, а не «API 409»;
 * - `no_changes` — не ошибка мастера: сервер не тратит попытку, форма просто
 *   сообщает «ничего не изменилось».
 *
 * Зависимости инжектируются — блок покрыт тестами без Electron/TDLib/сети
 * (`tests/card-owner-edit.test.ts`).
 */
import { t, tLoose } from "../i18n";

/**
 * Контракт ответов `GET/PATCH /desktop/cards/{kind}/{card_id}/edit`.
 *
 * Объявлен ЗДЕСЬ, а не импортируется из `../api`: те же имена есть в `api.ts`
 * (там методы клиента), но UI-модули в этом проекте держат собственные
 * response-интерфейсы (см. `AttachmentForm.ts`), чтобы тесты UI не тянули
 * весь `api.ts` c `import.meta.env` в конфиг тестов.
 */
export type CardEditKind = "file" | "personal";

export interface CardEditCardState {
  brand: string;
  model: string;
  version: string;
  description: string | null;
  properties: Record<string, string>;
}

export interface CardEditState {
  ok: boolean;
  card_kind: CardEditKind;
  card_id: number;
  content_kind: string;
  card: CardEditCardState;
  editable_scalars: string[];
  editable_property_keys: string[];
  required_property_keys: string[];
  can_edit: boolean;
  used_at: string | null;
  revision: number;
}

export interface CardEditApplied {
  ok: boolean;
  card_kind: CardEditKind;
  card_id: number;
  content_kind: string;
  card: CardEditCardState;
  changed: string[];
  synced: string | null;
  revision: number;
  used_at: string;
}

/** Порядок скалярных полей в форме (как в форме загрузки). */
export const SCALAR_ORDER = ["brand", "model", "version", "description"] as const;

/** Порядок характеристик в форме. */
export const PROPERTY_ORDER = [
  "device_category",
  "doc_type",
  "title",
  "chassis",
  "chipset",
  "panel_model",
  "memory_type",
  "firmware_type",
  "source_status",
  "programmer",
  "hardware_type",
] as const;

/** Тип железа — закрытый enum сервера (D-165), поэтому селект, а не текст. */
export const HARDWARE_TYPES = ["original", "china_clone"] as const;

export interface CardEditField {
  /** Ключ в теле PATCH: скаляры — как есть, характеристики — внутрь properties. */
  key: string;
  /** `scalar` | `property` — куда положить значение при сборке патча. */
  source: "scalar" | "property";
  labelKey: string;
  value: string;
  /** Многострочное поле (описание). */
  multiline: boolean;
  /** Обязательное поле: пустым отправлять нельзя (сервер всё равно проверит). */
  required: boolean;
  /** Варианты для селекта (закрытый enum), иначе — текстовый ввод. */
  options?: readonly string[];
}

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Поля формы по ответу сервера (порядок фиксирован, состав — от `content_kind`).
 *
 * `required` здесь — только подсказка для UI: настоящую обязательность
 * проверяет сервер (`required_property_keys` + kind-гейты), потому что у него
 * же лежит сам класс контента.
 */
export function buildCardEditFields(state: CardEditState): CardEditField[] {
  const scalars = new Set(state.editable_scalars ?? []);
  const properties = new Set(state.editable_property_keys ?? []);
  const required = new Set(state.required_property_keys ?? []);
  const fields: CardEditField[] = [];

  for (const key of SCALAR_ORDER) {
    if (!scalars.has(key)) continue;
    const raw = (state.card as unknown as Record<string, unknown>)[key];
    fields.push({
      key,
      source: "scalar",
      labelKey: `card_edit.field.${key}`,
      value: typeof raw === "string" ? raw : "",
      multiline: key === "description",
      required: key === "brand" || key === "model",
    });
  }

  for (const key of PROPERTY_ORDER) {
    if (!properties.has(key)) continue;
    fields.push({
      key,
      source: "property",
      labelKey: `card_edit.field.${key}`,
      value: String((state.card.properties ?? {})[key] ?? ""),
      multiline: false,
      required: required.has(key),
      options: key === "hardware_type" ? HARDWARE_TYPES : undefined,
    });
  }
  return fields;
}

/**
 * Собрать тело PATCH: только ИЗМЕНЁННЫЕ поля.
 *
 * Не тронутое поле не отправляем вовсе — иначе сервер примет его как правку и
 * посчитает конфликт (`no_changes` не сработает, а слот потратится зря).
 * Пустая строка в характеристике — осознанное «убрать значение» (сервер удалит
 * ключ), поэтому она уходит как есть.
 */
export function buildCardEditPatch(
  fields: CardEditField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const props: Record<string, string> = {};
  for (const field of fields) {
    if (!(field.key in values)) continue;
    const next = values[field.key] ?? "";
    if (next === field.value) continue;
    if (field.source === "scalar") patch[field.key] = next;
    else props[field.key] = next;
  }
  if (Object.keys(props).length > 0) patch.properties = props;
  return patch;
}

/** Есть ли что отправлять (пустая форма = кнопка «Зберегти» не нужна). */
export function hasCardEditChanges(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}

export interface CardEditErrorInfo {
  status: number | null;
  code: string;
  message: string;
}

/**
 * Разобрать ошибку PATCH в машинный код + текст.
 *
 * `ApiClient.request` бросает `Error` с `status` и сообщением
 * `API 409: {"ok":false,"code":"edit_already_used","error":"…"}` — мастеру
 * нельзя показывать это как есть, поэтому JSON извлекается, а при отсутствии
 * кода он выводится из HTTP-статуса (422/500 без тела тоже бывают).
 */
export function parseCardEditError(err: unknown): CardEditErrorInfo {
  const box = err as { status?: number; message?: string } | null;
  const status = typeof box?.status === "number" ? box.status : null;
  const raw = String(box?.message ?? err ?? "");
  let code = "";
  let message = raw;

  const brace = raw.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(raw.slice(brace)) as {
        code?: unknown;
        error?: unknown;
      };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Тело не JSON — оставляем исходный текст (logs покажут причину).
    }
  }

  if (!code) {
    code =
      status === 409
        ? "edit_already_used"
        : status === 403
          ? "not_owner"
          : status === 404
            ? "card_not_found"
            : "validation_failed";
  }
  return { status, code, message };
}

/** Код ошибки сервера → ключ i18n (человеческий текст для мастера). */
export function cardEditErrorKey(code: string): string {
  switch (code) {
    case "edit_already_used":
      return "card_edit.err_used";
    case "no_changes":
      return "card_edit.err_no_changes";
    case "field_not_editable":
      return "card_edit.err_frozen";
    case "card_fields_conflict":
      return "card_edit.err_conflict";
    case "card_unavailable":
      return "card_edit.err_unavailable";
    case "not_owner":
      return "card_edit.err_not_owner";
    case "revision_conflict":
      return "card_edit.err_revision";
    case "card_not_found":
      return "card_edit.err_not_found";
    default:
      return "card_edit.err_validation";
  }
}

/**
 * Подпись кнопки «Редагувати» с учётом остатка попытки.
 *
 * Использованная попытка — не «ошибка», а состояние карточки: кнопка остаётся
 * на месте (мастер должен понимать, почему правки нет), но неактивна.
 */
export function cardEditButtonLabel(used: boolean): string {
  return used ? t("card_edit.btn_used") : t("card_edit.btn");
}

/** Что нужно форме от внешнего мира (инжектируется — тесты без сети). */
export interface CardEditDialogDeps {
  load(kind: CardEditKind, cardId: number): Promise<CardEditState>;
  save(
    kind: CardEditKind,
    cardId: number,
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<CardEditApplied>;
  onSaved?(applied: CardEditApplied): void;
  /**
   * Справка цієї картки витрачена (успішна правка АБО сервер сказав
   * `can_edit=false`). Сторінка гасить кнопку на місці — «одноразова» кнопка
   * не повинна виглядати робочою після того, як спроба вже пішла (D-187).
   */
  onUsed?(kind: CardEditKind, cardId: number): void;
  onToast?(message: string, type?: "success" | "error" | "info"): void;
}

/**
 * Модальная форма правки текста карточки.
 *
 * Инварианты:
 * - клик по уже использованной карточке НЕ открывает форму: показываем
 *   объяснение (`card_edit.used_notice`) вместо пустых полей;
 * - успешная правка закрывает форму и отдаёт результат в `onSaved` — страница
 *   перерисовывает карточку (текст изменился, а слот потрачен);
 * - `409 edit_already_used` (гонка с другим устройством) закрывает форму:
 *   повторять бессмысленно, второй попытки не будет;
 * - `no_changes` не считается ошибкой — попытка цела, мастер может править дальше.
 */
export class CardEditDialog {
  private _overlay: HTMLElement | null = null;
  private _busy = false;
  /** Обработчик Esc — снимаем вместе с формой, иначе он течёт между открытиями. */
  private _onKeyDown: ((event: KeyboardEvent) => void) | null = null;

  constructor(private readonly deps: CardEditDialogDeps) {}

  async open(kind: CardEditKind, cardId: number): Promise<void> {
    let state: CardEditState;
    try {
      state = await this.deps.load(kind, cardId);
    } catch (err) {
      this._toast(this._errorText(err), "error");
      return;
    }
    if (!state.can_edit) {
      // Слот уже израсходован — кнопка должна погаснуть, а не звать снова.
      this.deps.onUsed?.(kind, cardId);
      this._toast(t("card_edit.used_notice"), "info");
      return;
    }
    this._render(kind, cardId, state);
  }

  close(): void {
    if (this._onKeyDown) {
      document.removeEventListener("keydown", this._onKeyDown);
      this._onKeyDown = null;
    }
    this._overlay?.remove();
    this._overlay = null;
    this._busy = false;
    document.body.style.overflow = "";
  }

  private _render(kind: CardEditKind, cardId: number, state: CardEditState): void {
    this.close();
    const fields = buildCardEditFields(state);
    const overlay = document.createElement("div");
    overlay.className = "card-edit-overlay";
    overlay.dataset.cardKind = kind;
    overlay.dataset.cardId = String(cardId);

    const inputs = fields
      .map((field) => {
        const attrs = `data-key="${esc(field.key)}" data-source="${field.source}"`;
        const control = `class="card-edit-input" ${attrs}`;
        const label = `${esc(tLoose(field.labelKey))}${field.required ? " *" : ""}`;
        if (field.options && field.options.length > 0) {
          const opts = field.options
            .map(
              (value) =>
                `<option value="${esc(value)}"${
                  value === field.value ? " selected" : ""
                }>${esc(tLoose(`card_edit.option.${value}`))}</option>`,
            )
            .join("");
          return `<label class="card-edit-field"><span class="card-edit-label">${label}</span><select ${control}>${opts}</select></label>`;
        }
        if (field.multiline) {
          return `<label class="card-edit-field"><span class="card-edit-label">${label}</span><textarea rows="3" ${control}>${esc(field.value)}</textarea></label>`;
        }
        return `<label class="card-edit-field"><span class="card-edit-label">${label}</span><input type="text" value="${esc(field.value)}" ${control} /></label>`;
      })
      .join("");

    overlay.innerHTML = `
      <div class="card-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="cardEditTitle">
        <div class="card-edit-head">
          <div class="card-edit-title" id="cardEditTitle">${esc(t("card_edit.title", { id: cardId }))}</div>
          <button type="button" class="card-edit-close" data-act="close"
            aria-label="${esc(t("common.close"))}" title="${esc(t("common.close"))}">✕</button>
        </div>
        <div class="card-edit-hint">${esc(t("card_edit.hint_once"))}</div>
        <div class="card-edit-fields">${inputs}</div>
        <div class="card-edit-actions">
          <button class="btn btn-primary" data-act="save">
            ${esc(t("card_edit.save"))}
          </button>
          <button class="btn btn-secondary" data-act="cancel">
            ${esc(t("card_edit.cancel"))}
          </button>
        </div>
      </div>`;

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.close();
    });
    for (const act of ["close", "cancel"]) {
      overlay
        .querySelector(`[data-act="${act}"]`)
        ?.addEventListener("click", () => this.close());
    }
    overlay
      .querySelector('[data-act="save"]')
      ?.addEventListener("click", () =>
        void this._save(overlay, kind, cardId, state, fields),
      );

    // Esc — привычный выход из модалки. Слушатель живёт только пока форма
    // на экране (снимается в `close()`), иначе он течёт между открытиями.
    this._onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    };
    document.addEventListener("keydown", this._onKeyDown);

    document.body.appendChild(overlay);
    // Страница под модалкой не должна скроллиться (иначе «уезжает» фон).
    document.body.style.overflow = "hidden";
    this._overlay = overlay;
    // Курсор сразу в первом поле: мастер правит, а не ищет, куда нажать.
    overlay.querySelector<HTMLInputElement>("input.card-edit-input")?.focus();
  }

  private async _save(
    overlay: HTMLElement,
    kind: CardEditKind,
    cardId: number,
    state: CardEditState,
    fields: CardEditField[],
  ): Promise<void> {
    if (this._busy) return;

    const values: Record<string, string> = {};
    overlay
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "[data-key]",
      )
      .forEach((el) => {
        const key = el.dataset.key;
        if (key) values[key] = el.value;
      });

    const patch = buildCardEditPatch(fields, values);
    if (!hasCardEditChanges(patch)) {
      this._toast(t("card_edit.err_no_changes"), "info");
      return;
    }

    this._busy = true;
    const saveBtn = overlay.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const applied = await this.deps.save(kind, cardId, patch, state.revision);
      // Слот потрачен: страница гасит кнопку на месте (D-187) — «одноразова»
      // кнопка не должна выглядеть робочою після успіху.
      this.deps.onUsed?.(kind, cardId);
      this.close();
      this._toast(t("card_edit.saved"), "success");
      this.deps.onSaved?.(applied);
    } catch (err) {
      const info = parseCardEditError(err);
      const text = tLoose(cardEditErrorKey(info.code));
      // Текст сервера добавляем только там, где он объясняет причину
      // (`no_changes`/`validation_failed` уже сказали всё человеческим языком).
      const detail =
        info.code === "no_changes" || info.code === "validation_failed"
          ? ""
          : info.message
            ? ` — ${info.message}`
            : "";
      this._toast(`${text}${detail}`, "error");
      // Попытка потрачена в другом окне/на другом устройстве — форма бесполезна.
      if (info.code === "edit_already_used" || info.code === "card_unavailable") {
        this.close();
      }
    } finally {
      this._busy = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  private _errorText(err: unknown): string {
    return tLoose(cardEditErrorKey(parseCardEditError(err).code));
  }

  private _toast(message: string, type: "success" | "error" | "info"): void {
    this.deps.onToast?.(message, type);
  }
}
