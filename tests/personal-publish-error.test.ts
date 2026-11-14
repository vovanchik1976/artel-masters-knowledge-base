/**
 * Гейт «публікація особистого файла: чесна причина замість англійського тексту»
 * (SP-34 / D-184).
 *
 * ПРЕЖДЕ: сервер віддавав у `error` технічну англійську строку
 * («Personal file has no bot-side file_id yet (bot ingest not arrived — retry
 * publish later)»), і клієнт показував її майстру як є — укр. інтерфейс, англ.
 * текст, без підказки «що робити».
 * ПОСЛЯ: сервер віддає КОД (`personal_anchor_pending` / `personal_anchor_lost`),
 * клієнт мапить його на локаль, а технічна строка лишається тільки в логах.
 *
 * Гейт по ІСХОДНИКАХ (DOM у node:test немає): SearchPage.ts + локалі uk/ru/en.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function readClient(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Значение строкового ключа словаря локали (`<key>: "…"`), без кавычек. */
function keyText(dict: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(dict);
  assert.ok(m, `нет ключа ${key} в словаре локали`);
  return m[1];
}

/** Строка исходника, где встречается `needle` (для проверки аргументов вызова). */
function lineWith(source: string, needle: string): string {
  const line = source.split("\n").find(l => l.includes(needle));
  assert.ok(line, `в исходнике нет строки с «${needle}»`);
  return line!;
}

const UK = readClient("src/i18n/locales/uk.ts");
const RU = readClient("src/i18n/locales/ru.ts");
const EN = readClient("src/i18n/locales/en.ts");
const PAGE = readClient("src/ui/SearchPage.ts");

test("W1a: SearchPage мапить КОДИ помилок публікації, а не англійський текст", () => {
  assert.ok(PAGE.includes("personal_anchor_pending"),
    "клієнт не розпізнає код personal_anchor_pending");
  assert.ok(PAGE.includes("personal_anchor_lost"),
    "клієнт не розпізнає код personal_anchor_lost");
  assert.ok(PAGE.includes("search.publish_anchor_pending"));
  assert.ok(PAGE.includes("search.publish_anchor_lost"));
});

test("W1b: для кодів pending/lost у UI не підставляється технічна строка сервера", () => {
  // `{ err: res.error }` у цих повідомленнях = та сама англійська строка в UI.
  const pending = lineWith(PAGE, "search.publish_anchor_pending");
  const lost = lineWith(PAGE, "search.publish_anchor_lost");
  assert.ok(!pending.includes("err:"), `англійська строка протекла: ${pending.trim()}`);
  assert.ok(!lost.includes("err:"), `англійська строка протекла: ${lost.trim()}`);
});

test("W1c: обидва ключі є в усіх трьох локалях", () => {
  for (const key of ["publish_anchor_pending", "publish_anchor_lost"]) {
    assert.ok(keyText(UK, key).length > 10, `uk.${key} порожній`);
    assert.ok(keyText(RU, key).length > 10, `ru.${key} порожній`);
    assert.ok(keyText(EN, key).length > 10, `en.${key} порожній`);
  }
});

test("W1d: тексти локалізовані (укр./рос. кирилиця, англ. — латиниця)", () => {
  const ukText = keyText(UK, "publish_anchor_pending") + keyText(UK, "publish_anchor_lost");
  const ruText = keyText(RU, "publish_anchor_pending") + keyText(RU, "publish_anchor_lost");
  const enText = keyText(EN, "publish_anchor_pending") + keyText(EN, "publish_anchor_lost");

  assert.match(ukText, /[іїєґ]/i, "укр. текст без укр. літер");
  assert.match(ruText, /[ыэъё]/i, "рос. текст без рос. літер");
  assert.ok(!/[іїєґ]/i.test(ruText), "в рос. тексті укр. літери");
  assert.match(enText, /[A-Za-z]/);
  assert.ok(!/[іїєґыэъё]/i.test(enText), "в англ. тексті чужі літери");
});
