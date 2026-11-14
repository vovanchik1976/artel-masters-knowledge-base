/**
 * SearchPolicy — чистая логика порога поиска (2026-09-19, BUG-SEARCH-SCOPE-002).
 *
 * Требование владельца: текстовый поиск начинается от MIN_SEARCH_CHARS
 * символов («фильтры загрубить») — короткие запросы (1–2 символа) не шлют
 * ни Meili-прокси, ни legacy ILIKE.
 *
 * Без DOM и без сети — тестируется в tests/search-policy.test.ts.
 */

export const MIN_SEARCH_CHARS = 3;

export type SearchDecision = "empty" | "too_short" | "search";

/**
 * Решение по сырому содержимому поисковой строки.
 *   - "empty"    — поле пустое/из одних пробелов: обычное поведение
 *                  (личный режим → список всех своих; публичный → no-op
 *                  либо просмотр каталога с активными фасетами);
 *   - "too_short"— 1–2 символа: запрос НЕ отправляется, UI показывает
 *                  подсказку `search.min_chars`;
 *   - "search"   — от MIN_SEARCH_CHARS символов: обычный поиск.
 */
export function decideSearch(rawInput: string): SearchDecision {
  const q = rawInput.trim();
  if (!q) return "empty";
  return q.length >= MIN_SEARCH_CHARS ? "search" : "too_short";
}
