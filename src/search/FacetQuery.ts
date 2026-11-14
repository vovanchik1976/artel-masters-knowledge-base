/**
 * FacetQuery — чистая логика фасетного фильтра каталога (Phase 3).
 *
 * SPEC: docs/SEARCH_CATALOG_ARCHITECTURE.md §7 (Phase 3).
 *
 * Без DOM и без сети: сериализация выбора фасетов в Meili filter-строку
 * для прокси GET /api/v1/search/public (поле `filter`, read-only) и
 * подготовка групп для панели фильтров (top-N значений, активные значения
 * за пределами top-N сохраняются, иначе их нельзя снять).
 *
 * Мультивыбор: внутри поля — OR, между полями — AND (семантика refinement).
 */

export type FacetSelection = Record<string, string[]>;

export interface FacetOption {
  value: string;
  count: number;
  active: boolean;
}

export interface FacetGroup {
  field: string;
  options: FacetOption[];
}

function escapeValue(value: string): string {
  // Meili filter: строковые значения в двойных кавычках, " → \"
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sortedFields(sel: FacetSelection): string[] {
  return Object.keys(sel).sort();
}

/** Toggle значения в поле; пустой массив удаляет ключ. Чистая функция. */
export function toggleValue(
  sel: FacetSelection,
  field: string,
  value: string,
): FacetSelection {
  const current = sel[field] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];

  const copy: FacetSelection = { ...sel };
  if (next.length === 0) {
    delete copy[field];
  } else {
    copy[field] = next;
  }
  return copy;
}

/** Убрать выбор по одному полю. */
export function clearField(sel: FacetSelection, field: string): FacetSelection {
  const copy: FacetSelection = { ...sel };
  delete copy[field];
  return copy;
}

/** Сбросить все фасеты. */
export function clearAll(_sel: FacetSelection): FacetSelection {
  return {};
}

/** Сколько значений выбрано (для бейджа «Фильтры активны: N»). */
export function countActive(sel: FacetSelection): number {
  return Object.values(sel).reduce((acc, arr) => acc + arr.length, 0);
}

/**
 * Сериализовать выбор в Meili filter-строку.
 * Внутри поля — OR, между полями — AND. Пустой выбор → "" (без фильтра).
 */
export function buildFilter(sel: FacetSelection): string {
  const parts: string[] = [];
  for (const field of sortedFields(sel)) {
    const values = sel[field] ?? [];
    if (values.length === 0) continue;
    const conds = values.map((v) => `${field} = "${escapeValue(v)}"`);
    parts.push(`(${conds.join(" OR ")})`);
  }
  return parts.join(" AND ");
}

/**
 * Подготовить группы для панели фильтров.
 *
 * - порядок полей = порядок в `fields` (пустые группы не выводятся);
 * - top-N значений по счётчику;
 * - активные значения, попавшие за пределы top-N, ДОБАВЛЯЮТСЯ (иначе
 *   выбранный фильтр нельзя снять из UI);
 * - выбранное значение, отсутствующее в facetDistribution (счётчик
 *   исчез после применения чужого фильтра) → с count 0.
 */
export function facetGroups(
  distribution: Record<string, Record<string, number>> | undefined,
  fields: string[],
  sel: FacetSelection,
  topN: number = 8,
): FacetGroup[] {
  const groups: FacetGroup[] = [];
  for (const field of fields) {
    const dist = distribution?.[field] ?? {};
    const selected = new Set(sel[field] ?? []);

    const options: FacetOption[] = Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([value, count]) => ({
        value,
        count,
        active: selected.has(value),
      }));

    // Активные значения за пределами top-N / отсутствующие в dist
    for (const value of selected) {
      if (!options.some((o) => o.value === value)) {
        options.push({ value, count: dist[value] ?? 0, active: true });
      }
    }

    if (options.length === 0) continue;
    groups.push({ field, options });
  }
  return groups;
}
