/**
 * Гейт «темы оформления = стили, а не цвета» (запрос владельца 2026-10-31).
 *
 * ПРЕЖДЕ (RED): «тема» была двумя переменными — `--accent` и `--accent2`.
 * Фон, панели, рамки, радиусы, тени и шрифты оставались константами, а сам акцент
 * был зашит цифрами руками в 52 местах (`rgba(93,173,226,…)` ×37, `rgba(46,134,193,…)` ×15),
 * поэтому переключение выглядело как «сменился цвет подписей под иконками».
 *
 * ПОСЛЕ: тема — это ПРЕСЕТ: полный набор токенов (цвета + форма + глубина + шрифты)
 * плюс собственные структурные правила. Четыре пресета:
 *   artel  — тёмное «стекло» (текущий вид, база);
 *   paper  — светлая «мастерская»/сервис-мануал (папір, лінійки, шрифт із зарубками);
 *   photon — нативное окно ОС (сірі панелі, сегментовані вкладки, градієнтні кнопки);
 *   hud    — тёмный технический пульт (моно-шрифт, неон, нуль радіусів, кутові дужки).
 *
 * Гейт смешанный: поведение (`ThemePresets` — чистый модуль) + ИСХОДНИКИ CSS
 * (`index.html`, DOM в node:test нет).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { THEME_PRESETS, LEGACY_THEMES, normalizeTheme, themeAttrValue } from "../src/ui/ThemePresets";

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

/** Токены темы обязаны быть видны в любом пресете — иначе пресет «недорисован». */
const REQUIRED_TOKENS: ReadonlyArray<string> = [
  "--bg", "--surface", "--surface2", "--glass", "--glass-border",
  "--text", "--text-dim", "--accent", "--accent2", "--accent-rgb", "--ov-rgb",
  "--bg-image", "--header-bg", "--tabs-bg",
  "--r-card", "--r-tab", "--shadow-card", "--blur-card",
  "--font-head", "--font-mono", "--tab-case", "--tab-active-bg",
];

/** Различия, которые видны глазом: форма/глубина/шрифт/фон, а не только акцент. */
const STRUCTURAL_TOKENS: ReadonlyArray<string> = [
  "--r-card", "--r-tab", "--shadow-card", "--blur-card", "--font-head", "--font-mono",
  "--tab-case", "--tab-active-bg", "--bg", "--surface", "--glass", "--ov-rgb",
];

/**
 * Тело CSS-блока по селектору (`[data-theme="paper"] { … }`), с учётом вложенности.
 * Специально без регэкспов «до конца файла» — иначе гейт ловит соседние правила.
 */
function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `в index.html нет блока ${selector}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `у ${selector} нет открывающей скобки`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`блок ${selector} не закрыт — CSS сломан`);
}

/** Объявления `--token: value` внутри блока (значение — одна строка). */
function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  return out;
}

function presetTokens(selector: string): Map<string, string> {
  return tokens(cssBlock(html(), selector));
}

test("T1: четыре пресета; старые значения (forest/violet/amber) мягко уходят в artel", () => {
  assert.deepEqual([...THEME_PRESETS], ["artel", "paper", "photon", "hud"]);
  for (const preset of THEME_PRESETS) {
    assert.equal(normalizeTheme(preset), preset, `пресет ${preset} должен быть валидным`);
    assert.equal(themeAttrValue(preset), preset === "artel" ? "" : preset);
  }
  assert.equal(normalizeTheme(null), "artel", "пустое значение = artel");
  assert.equal(normalizeTheme(""), "artel", "пустая строка = artel");
  assert.equal(normalizeTheme("bogus"), "artel", "мусорное значение = artel (не падаем)");
  for (const legacy of Object.keys(LEGACY_THEMES)) {
    assert.equal(normalizeTheme(legacy), "artel", `старая тема ${legacy} должна перейти в artel без потери запуска`);
  }
});

test("T2: акцент не зашит цифрами — только через --accent-rgb/--accent2-rgb", () => {
  const source = html();
  const accent = source.match(/rgba\(93,\s*173,\s*226/gi) ?? [];
  const accent2 = source.match(/rgba\(46,\s*134,\s*193/gi) ?? [];
  assert.equal(accent.length, 0, `осталось ${accent.length} захардкоженных rgba(93,173,226,…) — тема снова перекрасит не всё`);
  assert.equal(accent2.length, 0, `осталось ${accent2.length} захардкоженных rgba(46,134,193,…)`);
  // Белые оверлеи на светлой теме становятся невидимыми → обязаны идти через --ov-rgb.
  const whiteOverlays = source.match(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.\d+\s*\)/g) ?? [];
  assert.equal(
    whiteOverlays.length,
    0,
    `осталось ${whiteOverlays.length} белых оверлеев rgba(255,255,255,…) — на светлой теме дадут «белым по белому»`,
  );
});

test("T3: у каждого пресета полный набор токенов (иначе стиль «недорисован»)", () => {
  const presets: ReadonlyArray<readonly [string, string]> = [
    ["artel", ":root {"],
    ["paper", '[data-theme="paper"] {'],
    ["photon", '[data-theme="photon"] {'],
    ["hud", '[data-theme="hud"] {'],
  ];
  for (const [name, selector] of presets) {
    const map = presetTokens(selector);
    const missing = REQUIRED_TOKENS.filter(key => !map.has(key));
    assert.deepEqual(missing, [], `пресет ${name}: нет токенов ${missing.join(", ")}`);
  }
});

test("T4: пресеты отличаются ФОРМОЙ/глубиной/шрифтом, а не только цветом акцента", () => {
  const base = presetTokens(":root {");
  const others: ReadonlyArray<readonly [string, string]> = [
    ["paper", '[data-theme="paper"] {'],
    ["photon", '[data-theme="photon"] {'],
    ["hud", '[data-theme="hud"] {'],
  ];
  for (const [name, selector] of others) {
    const map = presetTokens(selector);
    const changed = STRUCTURAL_TOKENS.filter(key => map.get(key) !== base.get(key));
    assert.ok(
      changed.length >= 5,
      `пресет ${name} отличается от artel только цветом (изменено ${changed.length} из ${STRUCTURAL_TOKENS.length})`,
    );
  }
});

test("T5: у каждого пресета есть собственные структурные правила (вкладки/карточки/шапка)", () => {
  const source = html();
  for (const preset of ["paper", "photon", "hud"]) {
    const rules = source.match(new RegExp(`\\[data-theme="${preset}"\\]\\s+\\.[A-Za-z]`, "g")) ?? [];
    assert.ok(rules.length >= 3, `пресет ${preset}: найдено ${rules.length} структурных правил, нужно ≥3`);
  }
});

test("T6: первый кадр не мигает — inline-бутстрап знает все пресеты и старые значения", () => {
  const source = html();
  const tail = source.slice(0, source.indexOf("</head>"));
  const boot = tail.slice(Math.max(0, tail.lastIndexOf("fw_theme") - 400));
  for (const preset of [...THEME_PRESETS, ...Object.keys(LEGACY_THEMES)]) {
    assert.ok(boot.includes(`'${preset}'`), `бутстрап темы не знает '${preset}' — будет вспышка другого стиля`);
  }
});

test("T7: подписи пресетов есть во всех трёх языках", () => {
  for (const lang of ["uk", "ru", "en"]) {
    const file = path.join(projectRoot(), "src", "i18n", "locales", `${lang}.ts`);
    const text = fs.readFileSync(file, "utf8");
    for (const preset of THEME_PRESETS) {
      assert.ok(new RegExp(`theme_${preset}\\s*:`).test(text), `${lang}.ts: нет подписи theme_${preset}`);
    }
  }
});

test("T8: самопроверка — гейт распознал реальные блоки (не мёртвый тест)", () => {
  const paper = presetTokens('[data-theme="paper"] {');
  assert.ok(paper.size >= REQUIRED_TOKENS.length, `распознано подозрительно мало токенов paper: ${paper.size}`);
  assert.ok(/serif|Georgia/i.test(paper.get("--font-head") ?? ""), "paper обязан менять шрифт заголовков (сервис-мануал)");
  const hud = presetTokens('[data-theme="hud"] {');
  assert.ok(/mono|Consolas/i.test(hud.get("--font-mono") ?? ""), "hud обязан включать моно-шрифт");
  assert.ok(/^(0|1px|2px)/.test((hud.get("--r-card") ?? "").trim()), "hud — почти нулевые радиусы");
});
