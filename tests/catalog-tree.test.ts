/**
 * CatalogTree — навигация по дереву публичного каталога (A3, «Весь каталог»).
 *
 * Тестируем: уровни дерева (kinds/brands/models), детект листа (software —
 * всегда лист по title), сборку facet-filter листа (экранирование, пустой
 * brand), клиентский фильтр legacy-фолбэка matchesLeaf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brandsAt,
  isLeafClick,
  kindsAt,
  leafFilter,
  leafSelection,
  matchesLeaf,
  modelsAt,
  type CatalogTree,
  type TreeLeaf,
} from "../src/search/CatalogTree";

const TREE: CatalogTree = {
  total: 4,
  kinds: [
    {
      kind: "firmware",
      count: 3,
      brands: [
        {
          brand: "Samsung",
          count: 2,
          models: [
            { model: "UE55", count: 2, ids: [1, 2] },
          ],
        },
        { brand: "LG", count: 1, models: [{ model: "OLED", count: 1, ids: [3] }] },
      ],
    },
    {
      kind: "software",
      count: 1,
      brands: [
        { brand: "RF-Linker", count: 1, models: [], ids: [4] },
      ],
    },
  ],
};

test("kindsAt: server order preserved", () => {
  assert.deepEqual(
    kindsAt(TREE).map((k) => k.kind),
    ["firmware", "software"],
  );
});

test("brandsAt: only depth-1 path yields brands", () => {
  assert.equal(brandsAt(TREE, []).length, 0);
  assert.equal(brandsAt(TREE, ["firmware"]).length, 2);
  assert.equal(brandsAt(TREE, ["firmware", "Samsung"]).length, 0);
  assert.equal(brandsAt(TREE, ["unknown"]).length, 0);
});

test("modelsAt: only depth-2 path yields models", () => {
  assert.equal(modelsAt(TREE, ["firmware", "Samsung"]).length, 1);
  assert.equal(modelsAt(TREE, ["firmware"]).length, 0);
  assert.equal(modelsAt(TREE, ["software", "RF-Linker"]).length, 0);
});

test("isLeafClick: software is always a leaf (folder = title)", () => {
  const sw = TREE.kinds[1].brands[0];
  assert.equal(isLeafClick("software", sw), true);
});

// ════════════ SP-36 / D-188: isp_emmc + repair_pictures ════════════

const TREE_V8: CatalogTree = {
  total: 2,
  kinds: [
    {
      kind: "isp_emmc",
      count: 1,
      brands: [{ brand: "eMMC dump", count: 1, models: [], ids: [10] }],
    },
    {
      kind: "repair_pictures",
      count: 1,
      brands: [{ brand: "Ремонт LG", count: 1, models: [], ids: [11] }],
    },
  ],
};

test("SP-36: нові kind — TITLE_ONLY листи (клік по папці = файлы)", () => {
  assert.equal(isLeafClick("isp_emmc", TREE_V8.kinds[0].brands[0]), true);
  assert.equal(isLeafClick("repair_pictures", TREE_V8.kinds[1].brands[0]), true);
});

test("SP-36: leafSelection/leafFilter — фільтр по title, а не по brand", () => {
  const leaf: TreeLeaf = { kind: "isp_emmc", brand: "eMMC dump", model: null };
  assert.deepEqual(leafSelection(leaf), {
    kind: ["isp_emmc"],
    title: ["eMMC dump"],
  });
  assert.equal(
    leafFilter({ kind: "repair_pictures", brand: "Ремонт LG", model: null }),
    '(kind = "repair_pictures") AND (title = "Ремонт LG")',
  );
});

test("SP-36: matchesLeaf — legacy-фолбэк матчить по title", () => {
  const leaf: TreeLeaf = { kind: "isp_emmc", brand: "eMMC dump", model: null };
  assert.equal(
    matchesLeaf({ content_kind: "isp_emmc", title: "eMMC dump", brand: "", model: "" }, leaf),
    true,
  );
  assert.equal(
    matchesLeaf({ content_kind: "isp_emmc", title: "Другий дамп", brand: "" }, leaf),
    false,
  );
});

test("isLeafClick: brand without models is a leaf, with models — descend", () => {
  assert.equal(isLeafClick("firmware", TREE.kinds[0].brands[0]), false);
  assert.equal(
    isLeafClick("firmware", { brand: "X", count: 1, models: [] }),
    true,
  );
});

test("leafSelection: firmware leaf → kind+brand+model", () => {
  const leaf: TreeLeaf = { kind: "firmware", brand: "Samsung", model: "UE55" };
  assert.deepEqual(leafSelection(leaf), {
    kind: ["firmware"],
    brand: ["Samsung"],
    model: ["UE55"],
  });
});

test("leafSelection: software leaf → kind+title (brand in tree is title)", () => {
  const leaf: TreeLeaf = { kind: "software", brand: "RF-Linker", model: null };
  assert.deepEqual(leafSelection(leaf), {
    kind: ["software"],
    title: ["RF-Linker"],
  });
});

test("leafFilter: serializes to Meili filter with escaping", () => {
  const leaf: TreeLeaf = { kind: "software", brand: 'Tool "Pro"', model: null };
  const bs = String.fromCharCode(92); // один обратный слэш (экранирование в Meili-строке)
  assert.equal(
    leafFilter(leaf),
    `(kind = "software") AND (title = "Tool ${bs}"Pro${bs}"")`,
  );
});

test("leafFilter: empty brand dropped (fallback «—» rows)", () => {
  const leaf: TreeLeaf = { kind: "firmware", brand: "", model: null };
  assert.equal(leafFilter(leaf), '(kind = "firmware")');
});

test("matchesLeaf: kind/brand/model compared with trim", () => {
  const leaf: TreeLeaf = { kind: "firmware", brand: "Samsung", model: "UE55" };
  assert.equal(
    matchesLeaf({ content_kind: "firmware", brand: "Samsung ", model: "UE55" }, leaf),
    true,
  );
  assert.equal(
    matchesLeaf({ content_kind: "firmware", brand: "Samsung", model: "OTHER" }, leaf),
    false,
  );
  assert.equal(matchesLeaf({ content_kind: "software", brand: "Samsung" }, leaf), false);
});

test("matchesLeaf: software matches by title only", () => {
  const leaf: TreeLeaf = { kind: "software", brand: "RF-Linker", model: null };
  assert.equal(matchesLeaf({ content_kind: "software", title: "RF-Linker" }, leaf), true);
  assert.equal(matchesLeaf({ content_kind: "software", title: "Other" }, leaf), false);
  assert.equal(
    matchesLeaf({ content_kind: "software", brand: "RF-Linker" }, leaf),
    false,
    "у software brand пуст — совпадение только по title",
  );
});
