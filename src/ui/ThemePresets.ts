/**
 * Пресеты оформления Desktop-клиента (D-141, 2026-10-31).
 *
 * ПРЕЖДЕ тема была «цветом акцента»: менялись только `--accent`/`--accent2`,
 * а в 52 местах синий был зашит цифрами — смена темы почти не была видна.
 *
 * ТЕПЕРЬ тема — пресет оформления (цвет + форма + глубина + шрифты + собственные
 * структурные правила в index.html):
 *   `artel`  — тёмное «стекло» (базовый вид, атрибут `data-theme` не ставится);
 *   `paper`  — светлая «мастерская»: сервис-мануал, папір, лінійки, шрифт із зарубками;
 *   `photon` — нативное окно ОС: сірі панелі, сегментовані вкладки, градієнтні кнопки;
 *   `hud`    — тёмный технический пульт: моно-шрифт, неон, нуль радіусів.
 *
 * Модуль намеренно чистый (без DOM/localStorage) — его проверяет гейт
 * `tests/theme-presets.test.ts` в node:test.
 */

export const THEME_PRESETS = ["artel", "paper", "photon", "hud"] as const;

export type ThemePreset = (typeof THEME_PRESETS)[number];

/** Базовый пресет — он же вид «по умолчанию» (на нём атрибут не выставляется). */
export const DEFAULT_THEME: ThemePreset = "artel";

/**
 * Старые «цветовые» темы. Оставляем мягкую миграцию: у мастера в localStorage
 * может лежать `forest`/`violet`/`amber` — он не должен увидеть битый/пустой вид
 * и не должен ловить исключение. Все три уходим в базовый пресет.
 */
export const LEGACY_THEMES: Readonly<Record<string, ThemePreset>> = {
  forest: "artel",
  violet: "artel",
  amber: "artel",
};

/** Является ли значение одним из актуальных пресетов. */
export function isThemePreset(value: unknown): value is ThemePreset {
  return typeof value === "string" && (THEME_PRESETS as ReadonlyArray<string>).includes(value);
}

/** Любое «грязное» значение → валидный пресет (мусор и старое = базовый вид). */
export function normalizeTheme(raw: string | null | undefined): ThemePreset {
  if (typeof raw !== "string") return DEFAULT_THEME;
  const value = raw.trim();
  if (isThemePreset(value)) return value;
  return LEGACY_THEMES[value] ?? DEFAULT_THEME;
}

/**
 * Значение для `document.documentElement.dataset.theme`: у базового пресета —
 * пустая строка (атрибут снимается), у остальных — имя пресета.
 */
export function themeAttrValue(preset: ThemePreset): string {
  return preset === DEFAULT_THEME ? "" : preset;
}
