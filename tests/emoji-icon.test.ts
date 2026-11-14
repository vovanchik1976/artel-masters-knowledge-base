/**
 * Гейт «кнопка смайликов в стиле приложения» (запрос владельца 2026-10-31, D-140).
 *
 * ПРЕЖДЕ (RED №1): кнопка выбора эмодзи рисовала старый текстовый глиф `☺`.
 * ПРЕЖДЕ (RED №2, жалоба владельца «кнопка эмодзи не в стиле — бедная»):
 * кнопка была плоской плашкой 36×36 с тонкой линией-иконкой, рядом с
 * «Отправить» (градиент, radius 12, высота строки) — визуально выпадала.
 * ПОСЛЕ: кнопка — стеклянная плитка в материале приложения (градиент
 * btn-primary-семейства, radius 12, растянута по высоте строки), а иконка —
 * заливной «стикер»-смайлик с тёплым градиентом и блик-подсветкой.
 *
 * Гейт по ИСХОДНИКАМ: в тестах нет DOM (node:test), поэтому, как
 * test-registry/single-instance-lock, читаем исходники и проверяем
 * экспортируемую разметку иконки и CSS-правила кнопки в index.html.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { emojiToggleIconMarkup } from "../src/ui/EmojiPicker";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

test("R1: иконка кнопки смайликов — inline SVG, а не текстовый глиф ☺", () => {
  const markup = emojiToggleIconMarkup();
  assert.match(markup, /<svg[\s>]/, "разметка кнопки обязана быть SVG");
  assert.match(markup, /aria-hidden="true"/, "декоративная иконка обязана быть скрыта от скринридера (aria-label на кнопке)");
  assert.ok(!markup.includes("☺"), "старый текстовый глиф ☺ недопустим");
});

test("R2: иконка — заливной «стикер»-смайлик с тёплым градиентом (не тонкая обводка)", () => {
  const markup = emojiToggleIconMarkup();
  // Лицо залито градиентом (не stroke-контур): так иконка «читается» на 24px.
  assert.match(markup, /fill="url\(#emoji-face/, "лицо смайлика обязано быть залито градиентом");
  // Тёплый янтарный материал — узнаваемый «эмодзи», а не ещё одна линия-иконка.
  assert.match(markup, /#f7c948/, "в градиенте лица обязан быть янтарный стоп");
  // Глаза и улыбка — отдельные тёмные формы (не текстовый символ).
  assert.match(markup, /<path[^>]+d="M7\.6 13\.7/, "улыбка обязана быть путём");
  assert.equal((markup.match(/<circle[^>]+cy="10\.2"/g) || []).length, 2, "оба глаза — круги");
});

test("R2b: id градиентов уникальны на инстанс (несколько пикеров на странице)", () => {
  const a = emojiToggleIconMarkup("_a");
  const b = emojiToggleIconMarkup("_b");
  assert.match(a, /id="emoji-face_a"/, "суффикс обязан попадать в id градиента");
  assert.match(a, /fill="url\(#emoji-face_a\)"/, "ссылка обязана указывать на свой id");
  assert.match(b, /id="emoji-face_b"/);
  assert.ok(!a.includes("emoji-face_b"), "разметка инстанса не должна ссылаться на чужой id");
});

test("R3: в исходнике EmojiPicker.ts глиф ☺ больше нигде не используется", () => {
  const src = fs.readFileSync(
    path.join(projectRoot(), "src", "ui", "EmojiPicker.ts"),
    "utf8",
  );
  assert.ok(!src.includes("☺"), "в EmojiPicker.ts остался старый глиф ☺ — замените на SVG");
});

/** Вырезать тело CSS-правила по точному селектору из index.html. */
function cssRule(selector: string): string {
  const html = fs.readFileSync(path.join(projectRoot(), "index.html"), "utf8");
  const from = html.indexOf(selector + " {");
  assert.notEqual(from, -1, `не нашли CSS-правило ${selector} в index.html`);
  const to = html.indexOf("}", from);
  assert.ok(to > from, `правило ${selector} не закрыто`);
  return html.slice(from, to);
}

test("R4: кнопка — плитка в материале приложения (radius 12, высота строки, градиент)", () => {
  const rule = cssRule(".community-emoji-toggle");
  // Габарит: та же высота, что у кнопки «Отправить» (растяжение по строке).
  assert.match(rule, /align-self:\s*stretch/, "кнопка обязана растягиваться по высоте футера");
  assert.match(rule, /height:\s*100%/, "кнопка внутри host'а обязана занимать всю высоту");
  // Форма и материал — как у .btn/.btn-primary, а не «плоская плашка».
  assert.match(rule, /border-radius:\s*12px/, "radius кнопки обязан совпадать с .btn (12px)");
  assert.match(rule, /linear-gradient\(/, "фон кнопки обязан быть градиентом btn-primary-семейства");
  // Акцент берётся из токена пресета (D-141): раньше здесь стояли зашитые цифры
  // rgba(93,173,226,…) — из-за них кнопка не перекрашивалась вместе с темой.
  assert.match(
    rule,
    /rgba\(var\(--accent-rgb\)|var\(--accent\)/,
    "акцентный цвет материала — из токена приложения (--accent-rgb/--accent)",
  );
  // Плоский фон из «бедной» версии недопустим.
  assert.ok(
    !/background:\s*var\(--surface2\)/.test(rule),
    "вернулся плоский background:var(--surface2) — это и была «бедная» кнопка",
  );
  assert.match(rule, /cursor:\s*pointer/, "кнопка обязана выглядеть кликабельной");
});

test("R4b: host кнопки участвует в раскладке футера (не схлопывается)", () => {
  const rule = cssRule(".community-emoji-host");
  assert.match(rule, /display:\s*flex/, "host обязан быть flex-контейнером кнопки");
  assert.match(rule, /align-self:\s*stretch/, "host обязан тянуться по высоте футера");
});
