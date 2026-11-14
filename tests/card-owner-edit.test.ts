/**
 * Разовая самоправка текста карточки владельцем — клиентская часть (D-186).
 *
 * Серверная часть (слот `owner_edit_used_at`, журнал, 409/400) покрыта
 * Python-тестами (`tests_desktop/test_card_owner_edit.py`). Здесь — то, что
 * видит мастер, и что нельзя проверить на сервере:
 *
 *   U1 кнопка «Редагувати» есть ТОЛЬКО у своей карточки: у публичной — под
 *      `_isOwnPublicCard`, у личной — в кабинете (там все карточки свои);
 *   U2 после потраченной попытки форма не открывается, а кнопка объясняет
 *      «використано» (состояние приходит с сервера, клиент не угадывает);
 *   U3 409 сервера показывается человеческим текстом, а не «API 409: {...}»;
 *   U4 в PATCH уходят ТОЛЬКО изменённые поля (иначе сервер посчитает правку
 *      конфликтом и потратит единственную попытку зря);
 *   U5 пустая характеристика — осознанное «убрать значение» (уходит пустой
 *      строкой, сервер удаляет ключ), а не «не трогать»;
 *   U6 набор полей берётся с СЕРВЕРА: у прошивки нет `doc_type`/`title`,
 *      у документации есть `doc_type` (клиент не изобретает поля).
 *
 * Ранер без внешних зависимостей: встроенный node:test. Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildCardEditFields,
  buildCardEditPatch,
  cardEditButtonLabel,
  cardEditErrorKey,
  hasCardEditChanges,
  parseCardEditError,
  CardEditDialog,
  SCALAR_ORDER,
  PROPERTY_ORDER,
  type CardEditField,
} from "../src/ui/CardEditDialog";

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
}

function state(over: Record<string, unknown> = {}): any {
  return {
    ok: true,
    card_kind: "file",
    card_id: 7,
    content_kind: "firmware",
    card: {
      brand: "Samsung",
      model: "UE40D5000",
      version: "v1.0",
      description: "старое описание",
      properties: { chassis: "LD33B", chipset: "MT5891" },
    },
    editable_scalars: ["brand", "model", "version", "description"],
    editable_property_keys: ["chassis", "chipset"],
    required_property_keys: [],
    can_edit: true,
    used_at: null,
    revision: 0,
    ...over,
  };
}

test("U1: кнопка правки — только у своей карточки", () => {
  const page = src("ui/SearchPage.ts");
  // D-187: кнопки владельца живут в ОДНОМ ряду инструментов карточки
  // (`_cardToolsRowHtml`); право решает владение — у чужой публичной карточки
  // ряда нет вовсе (сервер там ответит 403, обещать действие нельзя).
  assert.match(
    page,
    /_isOwnPublicCard\(item\) \? this\._cardToolsRowHtml\("file", item\.id\)/,
    "у чужой карточки нет ряда инструментов владельца",
  );
  assert.match(
    page,
    /private _cardToolsRowHtml\([\s\S]{0,400}?_addEditButtonHtml/,
    "кнопка правки рендерится внутри ряда инструментов",
  );
  assert.match(
    page,
    /this\._cardToolsRowHtml\(\s*"personal",\s*item\.id/,
    "в кабинете ряд инструментов (все карточки свои)",
  );
  assert.match(page, /cardEditDialog\.open\(kind, cardId\)/);
});

test("U2: после потраченной попытки форма не открывается", async () => {
  const toasts: Array<{ text: string; type?: string }> = [];
  let saveCalled = false;
  const dialog = new CardEditDialog({
    load: async () => state({ can_edit: false, used_at: "2026-11-11T10:00:00Z" }),
    save: async () => {
      saveCalled = true;
      throw new Error("save must not be called");
    },
    onToast: (text, type) => toasts.push({ text, type }),
  });

  await dialog.open("file", 7);

  assert.equal(saveCalled, false, "save не должен вызываться");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, "info");
  assert.ok(toasts[0].text.trim().length > 0, "мастеру нужен текст, а не пустой тост");
  assert.notEqual(cardEditButtonLabel(true), cardEditButtonLabel(false));
});

test("U3: 409 читается человеком, а не «API 409: {...}»", () => {
  const err = Object.assign(
    new Error(
      'API 409: {"ok":false,"code":"edit_already_used","error":"правка уже была использована"}',
    ),
    { status: 409 },
  );
  const info = parseCardEditError(err);
  assert.equal(info.status, 409);
  assert.equal(info.code, "edit_already_used");
  assert.equal(info.message, "правка уже была использована");
  assert.equal(cardEditErrorKey(info.code), "card_edit.err_used");
  assert.doesNotMatch(cardEditErrorKey(info.code), /API \d/);
});

test("U3b: без тела ошибки код выводится из статуса", () => {
  assert.equal(parseCardEditError({ status: 409 }).code, "edit_already_used");
  assert.equal(parseCardEditError({ status: 403 }).code, "not_owner");
});

test("U4: в PATCH уходят только изменённые поля", () => {
  const s = state();
  const fields = buildCardEditFields(s);
  const values: Record<string, string> = {};
  for (const f of fields) values[f.key] = f.value;
  values.version = "v2.0";

  const patch = buildCardEditPatch(fields, values);
  assert.deepEqual(patch, { version: "v2.0" });
  assert.equal(hasCardEditChanges(patch), true);

  const noopValues: Record<string, string> = {};
  for (const f of fields) noopValues[f.key] = f.value;
  const noop = buildCardEditPatch(fields, noopValues);
  assert.deepEqual(noop, {});
  assert.equal(hasCardEditChanges(noop), false);
});

test("U4b: характеристики уходят внутрь properties", () => {
  const s = state();
  const fields = buildCardEditFields(s);
  const values: Record<string, string> = {};
  for (const f of fields) values[f.key] = f.value;
  values.chipset = "RTD2995";

  assert.deepEqual(buildCardEditPatch(fields, values), {
    properties: { chipset: "RTD2995" },
  });
});

test("U5: очистка характеристики уходит пустой строкой", () => {
  const s = state();
  const fields = buildCardEditFields(s);
  const values: Record<string, string> = {};
  for (const f of fields) values[f.key] = f.value;
  values.chassis = "";

  assert.deepEqual(buildCardEditPatch(fields, values), {
    properties: { chassis: "" },
  });
});

test("U6: набор полей диктует сервер, а не клиент", () => {
  const firmware = buildCardEditFields(state()).map((f: CardEditField) => f.key);
  assert.ok(firmware.includes("brand"));
  assert.ok(firmware.includes("chassis"));
  assert.ok(!firmware.includes("doc_type"), "у прошивки нет типа документации");
  assert.ok(!firmware.includes("title"), "у прошивки нет title");

  const docs = buildCardEditFields(
    state({
      content_kind: "documentation",
      editable_property_keys: ["doc_type"],
      required_property_keys: ["doc_type"],
      card: {
        brand: "Samsung",
        model: "BN44",
        version: "",
        description: null,
        properties: { doc_type: "service_manual" },
      },
    }),
  ).map((f: CardEditField) => f.key);
  assert.deepEqual(docs, ["brand", "model", "version", "description", "doc_type"]);

  const hw = buildCardEditFields(
    state({
      editable_property_keys: ["hardware_type"],
      card: { ...state().card, properties: { hardware_type: "original" } },
    }),
  ).find((f) => f.key === "hardware_type");
  assert.equal(hw?.options?.length, 2, "hardware_type — селект из двух значений");
});

test("U7: клиент не отправляет content_kind и служебные поля файла", () => {
  // Список полей формы — единственный источник тела PATCH: замороженных полей
  // (класс контента и идентичность файла) в нём нет by design.
  const editable = new Set<string>([...SCALAR_ORDER, ...PROPERTY_ORDER]);
  for (const frozen of ["content_kind", "cloud_key", "sha256", "size_bytes", "status"]) {
    assert.equal(editable.has(frozen), false, `${frozen} не редактируется клиентом`);
  }
  const apiSrc = src("api.ts");
  assert.match(apiSrc, /cardEditState/);
  assert.match(apiSrc, /cardEditPatch/);
});
