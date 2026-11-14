/**
 * CatalogTree — чистая логика навигации по дереву публичного каталога (A3).
 *
 * Дерево приходит с сервера: GET /api/v1/search/public/tree
 * (зеркало /vault/api/tree): {total, kinds:[{kind,count,brands:[{brand,count,
 * models:[{model,count,ids}], ids?}]}]}. Software: папка = title (brand),
 * файлы лежат прямо в папке (models пусты, ids на уровне папки).
 *
 * Без DOM и без сети — тестируется в tests/catalog-tree.test.ts.
 * UI-рендер (бренды/кромки/карточки) — SearchPage._renderTreeState.
 */

import { buildFilter, type FacetSelection } from "./FacetQuery";

/**
 * Классы контента без бренда/модели (SP-35/D-185; SP-36/D-188 добавил
 * isp_emmc и repair_pictures): папка = название карточки
 * (`properties.title`), файлы лежат прямо в папке.
 *   software        — софт/утилита;
 *   datasheet       — даташит микросхемы;
 *   isp_emmc        — ISP-подключение eMMC;
 *   repair_pictures — фото/видео ремонта;
 *   any_file        — произвольный файл личного хранилища.
 */
const TITLE_ONLY_KINDS: ReadonlySet<string> = new Set([
  "software", "datasheet", "isp_emmc", "repair_pictures", "any_file",
]);

export interface CatalogTreeModel {
  model: string;
  count: number;
  ids: number[];
}

export interface CatalogTreeBrand {
  brand: string;
  count: number;
  models: CatalogTreeModel[];
  /** software: файлы лежат прямо в папке (промежуточного level model нет). */
  ids?: number[];
}

export interface CatalogTreeKind {
  kind: string;
  count: number;
  brands: CatalogTreeBrand[];
}

export interface CatalogTree {
  total: number;
  kinds: CatalogTreeKind[];
}

/** Путь в дереве: [] → корень (kinds), [kind] → brands, [kind, brand] → models. */
export type TreePath = string[];

/** Выбранная папка-лист: показываем её файлы плоским списком карточек. */
export interface TreeLeaf {
  kind: string;
  brand: string;
  model: string | null;
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** kind-секции дерева в порядке сервера (KIND_ORDER уже применён). */
export function kindsAt(tree: CatalogTree): CatalogTreeKind[] {
  return tree.kinds;
}

/** Бренды секции на пути []; путь из 2+ сегментов → null (не уровень брендов). */
export function brandsAt(tree: CatalogTree, path: TreePath): CatalogTreeBrand[] {
  if (path.length !== 1) return [];
  const kind = tree.kinds.find((k) => k.kind === path[0]);
  return kind ? kind.brands : [];
}

/** Модели бренда на пути [kind, brand]; иначе []. */
export function modelsAt(tree: CatalogTree, path: TreePath): CatalogTreeModel[] {
  if (path.length !== 2) return [];
  const brand = brandsAt(tree, [path[0]]).find((b) => b.brand === path[1]);
  return brand ? brand.models : [];
}

/**
 * Классы контента без бренда/модели (SP-35/D-185; SP-36/D-188: + isp_emmc,
 * repair_pictures): папка = название карточки (`properties.title`), файлы
 * лежат прямо в папке. title-only kind (software/datasheet/isp_emmc/
 * repair_pictures/any_file) — всегда лист на уровне brand.
 */
export function isLeafClick(kind: string, brand: CatalogTreeBrand): boolean {
  if (TITLE_ONLY_KINDS.has(kind)) return true;
  return brand.models.length === 0;
}

/**
 * FacetSelection листа → buildFilter для GET /api/v1/search/public?filter=.
 * software: файлы индексируются по properties.title, brand пуст → фильтр по
 * title (значение папки). firmware/documentation → brand (+ model, если есть).
 */
export function leafSelection(leaf: TreeLeaf): FacetSelection {
  const sel: FacetSelection = { kind: [leaf.kind] };
  if (TITLE_ONLY_KINDS.has(leaf.kind)) {
    sel.title = [leaf.brand];
    return sel;
  }
  sel.brand = [leaf.brand];
  if (leaf.model) sel.model = [leaf.model];
  return sel;
}

/** Meili filter-строка листа (пустой бренд не фильтруем — паритет «—»). */
export function leafFilter(leaf: TreeLeaf): string {
  const sel = leafSelection(leaf);
  if (sel.brand && sel.brand.length === 1 && !sel.brand[0].trim()) {
    delete sel.brand;
  }
  return buildFilter(sel);
}

/** Клиентский фильтр для legacy-фолбэка (/desktop/search без filter-параметра). */
export function matchesLeaf(item: {
  content_kind?: string;
  brand?: string;
  model?: string;
  title?: string;
}, leaf: TreeLeaf): boolean {
  const kind = item.content_kind || "firmware";
  if (kind !== leaf.kind) return false;
  if (TITLE_ONLY_KINDS.has(leaf.kind)) {
    return (item.title || "").trim() === leaf.brand.trim();
  }
  if ((item.brand || "").trim() !== leaf.brand.trim()) return false;
  if (leaf.model != null && (item.model || "").trim() !== leaf.model.trim()) {
    return false;
  }
  return true;
}
