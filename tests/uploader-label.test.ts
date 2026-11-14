/**
 * UploaderLabel — подпись загрузчика в карточке результата поиска.
 *
 * Тестируем:
 *  - приоритет имени: first_name → @username → «—» (паритет со старым inline-кодом);
 *  - выбор i18n-ключа: есть валидный tg_id → `search.uploader_with_id`
 *    («👤 Загрузил: {name} · ID: {tg_id}»), иначе — старый `search.uploader`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  uploaderDisplayName,
  uploaderLabelKey,
} from "../src/search/UploaderLabel";

test("display name: first_name имеет приоритет над username", () => {
  assert.equal(
    uploaderDisplayName({ first_name: "Владимир", username: "vovan", tg_id: 1 }),
    "Владимир",
  );
});

test("display name: пустой first_name → @username", () => {
  assert.equal(
    uploaderDisplayName({ first_name: "  ", username: "vovan", tg_id: 1 }),
    "@vovan",
  );
});

test("display name: нет ни имени, ни username → «—»", () => {
  assert.equal(uploaderDisplayName({ tg_id: 1 }), "—");
  assert.equal(uploaderDisplayName({ first_name: "", username: null }), "—");
});

test("display name: uploader отсутствует (undefined/null) → «—»", () => {
  assert.equal(uploaderDisplayName(undefined), "—");
  assert.equal(uploaderDisplayName(null), "—");
});

test("label key: валидный tg_id → search.uploader_with_id", () => {
  assert.equal(
    uploaderLabelKey({ first_name: "Владимир", tg_id: 5173742991 }),
    "search.uploader_with_id",
  );
  assert.equal(uploaderLabelKey({ tg_id: 1 }), "search.uploader_with_id");
});

test("label key: нет tg_id → старый search.uploader (без ID)", () => {
  assert.equal(
    uploaderLabelKey({ first_name: "Владимир" }),
    "search.uploader",
  );
  assert.equal(
    uploaderLabelKey({ first_name: "Владимир", tg_id: null }),
    "search.uploader",
  );
  assert.equal(uploaderLabelKey(undefined), "search.uploader");
  assert.equal(uploaderLabelKey(null), "search.uploader");
});

test("label key: невалидный tg_id (0, NaN) → search.uploader", () => {
  assert.equal(uploaderLabelKey({ tg_id: 0 }), "search.uploader");
  assert.equal(uploaderLabelKey({ tg_id: NaN }), "search.uploader");
});
