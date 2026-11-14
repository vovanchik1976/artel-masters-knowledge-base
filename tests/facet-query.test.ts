/**
 * FacetQuery — чистая логика фасетного фильтра каталога (Phase 3).
 *
 * Тестируем: сериализация в Meili filter-строку (с экранированием),
 * toggle-логика, сброс поля/всех, подготовка групп для UI (top-N + active
 * values за пределами top-N).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFilter,
  clearAll,
  clearField,
  countActive,
  facetGroups,
  toggleValue,
  type FacetSelection,
} from "../src/search/FacetQuery";

test("buildFilter: empty selection → empty string", () => {
  assert.equal(buildFilter({}), "");
});

test("buildFilter: single value per field", () => {
  const f = buildFilter({ kind: ["firmware"] });
  assert.equal(f, '(kind = "firmware")');
});

test("buildFilter: multi values OR inside field, AND between fields", () => {
  const f = buildFilter({
    kind: ["firmware", "software"],
    brand: ["Samsung"],
  });
  assert.equal(
    f,
    '(brand = "Samsung") AND (kind = "firmware" OR kind = "software")',
  );
});

test("buildFilter: escapes double quotes in values", () => {
  const f = buildFilter({ title: ['Tool "Pro"'] });
  assert.equal(f, '(title = "Tool \\"Pro\\"")');
});

test("buildFilter: empty value array is skipped", () => {
  assert.equal(buildFilter({ kind: [] }), "");
});

test("toggleValue: adds value", () => {
  const sel = toggleValue({}, "kind", "firmware");
  assert.deepEqual(sel, { kind: ["firmware"] });
});

test("toggleValue: removes existing value", () => {
  const sel = toggleValue({ kind: ["firmware", "software"] }, "kind", "firmware");
  assert.deepEqual(sel, { kind: ["software"] });
});

test("toggleValue: drops empty field key", () => {
  const sel = toggleValue({ kind: ["firmware"] }, "kind", "firmware");
  assert.deepEqual(sel, {});
});

test("clearField removes only that field", () => {
  const sel: FacetSelection = { kind: ["firmware"], brand: ["LG"] };
  assert.deepEqual(clearField(sel, "kind"), { brand: ["LG"] });
});

test("clearAll empties selection", () => {
  const sel: FacetSelection = { kind: ["firmware"], brand: ["LG"] };
  assert.deepEqual(clearAll(sel), {});
});

test("countActive counts values", () => {
  assert.equal(countActive({ kind: ["firmware", "software"], brand: ["LG"] }), 3);
  assert.equal(countActive({}), 0);
});

test("facetGroups: ordered, top-N, active beyond top-N preserved", () => {
  const distribution: Record<string, Record<string, number>> = {
    brand: {
      Samsung: 30,
      LG: 20,
      Philips: 10,
      Sony: 5,
      Panasonic: 3,
      Sharp: 2,
      Horizon: 1,
      Vestel: 1,
      // активный, но за пределами top-8 → должен остаться в группе
      Turbo: 1,
    },
  };
  const selection: FacetSelection = { brand: ["Turbo"] };
  const groups = facetGroups(distribution, ["brand"], selection, 8);

  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.field, "brand");
  // top-8 по счётчику + активный Turbo = 9 значений
  assert.equal(g.options.length, 9);
  assert.equal(g.options[0].value, "Samsung");
  assert.equal(g.options[0].count, 30);
  const turbo = g.options.find((o) => o.value === "Turbo");
  assert.ok(turbo, "active value beyond top-N must be kept");
  assert.equal(turbo?.active, true);
  assert.equal(g.options.filter((o) => o.active).length, 1);
});

test("facetGroups: unknown field in selection gets zero-count entry", () => {
  // Значение выбрано, но facetDistribution его не содержит (фильтр применён —
  // счётчик исчез) → показываем с count 0, чтобы можно было снять выбор.
  const groups = facetGroups({}, ["kind"], { kind: ["firmware"] }, 8);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].options[0].value, "firmware");
  assert.equal(groups[0].options[0].count, 0);
  assert.equal(groups[0].options[0].active, true);
});

test("facetGroups: distribution without selection still renders groups", () => {
  const groups = facetGroups(
    { kind: { firmware: 5, software: 2 } },
    ["kind", "brand"],
    {},
    8,
  );
  assert.equal(groups.length, 1); // brand пуст → группа не создаётся
  assert.deepEqual(
    groups[0].options.map((o) => o.value),
    ["firmware", "software"],
  );
});
