/**
 * Гейт панели вкладок (запросы владельца 2026-11-01 → 2026-11-04, D-170).
 *
 * 2026-11-01: контейнер на всю ширину окна (а не колонка 840px), бейдж
 * непрочитанных не растягивается, полное название вкладки — в тултипе.
 *
 * 2026-11-04 (D-170) владелец уточнил: «ширина иконок выбора действий
 * разная» → ширины вкладок должны быть РАВНЫМИ; «многоточие не устраивает» →
 * обрезки НЕТ; «перенос на вторую строку не современен» → переполнение —
 * ГОРИЗОНТАЛЬНЫЙ СКРОЛЛ (это осознанно отменяет запрет скролла от 2026-11-01).
 *
 * ПОСЛЕ:
 *   1) контейнер использует ширину окна (шире 1400px, боковые отступы текучие);
 *   2) все вкладки ОДНОЙ ширины `--tab-w`: максимум из «доля окна» и «самая
 *      широкая подпись» — меряет `TabLabels.layoutTabStrip` (чистая функция
 *      `equalTabWidth` покрыта юнит-тестами T8);
 *   3) подпись БЕЗ многоточия — полный текст виден всегда; если равные
 *      доли меньше самой широкой подписи, панель скроллится по горизонтали
 *      (тонкий скроллбар в стиле темы);
 *   4) подпись — отдельный класс `.tab-label` (бейдж непрочитанных не задет),
 *      полное название — в тултипе/`aria-label` (`syncTabTitles`);
 *   5) пересчёт ширин — при смене языка, темы, resize и после загрузки
 *      шрифтов (App.ts) — задел на будущее: новые вкладки/языки подхватываются
 *      автоматически, без правок CSS/JS.
 *
 * Гейт по ИСХОДНИКАМ (index.html + App.ts) + чистые функции `TabLabels`:
 * DOM в node:test нет, поэтому вёрстка проверяется по CSS-правилам.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  tabA11y,
  equalTabWidth,
  wheelScrollDelta,
  layoutTabStrip,
  enableTabStripWheelScroll,
} from "../src/ui/TabLabels";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function html(): string {
  return fs.readFileSync(path.join(projectRoot(), "index.html"), "utf8");
}

function readUi(name: string): string {
  return fs.readFileSync(path.join(projectRoot(), "src", "ui", name), "utf8");
}

function appTs(): string {
  return fs.readFileSync(path.join(projectRoot(), "src/ui/App.ts"), "utf8");
}

/** Тело CSS-правила по точному селектору (`null` = правила нет). */
function cssRule(source: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  return match ? match[1] : null;
}

function tabsHtml(): string {
  const source = html();
  const from = source.indexOf('<div class="tabs">');
  const to = source.indexOf("<!-- Upload Tab -->");
  assert.ok(from !== -1 && to > from, "не нашли блок .tabs в index.html");
  return source.slice(from, to);
}

test("T1: контейнер использует ширину окна, а не центрированную колонку 840px", () => {
  const rule = cssRule(html(), ".main");
  assert.ok(rule, "нет правила .main");
  const maxWidth = /max-width\s*:\s*([^;]+);/.exec(rule ?? "");
  assert.ok(maxWidth, "у .main нет max-width");
  const value = maxWidth[1].trim();
  if (value === "none" || value === "100%") return;
  const px = /^(\d+)px$/.exec(value);
  assert.ok(px, `непонятный max-width у .main: ${value}`);
  assert.ok(
    Number(px[1]) >= 1400,
    `.main всё ещё зажат в узкую колонку: max-width ${value} < 1400px (вкладки «в середине»)`,
  );
});

test("T2: переполнение панели — горизонтальный скролл с тонким скроллбаром (D-170)", () => {
  const rule = cssRule(html(), ".tabs");
  assert.ok(rule, "нет правила .tabs");
  // Решение владельца 2026-11-04: многоточие и перенос строк отклонены —
  // переполнение едет горизонтально (отменяет запрет скролла 2026-11-01).
  assert.match(rule ?? "", /overflow-x\s*:\s*auto/, ".tabs обязан скроллиться по горизонтали (D-170)");
  assert.match(rule ?? "", /overflow-y\s*:\s*hidden/, "вертикального скролла у панели быть не должно");
  assert.doesNotMatch(rule ?? "", /flex-wrap\s*:\s*wrap/, "перенос вкладок на вторую строку отклонён владельцем");
  assert.match(rule ?? "", /--tab-w\s*:/, "у .tabs должна быть дефолтная --tab-w до первого замера JS");
  // Скроллбар — тонкий и в стиле темы, а не системная полоса.
  assert.match(html(), /\.tabs::-webkit-scrollbar\s*\{/, "нет стилей тонкого скроллбара .tabs");
});

test("T3: все вкладки ОДНОЙ ширины --tab-w (D-170)", () => {
  const rule = cssRule(html(), ".tab");
  assert.ok(rule, "нет правила .tab");
  assert.match(
    rule ?? "",
    /flex\s*:\s*0\s+0\s+var\(--tab-w\)/,
    "у .tab должна быть фиксированная равная ширина flex: 0 0 var(--tab-w)",
  );
  assert.match(rule ?? "", /width\s*:\s*var\(--tab-w\)/, "у .tab должна быть width: var(--tab-w)");
  // Старая схема «basis = содержимое» давала разные ширины — запрещена.
  assert.doesNotMatch(rule ?? "", /flex\s*:\s*1\s+1\s+auto/, "flex: 1 1 auto вернулся — ширины снова разные");
  // Ширину считает JS по самой широкой подписи; логика — чистая функция.
  const labels = readUi("TabLabels.ts");
  assert.match(labels, /export function equalTabWidth\(/, "нет чистой функции equalTabWidth");
  assert.match(labels, /export function layoutTabStrip\(/, "нет DOM-раскладки layoutTabStrip");
  assert.match(labels, /createRange\(\)/, "замер подписи — через Range (точная ширина текста, обрезка не врёт)");
  assert.match(labels, /offsetParent !== null/, "скрытые вкладки (не-владельцу) не должны считать в N");
  assert.match(labels, /--tab-w/, "результат обязан ставиться в CSS-переменную --tab-w");
});

test("T4: подпись — отдельный .tab-label БЕЗ многоточия (D-170)", () => {
  const source = html();
  const rule = cssRule(source, ".tab-label");
  assert.ok(rule, "нет правила .tab-label — подпись должна стилизоваться своим классом");
  assert.match(rule ?? "", /white-space\s*:\s*nowrap/, ".tab-label: нужен white-space: nowrap");
  assert.match(rule ?? "", /overflow\s*:\s*hidden/, ".tab-label: нужен overflow: hidden (страховка до замера)");
  // Владелец 2026-11-04: «многоточие то же не устраивает» — обрезки «…» нет,
  // полные подписи гарантирует равная ширина по самой широкой из них.
  assert.doesNotMatch(rule ?? "", /text-overflow/, "text-overflow вернулся — владелец отклонил многоточие (D-170)");
  assert.equal(
    cssRule(source, ".tab span"),
    null,
    "нельзя стилизовать подпись через `.tab span`: под этот селектор попадает бейдж непрочитанных",
  );
});

test("T5: у каждой вкладки ровно одна подпись .tab-label", () => {
  const block = tabsHtml();
  const buttons = block.match(/<button class="tab[ "]/g) ?? [];
  const labels = block.match(/class="tab-label"/g) ?? [];
  assert.ok(buttons.length > 0, "в блоке .tabs не нашли кнопок вкладок");
  assert.equal(labels.length, buttons.length, `вкладок ${buttons.length}, подписей .tab-label ${labels.length}`);
  const unlabeled = block.match(/<span data-i18n="[^"]+"/g) ?? [];
  assert.deepEqual(unlabeled, [], "в панели вкладок есть подпись без класса tab-label");
});

test("T6: полные названия и равные ширины пересчитываются при смене языка/темы/resize/шрифтов", () => {
  const source = appTs();
  assert.match(source, /from "\.\/TabLabels"/, "App.ts должен импортировать TabLabels");
  assert.match(source, /layoutTabStrip/, "App.ts должен импортировать layoutTabStrip");
  // Подписи (тултип) — после локализации; равные ширины — сразу за ними.
  const applyIdx = source.indexOf("applyStaticI18n();");
  const syncIdx = source.indexOf("syncTabTitles();");
  // Первый вызов layoutTabStrip() живёт в конструкторе (стартовая раскладка);
  // для смены языка ищем вызов ПОСЛЕ syncTabTitles().
  const layoutIdx = source.indexOf("layoutTabStrip();", syncIdx);
  assert.ok(applyIdx !== -1 && syncIdx > applyIdx, "syncTabTitles() обязан идти ПОСЛЕ applyStaticI18n()");
  assert.ok(syncIdx !== -1 && layoutIdx > syncIdx, "layoutTabStrip() обязан идти ПОСЛЕ syncTabTitles()");
  assert.ok(
    source.indexOf("layoutTabStrip();") < syncIdx,
    "стартовая раскладка layoutTabStrip() в конструкторе потерялась",
  );
  // Задел на будущее: пересчёт на resize, после загрузки шрифтов и при смене
  // темы (letter-spacing тем отличается) — без правок вручную.
  assert.match(source, /addEventListener\("resize"/, "нет пересчёта ширин при resize");
  assert.match(source, /document\.fonts\.ready/, "нет пересчёта ширин после загрузки шрифтов");
  assert.match(source, /attributeFilter:\s*\["data-theme"\]/, "нет пересчёта ширин при смене темы");
});

test("T7: tabA11y нормализует подпись и отдаёт title + aria-label", () => {
  assert.deepEqual(tabA11y("  Архіватор  "), { title: "Архіватор", ariaLabel: "Архіватор" });
  assert.deepEqual(tabA11y("Налаштування\n\tмайстра"), {
    title: "Налаштування майстра",
    ariaLabel: "Налаштування майстра",
  });
  assert.equal(tabA11y("   "), null);
  assert.equal(tabA11y(null), null);
  assert.equal(tabA11y(undefined), null);
});

test("T8: equalTabWidth — доля окна против самой широкой подписи (D-170)", () => {
  // Влезают: равные доли = usable/N, панель занята ровно целиком.
  assert.equal(equalTabWidth(1000, 10, 10, 80), 91); // (1000-90)/10 = 91
  // Не влезают: каждой вкладке — минимум по самой широкой подписи,
  // панель уходит в горизонтальный скролл.
  assert.equal(equalTabWidth(500, 10, 10, 112), 112);
  // Граница: доля ровно равна минимуму.
  assert.equal(equalTabWidth(510, 10, 10, 42), 42); // (510-90)/10 = 42
  // Вырожденные входы — минимум, без NaN/отрицательных.
  assert.equal(equalTabWidth(0, 10, 10, 112), 112);
  assert.equal(equalTabWidth(-50, 10, 3, 112), 112);
  assert.equal(equalTabWidth(1000, 10, 0, 112), 112);
});

test("T9: layoutTabStrip терпит окружение без DOM (юнит-режим)", () => {
  assert.doesNotThrow(() => layoutTabStrip(null));
  assert.doesNotThrow(() => layoutTabStrip(undefined));
});

test("T10: колесо над панелью скроллит её горизонтально, без переполнения — не мешает странице (D-170)", () => {
  // Чистая логика: доминантная ось, перехват только при переполнении.
  assert.equal(wheelScrollDelta(0, 120, true), 120); // обычное колесо вниз
  assert.equal(wheelScrollDelta(0, -120, true), -120); // и вверх
  assert.equal(wheelScrollDelta(-100, 0, true), -100); // тачпад / Shift+колесо
  assert.equal(wheelScrollDelta(5, 120, true), 120); // доминирует вертикаль
  assert.equal(wheelScrollDelta(120, 5, true), 120); // доминирует горизонталь
  assert.equal(wheelScrollDelta(0, 120, false), null); // нет переполнения — страница скроллится сама
  assert.equal(wheelScrollDelta(0, 0, true), 0); // пустая дельта

  // Обработчик: passive:false (иначе preventDefault не работает и панель
  // скроллится вместе со страницей), мгновенный scrollLeft, идемпотентность.
  const labels = readUi("TabLabels.ts");
  assert.match(labels, /passive:\s*false/, "wheel-обработчик обязан быть не-passive");
  assert.match(labels, /event\.preventDefault\(\)/, "перехваченное колесо обязано гасить вертикальный скролл");
  assert.match(labels, /scrollLeft \+= delta/, "скролл панели — мгновенными инкрементами scrollLeft");
  assert.match(labels, /wheelScroll === "1"/, "обработчик обязан быть идемпотентным (гард по data-атрибуту)");
  assert.doesNotThrow(() => enableTabStripWheelScroll(null));

  // Подключение в App — один раз, в конструкторе.
  const app = appTs();
  assert.match(app, /enableTabStripWheelScroll\(\)/, "App.ts не подключает колесо панели вкладок");
  assert.equal((app.match(/enableTabStripWheelScroll\(\)/g) ?? []).length, 1, "enableTabStripWheelScroll() должен вызываться ровно один раз");

  // smooth-анимация в CSS запрещена: на частых дельтах колеса даёт лаг.
  assert.doesNotMatch(
    cssRule(html(), ".tabs") ?? "",
    /scroll-behavior\s*:\s*smooth/,
    "scroll-behavior: smooth вернулся в .tabs — колесо станет «резиновым»",
  );
});
