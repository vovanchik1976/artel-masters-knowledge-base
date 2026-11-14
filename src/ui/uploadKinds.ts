/**
 * Права классов контента по режиму работы (SP-35 / D-185).
 *
 * Схема загрузки приходит с сервера и каждая опция дискриминатора
 * «Що ви завантажуєте?» несёт `scopes` — список режимов, где класс разрешён:
 *   ["public","personal"] — профильный контент ARTEL (прошивка, документация,
 *                           софт, даташит микросхемы);
 *   ["personal"]          — только личное хранилище (`any_file`: фото, видео,
 *                           документы — что угодно, это НЕ профильный контент).
 *
 * Сервер остаётся источником правды (POST /desktop/uploads/init отвечает
 * 400 `KIND_NOT_ALLOWED_IN_SCOPE`). Клиент лишь не показывает то, что сервер
 * всё равно отвергнет — чтобы мастер не заполнял форму и не паковывал архив зря.
 *
 * Отсутствие/пустой `scopes` = опция доступна в обоих режимах (легасі-схема,
 * старый кеш схемы без поля scopes).
 */

/** Опция дискриминатора в объёме, нужном для фильтра. */
export interface KindOptionLike {
  value: string;
  scopes?: string[];
}

/** Режим работы Desktop: публичное поле или личное хранилище. */
export type UploadScope = "public" | "personal";

export const DEFAULT_KIND = "firmware";

/**
 * Классы, у которых название карточки = `properties.title` (SPEC §7, D-185;
 * SP-36/D-188 добавил isp_emmc и repair_pictures). У них Бренд/Модель/Шасси
 * и «Додатково» — необязательные метаданные.
 */
const TITLE_NAME_KINDS: ReadonlySet<string> = new Set([
  "software", "datasheet", "any_file", "isp_emmc", "repair_pictures",
]);

/**
 * Классы, где «Назва файлу» ОБЯЗАТЕЛЬНА при загрузке (SP-35/D-185).
 * SP-37/D-189: у isp_emmc/repair_pictures поля в формі больше НЕТ —
 * назва карточки строится автоматически: шасі → модель → ім'я файлу
 * (effective_title на сервере, схема v9).
 */
const TITLE_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  "software", "datasheet",
]);

/**
 * SP-37/D-189: папку (несколько файлов) можно загрузить ТОЛЬКО как Прошивку.
 * Архивирование при upload разрешено владельцем только для firmware, а
 * raw-мультифайлового режима в протоколе нет — поэтому для остальных kind
 * папка блокируется валидацией ДО старта (сообщение владельцу).
 */
export function kindSupportsFolder(kind: string | null | undefined): boolean {
  const k = String(kind || "").trim().toLowerCase();
  return k === "firmware";
}

/** Нужны ли этому kind обязательные Бренд+Модель (true — firmware/documentation). */
export function kindNeedsBrandModel(kind: string | null | undefined): boolean {
  return !TITLE_NAME_KINDS.has(String(kind || "firmware"));
}

/** Обязателен ли «Назва файлу» для этого kind при загрузке. */
export function kindRequiresTitle(kind: string | null | undefined): boolean {
  return TITLE_REQUIRED_KINDS.has(String(kind || "firmware"));
}

/** Разрешена ли опция в данном режиме (`personal` = личное хранилище). */
export function kindAllowedInScope(option: KindOptionLike, personal: boolean): boolean {
  const scopes = Array.isArray(option?.scopes) ? option!.scopes!.filter(Boolean) : [];
  if (scopes.length === 0) return true; // легасі-схема без scopes
  return scopes.includes(personal ? "personal" : "public");
}

/** Опции дискриминатора, доступные в текущем режиме (порядок схемы сохраняется). */
export function visibleKindOptions<T extends KindOptionLike>(
  options: readonly T[],
  personal: boolean,
): T[] {
  return (options || []).filter((opt) => kindAllowedInScope(opt, personal));
}

/**
 * Какой kind оставить активным после смены режима.
 *
 * Если текущий kind в этом режиме запрещён (например `any_file` при переходе в
 * публичное поле) — откатываемся на `firmware`, а не показываем форму, которую
 * сервер отвергнет. Неизвестный/пустой kind тоже даёт `firmware`.
 */
export function pickKindForScope(
  current: string | null | undefined,
  options: readonly KindOptionLike[],
  personal: boolean,
  fallback: string = DEFAULT_KIND,
): string {
  const list = options || [];
  const wanted = (current || "").trim();
  const opt = list.find((o) => o.value === wanted);
  if (opt) return opt && kindAllowedInScope(opt, personal) ? wanted : fallback;
  // Нет в схеме (легасі-кеш): разрешаем только если это дефолт.
  return fallback;
}
