/**
 * UploaderLabel — подпись загрузчика в карточке результата поиска.
 *
 * Чистые функции (паритет с SearchPolicy.ts): выбирают отображаемое имя и
 * i18n-ключ строки «👤 Загрузил: …». С ID (tg_id) — отдельный ключ
 * `search.uploader_with_id`, без него (нет данных / старый сервер) — прежний
 * `search.uploader`: старый формат не ломается, `{tg_id}` не «вылезает»
 * в интерфейс.
 */

/** Минимум полей uploader'а, которые используют карточки (см. SearchResultItem). */
export interface UploaderLike {
  first_name?: string | null;
  username?: string | null;
  tg_id?: number | null;
}

/** i18n-ключи строки загрузчика: с ID и без. */
export type UploaderLabelKey =
  | "search.uploader_with_id"
  | "search.uploader";

/**
 * Имя для карточки: first_name → @username → «—».
 * (Паритет со старым inline-кодом SearchPage.renderResultCard.)
 */
export function uploaderDisplayName(u?: UploaderLike | null): string {
  if (!u) return "—";
  const name = (u.first_name || "").trim();
  if (name) return name;
  const uname = (u.username || "").trim();
  if (uname) return `@${uname}`;
  return "—";
}

/**
 * Ключ i18n: показывать ID рядом с именем, только если он есть и валиден
 * (tg_id — положительное конечное число; 0/NaN/absent → без ID).
 */
export function uploaderLabelKey(u?: UploaderLike | null): UploaderLabelKey {
  const id = u?.tg_id;
  return typeof id === "number" && Number.isFinite(id) && id > 0
    ? "search.uploader_with_id"
    : "search.uploader";
}
