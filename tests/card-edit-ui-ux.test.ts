/**
 * D-187: правка полів картки — АКУРАТНА кнопка в картці + СПРАВЖНЯ модалка.
 *
 * Поручення власника 2026-11-11 (після D-186): «Не повинно бути в пошуковику
 * кострубатих оцих речей. Юзер у пошуковику знаходить свій файл — відкриває
 * його як звичайно — і в нього є акуратна одноразова кнопка "редагувати поля
 * картки файлу" — жмакає її — бачить як вона заповнена — редагує і зберігає
 * або не зберігає».
 *
 * Що було зламано (живий дефект, не косметика):
 *   1. `CardEditDialog` вішав розмітку на класи `.modal-overlay` /
 *      `.modal-content`, яких у `index.html` НЕ ІСНУЄ. Без `position: fixed`
 *      форма ставала звичайним блоком у кінці `<body>`: «простирадло» інпутів
 *      приклеювалось до низу сторінки замість модального вікна;
 *   2. кнопки власника («📎 Додати медіа», «Редагувати») стояли в ОДНОМУ ряду
 *      з «Скачати» (`width:100%`), тому стискались у вузькі стовпчики й текст
 *      переносився по літерах; у кабінеті таких кнопок п'ять в одній строці;
 *   3. підпис «Редагувати» не казав, ЩО саме редагується (поля картки).
 *
 * Гейти нижче тримають саме ці три інваріанти. Вони по ІСХОДНИКАХ (як
 * `focus-card-full.test.ts` / `tabs-overflow.test.ts`): DOM-клас сторінки без
 * тестового стенда, а розсинхронізація тут — саме «сира» розмітка й CSS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Корінь `desktop-electron` (від `outDir` → `tmp-tests/tests` вгору). */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не знайшли корінь desktop-electron (package.json + src/)");
    dir = parent;
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), "src", rel), "utf8");
}

function readRoot(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

function readLocale(lang: "uk" | "ru" | "en"): string {
  return readSrc(`i18n/locales/${lang}.ts`);
}

/** Тіло CSS-правила за селектором (для перевірки конкретних властивостей). */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `у index.html немає CSS-правила ${selector}`);
  return match![1];
}


test("M1: форма правки — модалка ТЕМИ, а не «сирий» блок у низу сторінки", () => {
  const html = readRoot("index.html");

  const overlay = cssBlock(html, ".card-edit-overlay");
  assert.match(overlay, /position:\s*fixed/, "без position: fixed форма стає блоком у кінці <body>");
  assert.match(overlay, /inset:\s*0/, "оверлей має закривати вікно цілком");
  assert.match(cssBlock(html, ".card-edit-dialog"), /background:/, "діалог має фон теми, а не прозорий блок");
  assert.match(cssBlock(html, ".card-edit-fields"), /overflow-y:\s*auto/, "поля скролляться всередині модалки");
  assert.match(cssBlock(html, ".card-edit-input"), /border-radius:/, "інпути — у стилі теми, не «сирі»");

  const dialog = readSrc("ui/CardEditDialog.ts");
  assert.doesNotMatch(
    dialog,
    /modal-overlay|modal-content/,
    "класів .modal-overlay/.modal-content у CSS НЕМАЄ — форма приклеювалась до низу сторінки",
  );
  assert.match(dialog, /className = "card-edit-overlay"/);
  assert.match(dialog, /class="card-edit-dialog"/, "розмітка діалогу — на класах теми");
  assert.match(dialog, /class="card-edit-fields"/, "поля — у власному контейнері (скрол)");
  assert.match(dialog, /class="card-edit-actions"/, "кнопки Зберегти/Скасувати — окремим рядом");
});

test("M2: форму закриває Esc, хрестик і клік по фону (модалка поводиться як модалка)", () => {
  const dialog = readSrc("ui/CardEditDialog.ts");
  assert.match(dialog, /addEventListener\("keydown"/, "немає обробника клавіатури");
  assert.match(dialog, /Escape/, "Esc не закриває форму");
  assert.match(dialog, /removeEventListener\("keydown"/, "обробник Esc знімається разом з формою (інакше тече)");
  assert.match(dialog, /event\.target === overlay/, "клік по фону не закриває форму");
  assert.match(dialog, /data-act="close"/, "немає хрестика закриття");
  assert.match(dialog, /aria-modal="true"/, "модалка без aria — скрін-рідер читає сторінку під нею");
});

test("M3: кнопка правки живе у власному ряду інструментів, а не в ряду «Скачати»", () => {
  const html = readRoot("index.html");
  const toolsRow = cssBlock(html, ".card-tools-row");
  assert.match(toolsRow, /display:\s*flex/, "ряд інструментів — flex");
  assert.match(toolsRow, /flex-wrap:\s*wrap/, "без переносу кнопки стискаються в стовпчики (живий дефект)");

  const page = readSrc("ui/SearchPage.ts");
  assert.match(page, /private _cardToolsRowHtml\(/, "немає єдиного рендерера ряду інструментів");
  // Кнопка власника рендериться РІВНО в одному місці: визначення + виклик
  // усередині `_cardToolsRowHtml`. Друга копія = знову «сира» кнопка в ряді
  // скачування (саме так і сталось у D-186).
  const uses = page.split("_addEditButtonHtml(").length - 1;
  assert.equal(uses, 2, "кнопка правки має бути лише в `_cardToolsRowHtml` (1 визначення + 1 виклик)");
  assert.match(
    page,
    /_isOwnPublicCard\(item\) \? this\._cardToolsRowHtml\("file", item\.id\)/,
    "кнопки власника показуються лише на СВОЇЙ публічній картці",
  );
  assert.match(
    page,
    /this\._cardToolsRowHtml\(\s*"personal",\s*item\.id/,
    "у кабінеті ряд інструментів теж окремий",
  );

});

test("M4: підпис кнопки каже, ЩО редагується — поля картки (uk/ru/en)", () => {
  const expectations: Array<["uk" | "ru" | "en", RegExp]> = [
    ["uk", /btn:\s*"[^"]*Редагувати поля картки"/],
    ["ru", /btn:\s*"[^"]*Редактировать поля карточки"/],
    ["en", /btn:\s*"[^"]*[Ee]dit card fields"/],
  ];
  for (const [lang, re] of expectations) {
    const locale = readLocale(lang);
    assert.match(locale, re, `у ${lang} підпис кнопки не згадує поля картки`);
  }
});

test("M5: після витраченої спроби кнопка гасне на місці (без перезапуску)", () => {
  const page = readSrc("ui/SearchPage.ts");
  assert.match(page, /_editUsedCards/, "немає памʼяті сесії про витрачену правку картки");
  assert.match(page, /cardEditButtonLabel\(true\)/, "кнопка не переходить у стан «використано»");
  assert.match(page, /\.disabled = true/, "кнопка не гасне після успішної правки");
  const dialog = readSrc("ui/CardEditDialog.ts");
  assert.match(dialog, /onUsed\?\(/, "діалог не повідомляє сторінку про витрачену спробу");
});
