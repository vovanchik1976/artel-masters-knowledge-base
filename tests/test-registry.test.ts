/**
 * Гейт «реестра тестов» — ни один тест не должен остаться за бортом `test:ui`.
 *
 * RED (до фикса, 2026-10-30): `npm run test:ui` перечисляет файлы ЯВНЫМ списком
 * путей, поэтому новый тест работает только если его туда дописали руками.
 * Живые последствия: `tests/card-jump.test.ts` (D-135, прыжок чат→карточка) и
 * `tests/widget-login.test.ts` (D-109, вход по ссылке из бота) компилировались,
 * но НИКОГДА не запускались — у card-jump при этом был сломан ассерт размера
 * (`МБ` против латинского «2.5 MB») и гейт этого не замечал. Плюс в списке
 * висела мёртвая запись `auth-code-delivery.test.js`: исходник удалён в
 * `3ece9f9` (D-108), а путь остался и молча игнорировался node.
 *
 * Инварианты:
 * 1. каждый `tests/*.test.ts` присутствует в `test:ui` (иначе тест не гоняется);
 * 2. каждая запись `test:ui` имеет живой исходник (мёртвый путь = фиктивный гейт).
 *
 * Гейт по ИСХОДНИКАМ, без исполнения тестов: достаточно прочитать `package.json`
 * и каталог `tests/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Корень проекта (`desktop-electron`) — от `outDir` (`tmp-tests/tests`) вверх. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

/** Пути, перечисленные в `scripts["test:ui"]` (без `tmp-tests/tests/` и `.test.js`). */
function registeredTests(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.["test:ui"];
  assert.ok(script, "в package.json нет scripts[\"test:ui\"]");
  const found = new Set<string>();
  for (const m of script!.matchAll(/tmp-tests\/tests\/([A-Za-z0-9_-]+)\.test\.js/g)) found.add(m[1]);
  return [...found].sort();
}

/** Имена файлов `tests/*.test.ts` (без расширения). */
function sourceTests(): string[] {
  const dir = path.join(projectRoot(), "tests");
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith(".test.ts"))
    .map(name => name.slice(0, -".test.ts".length))
    .sort();
}

test("R1: каждый tests/*.test.ts подключён к npm run test:ui", () => {
  const registered = new Set(registeredTests());
  const missing = sourceTests().filter(name => !registered.has(name));
  assert.deepEqual(missing, [], `тесты не гоняются (добавь в scripts["test:ui"]): ${missing.join(", ")}`);
});

test("R2: в test:ui нет мёртвых путей без исходника", () => {
  const sources = new Set(sourceTests());
  const dead = registeredTests().filter(name => !sources.has(name));
  assert.deepEqual(dead, [], `в test:ui висят пути без tests/<имя>.test.ts: ${dead.join(", ")}`);
});

test("R3: гейт ловит регресс (самопроверка парсера)", () => {
  // Защита от «гейт зелёный, потому что ничего не распарсил».
  assert.ok(registeredTests().length > 30, "распознано подозрительно мало записей test:ui");
  assert.ok(sourceTests().includes("card-jump"), "card-jump.test.ts должен существовать (D-135)");
  assert.ok(sourceTests().includes("widget-login"), "widget-login.test.ts должен существовать (D-109)");
});
