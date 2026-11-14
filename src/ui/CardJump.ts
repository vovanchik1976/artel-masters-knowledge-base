/**
 * CardJump — переход «из чата в карточку» и обратно (D-135/D-136).
 *
 * Поручение владельца (2026-10-29): в чатах карточек — ссылка на обсуждаемую
 * карточку, «тык — и переносит в карточку, с возвратом на чат».
 *
 * Поручение владельца (2026-10-30, D-136): карточка по ссылке обязана быть
 * ПОЛНОЙ — как в полноценном поисковике. Поэтому разметку карточки этот
 * модуль больше НЕ строит: её рисует единый рендерер `SearchPage._buildResultCard`
 * (поля формы, медиа, отзывы, сводка, вложения). Здесь остаётся только чип
 * возврата в чат — вторая копия разметки запрещена гейтом
 * `tests/focus-card-full.test.ts`.
 *
 * Чистые функции без DOM — их проверяет `tests/card-jump.test.ts`.
 */
import { t } from "../i18n";

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Чип «вернуться в чат» — встаёт в шапку карточки, открытой из чата. */
export function renderReturnChipHtml(): string {
  return (
    `<button type="button" class="btn btn-secondary search-return-chip" ` +
    `data-return-community>${escapeHtml(t("search.back_to_chat"))}</button>`
  );
}
