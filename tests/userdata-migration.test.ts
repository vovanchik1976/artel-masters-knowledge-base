/**
 * Миграция userData FW CLOUD → ARTEL (SP-01 K5, гейт по ИСХОДНИКУ).
 *
 * Инвариант критичен: поле userData определяет КАТАЛОГ СОСТОЯНИЯ TDLib
 * (одна сессия на каталог) и все пути логов/auth.json. main-процесс Electron
 * в `node:test` не запускается — `app`/`setPath` существуют только в рантайме
 * Electron, поэтому гейт текстовый: проверяем наличие чистой функции
 * `resolveUserDataDir()` с мокаемым FS и её вызов ДО логов/sidecar в
 * `app.whenReady()`.
 *
 * RED (до фикса): ни resolveUserDataDir, ни setPath("userData") в main.ts нет —
 * новый ARTEL-билд стартует с пустым каталогом, старая сессия/TDLib-состояние
 * остаются в `%APPDATA%\FW CLOUD` (пользователь «разлогинен»).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Исходник main-процесса: поднимаемся до корня проекта (там `electron/main.ts`),
 *  чтобы гейт не зависел от `outDir` компиляции тестов (`tmp-tests/tests`). */
function mainSourcePath(): string {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, "electron", "main.ts");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`electron/main.ts не найден (старт поиска: ${__dirname})`);
    }
    dir = parent;
  }
}

function mainSource(): string {
  return fs.readFileSync(mainSourcePath(), "utf8");
}

/** Извлекает тело функции resolveUserDataDir и исполняет её с моками FS.
 *  TS-аннотации исходника стираем простой заменой `: <type>` → `` (сигнатура
 *  известна и фиксирована, тест проверяет поведение, а не типы — типы ловит
 *  `tsc -p tsconfig.electron.json` при сборке). */
function loadResolveUserDataDir(): (
  opts: {
    appDataDir: string;
    exists: (p: string) => boolean;
    rename: (o: string, n: string) => void;
    writeMarker: (d: string) => void;
    warn: (m: string) => void;
  },
) => string {
  const src = mainSource();
  const start = src.indexOf("function resolveUserDataDir(");
  assert.ok(start >= 0, "в main.ts нет function resolveUserDataDir — миграция K5 не реализована");
  // Шапка многострочная (типы с `{...}` внутри), поэтому якоримся на конец
  // сигнатуры `}): string {`, а тело — балансом скобок ОТ НЕЁ.
  const sigMarker = "}): string {";
  const sigEnd = src.indexOf(sigMarker, start);
  assert.ok(sigEnd > start, "сигнатура resolveUserDataDir не распознана");
  const cleanHead = "function resolveUserDataDir(opts) {";
  let depth = 1; // открывающая `{` сигнатуры уже учтена
  let i = sigEnd + sigMarker.length;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, "скобки resolveUserDataDir не сбалансированы");
  const cleanSrc = cleanHead + src.slice(bodyStart, i) + "}";
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("path", `${cleanSrc}; return resolveUserDataDir;`);
  return factory(path) as ReturnType<typeof loadResolveUserDataDir>;
}

test("T6: старый каталог переименовывается, маркер создаётся", () => {
  const resolve = loadResolveUserDataDir();
  const calls: string[] = [];
  const renamed: Array<[string, string]> = [];
  const markers: string[] = [];
  const out = resolve({
    appDataDir: "/appdata",
    exists: (p) => p.endsWith("FW CLOUD"),
    rename: (o, n) => {
      renamed.push([o, n]);
    },
    writeMarker: (d) => {
      markers.push(d);
    },
    warn: (m) => calls.push(m),
  });
  assert.equal(out, path.join("/appdata", "ARTEL"));
  assert.deepEqual(renamed, [[path.join("/appdata", "FW CLOUD"), path.join("/appdata", "ARTEL")]]);
  assert.deepEqual(markers, [path.join("/appdata", "ARTEL")]);
  assert.deepEqual(calls, []);
});

test("T7: оба каталога — используется новый, старый нетронут, warning в лог", () => {
  const resolve = loadResolveUserDataDir();
  const warns: string[] = [];
  let renamed = 0;
  const out = resolve({
    appDataDir: "/appdata",
    exists: () => true,
    rename: () => {
      renamed++;
    },
    writeMarker: () => {},
    warn: (m) => warns.push(m),
  });
  assert.equal(out, path.join("/appdata", "ARTEL"));
  assert.equal(renamed, 0, "старый каталог обязаны не трогать");
  assert.equal(warns.length, 1, "конфликт каталогов обязан залогировать предупреждение");
});

test("миграция вызывается первой в app.whenReady().then (до логов/sidecar)", () => {
  const src = mainSource();
  const readyAt = src.indexOf("app.whenReady().then");
  assert.ok(readyAt >= 0, "нет app.whenReady().then в main.ts");
  const body = src.slice(readyAt, readyAt + 3000);
  const migAt = body.indexOf("migrateUserDataDir()");
  assert.ok(migAt >= 0, "migrateUserDataDir() не вызывается в app.whenReady()");
  const logAt = body.indexOf("setupTdlibLogPath()");
  assert.ok(logAt > migAt, "миграция обязана идти ДО настройки логов (иначе логи уйдут в старый каталог)");
  assert.ok(src.includes('app.setPath("userData"'), "нет app.setPath(userData) — каталог не переключается");
});
