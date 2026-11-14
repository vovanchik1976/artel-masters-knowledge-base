#!/usr/bin/env node
/**
 * verify-renderer-assets — гейт «ассеты renderer'а резолвятся в собранном виде».
 *
 * ПОЧЕМУ ЭТОТ ГЕЙТ СУЩЕСТВУЕТ (BUG-ELECTRON-ASSET-001).
 * Релизный renderer открывается Electron'ом не через http, а через
 * `win.loadFile("…/dist-renderer/index.html")` — то есть по `file://`. В этом
 * режиме ЛЮБОЙ абсолютный путь («/btn-coins-3d.png») указывает в корень
 * файловой системы (на Windows — в корень диска `C:`), а не в каталог приложения,
 * и картинка молча не загружается. В dev-режиме (Vite-сервер на http) тот же
 * абсолютный путь работает — поэтому дефект виден ТОЛЬКО в сборке/e2e/релизе
 * (именно так пропали иконки в карточках магазина, вкладка «Магазин»).
 *
 * Дополнительная ловушка: Vite переписывает пути ассетов в статике `index.html`
 * (`/tab-shop-3d.png` → `./tab-shop-3d.png`) при сборке, но НЕ трогает строки
 * внутри runtime-шаблонов TypeScript (`src/ui/*.ts`). Поэтому абсолютный путь,
 * попавший в код, остаётся абсолютным и в бандле.
 *
 * Что проверяется:
 *   1. нет локальных ассетов с абсолютным путём (начинается с «/», но не «//»);
 *   2. каждая относительная ссылка на ассет реально существует в каталоге сборки.
 * Внешние URL (http/https/data/blob) игнорируются.
 *
 * Использование: node scripts/verify-renderer-assets.mjs [distDir=dist-renderer]
 * Коды выхода: 0 — чисто, 1 — найдены нарушения, 2 — каталог сборки не найден.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST_DIR = process.argv[2] ?? "dist-renderer";
const DIST = path.isAbsolute(DIST_DIR) ? DIST_DIR : path.join(ROOT, DIST_DIR);

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i;
const EXTERNAL = /^(https?:|data:|blob:|file:|\/\/|#)/i;

if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.error(`[renderer-assets] ❌ каталог сборки не найден: ${DIST}`);
  console.error("[renderer-assets]    сначала выполните: npm run build:renderer");
  process.exit(2);
}

/** Рекурсивно собрать файлы по расширениям. */
function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Вытащить локальные ссылки на ассеты из текста.
 * Покрывает: HTML-атрибуты src/href, CSS url(...), строковые литералы JS
 * (шаблоны вида `<img src="/btn-coins-3d.png">` после сборки — обычные строки).
 */
function extractRefs(text) {
  const refs = new Set();
  const patterns = [
    /(?:src|href)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    /url\(\s*["'`]?([^"'`)\s]+)["'`]?\s*\)/gi,
    /["'`]([^"'`\n]*\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf))["'`]/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const ref = (m[1] ?? "").trim();
      if (!ref || EXTERNAL.test(ref)) continue;
      if (!ASSET_EXT.test(ref.split(/[?#]/)[0])) continue;
      // Динамические шаблоны (`c${chatId}_thumb_${uid}.jpg`) — имена файлов,
      // которые собираются В РАНТАЙМЕ (медиа-кеш карточек, SP-15 срез 5):
      // статическим ассетом сборки они быть не могут. Абсолютные пути при этом
      // по-прежнему ловятся (проверка ниже), т.е. ловушка BUG-ELECTRON-ASSET-001 цела.
      if (ref.includes("${") && !ref.startsWith("/")) continue;
      refs.add(ref);
    }
  }
  return refs;
}

const files = [...new Set([path.join(DIST, "index.html"), ...walk(DIST, [".html", ".css", ".js", ".mjs"])])];
const absoluteRefs = [];
const missingRefs = [];
let checked = 0;

for (const file of files) {
  if (!existsSync(file)) continue;
  const rel = path.relative(DIST, file);
  for (const ref of extractRefs(readFileSync(file, "utf8"))) {
    checked += 1;
    const clean = ref.split(/[?#]/)[0];
    if (clean.startsWith("/")) {
      absoluteRefs.push({ file: rel, ref });
      continue;
    }
    const target = path.resolve(DIST, clean);
    if (!target.startsWith(DIST) || !existsSync(target)) {
      missingRefs.push({ file: rel, ref });
    }
  }
}

// Итог
console.log(`[renderer-assets] проверено ссылок на ассеты: ${checked}`);
console.log(`[renderer-assets] файлов просканировано: ${files.filter(existsSync).length}`);

if (absoluteRefs.length) {
  console.error("\n[renderer-assets] ❌ абсолютные пути к ассетам — в собранном renderer (file://) они не резолвятся:");
  for (const { file, ref } of absoluteRefs) {
    console.error(`  • ${ref}  (в ${file}) — используйте относительный путь, напр. "./${ref.replace(/^\/+/, "")}"`);
  }
}
if (missingRefs.length) {
  console.error("\n[renderer-assets] ❌ ссылки на несуществующие файлы в каталоге сборки:");
  for (const { file, ref } of missingRefs) console.error(`  • ${ref}  (в ${file})`);
}

if (absoluteRefs.length || missingRefs.length) {
  console.error(
    `\n[renderer-assets] ❌ ПРОВАЛ: абсолютных путей — ${absoluteRefs.length}, отсутствующих файлов — ${missingRefs.length}`,
  );
  process.exit(1);
}

console.log("[renderer-assets] ✅ все локальные ассеты renderer'а относительные и присутствуют в сборке");
