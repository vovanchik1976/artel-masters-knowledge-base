/**
 * CardJump — «из чата в карточку» и обратно (D-135/D-136, поручение владельца).
 *
 * D-136: карточка по ссылке из чата — ПОЛНАЯ (её рисует единый
 * `SearchPage._buildResultCard`), поэтому модуль отдаёт только чип возврата.
 * Компактного рендерера здесь больше нет — это и был дефект, который владелец
 * отверг. Раннер: node:test, без DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderReturnChipHtml } from "../src/ui/CardJump";

test("D-135: чип возврата в чат", () => {
  const html = renderReturnChipHtml();
  assert.match(html, /data-return-community/);
  assert.match(html, /search-return-chip/);
});

