/**
 * T8b — source-гейты заголовка баланса (D-BP-5): логика обязана быть подключена.
 *
 * S1  App.ts использует begin/settle (дедуп in-flight) — иначе тик 15с и WS
 *     вешают параллельные запросы.
 * S2  единственная запись `t("header.loading_balance")` идёт под guard'ом
 *     headerHint — значение уже известно ⇒ текст не трогаем (анти-мигание).
 * S3  ветка WS `balance_update` применяет значение напрямую (без GET-запроса).
 * S4  новый тест подключён к ранеру `test:ui` (иначе он не гоняется).
 *
 * Ранер: npm run test:ui
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const appSrc = readFileSync(join(ROOT, "src", "ui", "App.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("S1: App.ts использует begin/settle для дедупа запроса баланса", () => {
  assert.ok(appSrc.includes("beginHeaderFetch("), "нет дедупа in-flight запроса");
  assert.ok(appSrc.includes("settleHeaderFetch("), "in-flight не сбрасывается — запросы зависнут");
});

test("S2: «⏳» показывается только пока значение не известно", () => {
  const idx = appSrc.indexOf('t("header.loading_balance")');
  assert.ok(idx >= 0, "ожидаем вызов t(\"header.loading_balance\") в App.ts");
  const before = appSrc.slice(Math.max(0, idx - 260), idx);
  assert.ok(
    before.includes("headerHint"),
    "запись loading_balance обязана стоять под guard'ом headerHint — " +
      "иначе каждый опрос/WS-пуш мигает заголовком",
  );
  // Ровно одна точка показа плейсхолдера — не больше.
  const count = appSrc.split('t("header.loading_balance")').length - 1;
  assert.equal(count, 1, `loading_balance должен встречаться один раз, найдено: ${count}`);
});

test("S3: WS balance_update применяет значение напрямую, без fetchAndShowBalance", () => {
  const start = appSrc.indexOf('data.type === "balance_update"');
  assert.ok(start >= 0, "ветка balance_update не найдена");
  const end = appSrc.indexOf('} else if (data.type === "packages_update")', start);
  assert.ok(end > start, "конец ветки balance_update не найден");
  const branch = appSrc.slice(start, end);

  assert.ok(
    branch.includes("_applyPushedBalance("),
    "push обязан применяться напрямую (мгновенный заголовок, без лишнего GET)",
  );
  assert.ok(
    !branch.includes("fetchAndShowBalance("),
    "баланс не должен перезапрашиваться на каждый push — это лишний RTT и гонка",
  );
});

test("S4: новые тесты подключены к ранеру test:ui", () => {
  const runner: string = pkg.scripts["test:ui"];
  assert.ok(runner.includes("header-balance.test.js"), "header-balance.test.js не в test:ui");
  assert.ok(
    runner.includes("header-balance-source.test.js"),
    "header-balance-source.test.js не в test:ui",
  );
});
