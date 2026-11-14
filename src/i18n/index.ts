/**
 * Ядро i18n — самописний типізований модуль без зовнішніх залежностей.
 *
 * API:
 *   t(key, params?)          — типізований переклад + підстановка {name} + plural
 *   setLang(lang) / getLang()— зміна/читання мови (+ persist у localStorage)
 *   detectLang()             — navigator.language → uk/ru/en, інакше uk
 *   plural(n, forms)         — Intl.PluralRules
 *   applyStaticI18n()        — один прохід по [data-i18n] / [data-i18n-placeholder]
 *   subscribe(fn)            — підписка на зміну мови (перемикання на льоту)
 *   hasKey(key) / tLoose(...)— runtime-доступ (для динамічних ключів схеми форми)
 *
 * Fallback: відсутній ключ → uk.
 * Плюральні форми: {n, plural, one: "...", few: "...", many: "...", other: "..."}
 */

import { uk } from "./locales/uk";
import { ru } from "./locales/ru";
import { en } from "./locales/en";

export type Lang = "uk" | "ru" | "en";
export type Dict = typeof uk;
export type Params = Record<string, string | number>;

/** Рекурсивний тип шляху ключа: "header.connected", "search.found", ... */
type NestedKeyOf<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${NestedKeyOf<T[K]>}`;
}[keyof T & string];

export type Key = NestedKeyOf<Dict>;

const STORAGE_KEY = "fw_lang";
const LANGS: Lang[] = ["uk", "ru", "en"];

const dictionaries: Record<Lang, Dict> = { uk, ru, en };

let currentLang: Lang = "uk";
const listeners = new Set<(lang: Lang) => void>();

// ── init: локальний storage або авто-визначення ─────────────────────────────
(function init(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "uk" || stored === "ru" || stored === "en") {
      currentLang = stored;
    } else {
      currentLang = detectLang();
      localStorage.setItem(STORAGE_KEY, currentLang);
    }
  } catch {
    currentLang = detectLang();
  }
})();

/** Визначити мову з navigator.language → uk/ru/en, інакше uk. */
export function detectLang(): Lang {
  try {
    const tag = (navigator.language || "").toLowerCase();
    if (tag.startsWith("ru")) return "ru";
    if (tag.startsWith("en")) return "en";
    if (tag.startsWith("uk")) return "uk";
  } catch {
    /* ignore */
  }
  return "uk";
}

/** Встановити мову + persist + застосувати статику + сповістити підписників. */
export function setLang(lang: Lang): void {
  if (lang !== currentLang) {
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }
  applyStaticI18n();
  listeners.forEach((fn) => {
    try {
      fn(currentLang);
    } catch {
      /* ignore */
    }
  });
}

export function getLang(): Lang {
  return currentLang;
}

/** Категорія множини за Intl.PluralRules (one/few/many/other). */
export function pluralCategory(n: number, lang: Lang = currentLang): string {
  try {
    const pr = new Intl.PluralRules(lang);
    return pr.select(Number.isFinite(n) ? n : NaN);
  } catch {
    return n === 1 ? "one" : "other";
  }
}

/** Хелпер множини: plural(2, ["файл", "файли", "файлів", "файлів"]) */
export function plural(n: number, forms: [string, string, string, string]): string {
  const rule = pluralCategory(n);
  switch (rule) {
    case "one":
      return forms[0];
    case "few":
      return forms[1];
    case "many":
      return forms[2];
    default:
      return forms[3];
  }
}

/**
 * Розбір тіла plural-блоку (починаючи з індексу після "plural,").
 * Враховує вкладені {n} у значеннях форм та лапки.
 * Повертає { end: індекс після закриваючої }, forms } або null (незавершений).
 */
function parsePluralBlock(
  template: string,
  start: number,
): { end: number; forms: Record<string, string> } | null {
  const forms: Record<string, string> = {};
  let i = start;
  let depth = 0;
  let curKey: string | null = null;
  let keyBuf = "";
  let valBuf: string[] = [];
  let inKey = true;
  let quote: string | null = null;

  const commitForm = (): void => {
    if (curKey) forms[curKey] = valBuf.join("").trim();
    curKey = null;
    valBuf = [];
    inKey = true;
  };

  while (i < template.length) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) quote = null;
      else valBuf.push(ch);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inKey = false;
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      if (!inKey) valBuf.push(ch);
      i++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) {
        commitForm();
        return { end: i + 1, forms };
      }
      depth--;
      if (!inKey) valBuf.push(ch);
      i++;
      continue;
    }
    if (ch === ":" && inKey) {
      curKey = keyBuf.trim();
      keyBuf = "";
      inKey = false;
      i++;
      continue;
    }
    if (ch === "," && !inKey && depth === 0) {
      commitForm();
      i++;
      continue;
    }
    if (inKey) keyBuf += ch;
    else valBuf.push(ch);
    i++;
  }
  return null; // незавершений блок
}

/**
 * Рендер шаблону: спочатку plural-блоки (рекурсивно), потім проста підстановка {name}.
 * ВАЖЛИВО: regex створюється локально на кожен виклик — рекурсія не ділить спільний
 * lastIndex (інакше зовнішній цикл exec зациклюється).
 */
function renderPlurals(template: string, params: Params | undefined, lang: Lang): string {
  const startRe = /\{(\w+),\s*plural,\s*/g;
  let out = "";
  let last = 0;
  for (const m of template.matchAll(startRe)) {
    const idx = m.index;
    out += template.slice(last, idx);
    const key = m[1];
    const parsed = parsePluralBlock(template, idx + m[0].length);
    if (!parsed) {
      out += template.slice(idx);
      last = template.length;
      break;
    }
    const n = Number(params?.[key]);
    const rule = pluralCategory(n, lang);
    const forms = parsed.forms;
    const selected =
      forms[rule] ?? forms.other ?? forms.many ?? forms.few ?? forms.one ??
      template.slice(idx, parsed.end);
    out += renderPlurals(selected, params, lang);
    last = parsed.end;
  }
  out += template.slice(last);
  return out;
}

/** Рендер шаблону: plural → підстановка {name}. */
function renderTemplate(template: string, params: Params | undefined, lang: Lang): string {
  const out = renderPlurals(template, params, lang);
  if (params) {
    return out.replace(/\{(\w+)\}/g, (match, key: string) => {
      const v = params[key];
      return v !== undefined ? String(v) : match;
    });
  }
  return out;
}

/** Runtime-доступ до вкладеного рядка словника (за шляхом "a.b.c"). */
function getByPath(dict: Dict, path: string): string | undefined {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Чи існує ключ у словниках (uk є еталоном). */
export function hasKey(key: string): boolean {
  return getByPath(uk, key) !== undefined;
}

/** Нетипізований переклад (для динамічних ключів, напр. схеми форми). */
export function tLoose(key: string, params?: Params): string {
  const dict = dictionaries[currentLang];
  const value = getByPath(dict, key) ?? getByPath(uk, key);
  if (value === undefined) return key;
  return renderTemplate(value, params, currentLang);
}

/** Типізований переклад. Неправильний ключ = TS-помилка. */
export function t(key: Key, params?: Params): string {
  return tLoose(key, params);
}

/** Один прохід по статиці: [data-i18n] → textContent, [data-i18n-placeholder] → placeholder. */
export function applyStaticI18n(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = tLoose(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (!key) return;
    const anyEl = el as unknown as HTMLInputElement;
    if (anyEl && typeof anyEl.placeholder === "string") {
      anyEl.placeholder = tLoose(key);
    }
  });
  // title-атрибут (тултипы): [data-i18n-title] → el.title
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = tLoose(key);
  });
}

/** Підписатися на зміну мови. Повертає функцію відписки. */
export function subscribe(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Прив'язати перемикач мови у header (.lang-btn[data-lang]) + синхронізація active-класу. */
export function bindLangSwitcher(): void {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".lang-btn[data-lang]"),
  );
  const sync = (): void => {
    buttons.forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === currentLang);
    });
  };
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      const l = b.dataset.lang as Lang;
      if (LANGS.includes(l)) setLang(l);
    });
  });
  subscribe(sync);
  sync();
}
