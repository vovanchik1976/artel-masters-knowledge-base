/**
 * Гейт «свежий личный кабинет» (BUG-CABINET-STALE-001, 2026-11-11).
 *
 * Живой репорт владельца: файл загружен в личное хранилище («Снимок экрана
 * от 2026-11-10 22-48-53.png», personal #33), сервер его видит сразу (БД +
 * индекс `personal`), но в том же окне клиента во вкладке «Пошук» личного
 * кабинета файла НЕТ — он появляется только после перезапуска ARTEL.
 *
 * Причина: список кабинета — это ОДИН GET `/api/v1/search/personal`, результат
 * живёт в DOM до следующего действия пользователя. Ни завершение загрузки, ни
 * открытие вкладки «Пошук» список не перечитывали.
 *
 * Инварианты:
 *   1. перечитываем ТОЛЬКО личный режим (публичный каталог не трогаем — A3);
 *   2. перечитываем ТОЛЬКО «устаревший» список (иначе каждое открытие вкладки
 *      перерисовывало бы список и сбрасывало закреплённую карточку из чата);
 *   3. успешная личная загрузка помечает список устаревшим;
 *   4. пользователя НЕ уводим с вкладки «Завантажити» (решение владельца:
 *      там живёт инструмент медиа карточки) — обновление делает вкладка «Пошук».
 *
 * Гейт по ИСХОДНИКАМ (DOM в node:test нет) + чистые функции решения.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { shouldRefreshCabinet } from "../src/ui/CabinetRefresh";

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

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/**
 * Тело метода класса: от `signature` до закрывающей скобки метода.
 *
 * Режем по `\n  }` (2 пробела — уровень членов класса), иначе окно фиксированной
 * длины залезает в соседние методы и гейт начинает проверять чужой код.
 */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `не нашли ${signature}`);
  const end = src.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `не нашли конец метода ${signature}`);
  return src.slice(start, end + "\n  }".length);
}

// ── Чистое решение: когда перечитывать список ────────────────────────────────

test("R1: личная загрузка → открытие «Пошук» перечитывает список кабинета", () => {
  assert.equal(
    shouldRefreshCabinet({ scope: "personal", tab: "search", stale: true }),
    true,
  );
});

test("R2: список не помечен устаревшим → лишних запросов нет", () => {
  assert.equal(
    shouldRefreshCabinet({ scope: "personal", tab: "search", stale: false }),
    false,
  );
});

test("R3: публичное поле — список кабинета не трогаем (A3, дерево каталога)", () => {
  assert.equal(
    shouldRefreshCabinet({ scope: "public", tab: "search", stale: true }),
    false,
  );
});

test("R4: другая вкладка (Завантажити/Магазин/…) → обновления нет", () => {
  assert.equal(
    shouldRefreshCabinet({ scope: "personal", tab: "upload", stale: true }),
    false,
  );
  assert.equal(
    shouldRefreshCabinet({ scope: "personal", tab: "", stale: true }),
    false,
  );
});

// ── Проводка в исходниках ───────────────────────────────────────────────────

test("R5: SearchPage умеет помечать и перечитывать список кабинета", () => {
  const src = read("src/ui/SearchPage.ts");
  assert.ok(
    src.includes("import { shouldRefreshCabinet }"),
    "SearchPage должен принимать решение через CabinetRefresh",
  );
  assert.ok(
    /markPersonalCabinetStale\s*\(/.test(src),
    "нет метода markPersonalCabinetStale() — загрузке нечем пометить список",
  );
  const body = methodBody(src, "async refreshPersonalCabinetIfStale");
  assert.ok(
    body.includes("shouldRefreshCabinet("),
    "refreshPersonalCabinetIfStale должен решать через shouldRefreshCabinet",
  );
  assert.ok(
    body.includes("refreshPersonalList("),
    "refreshPersonalCabinetIfStale должен перечитывать список (refreshPersonalList)",
  );
});

test("R6: App перечитывает кабинет при открытии вкладки «Пошук»", () => {
  const body = methodBody(read("src/ui/App.ts"), "private _onTabActivated");
  assert.ok(
    body.includes("refreshPersonalCabinetIfStale"),
    "App._onTabActivated не перечитывает список кабинета — файл останется невидимым",
  );
});

test("R7: App помечает кабинет устаревшим после загрузки, не уводя пользователя", () => {
  const src = read("src/ui/App.ts");
  const body = methodBody(src, "private onUploadComplete");
  assert.ok(
    body.includes("markPersonalCabinetStale("),
    "onUploadComplete должен помечать список кабинета устаревшим",
  );
  assert.ok(
    body.includes("refreshPersonalCabinetIfStale("),
    "onUploadComplete должен обновлять список, если кабинет открыт прямо сейчас",
  );
  assert.ok(
    !body.includes("_switchTab("),
    "нельзя уводить пользователя с вкладки «Завантажити» (там инструмент медиа карточки)",
  );
});

test("R8: UploadPage зовёт onUploadComplete на успешном /complete", () => {
  const src = read("src/ui/UploadPage.ts");
  const calls = src.match(/this\.onUploadComplete\(/g) ?? [];
  assert.ok(
    calls.length >= 1,
    "onUploadComplete объявлен, но никогда не вызывается — кабинет не узнаёт о загрузке",
  );
});

test("R9: фоновое обновление не крадёт фокус у скрытой вкладки", () => {
  const body = methodBody(read("src/ui/SearchPage.ts"), "private async doPersonalSearch");
  assert.ok(
    /focus\(\)/.test(body),
    "потеряли фокус на поле поиска после ручного поиска",
  );
  assert.ok(
    /_isSearchTabActive\(\)/.test(body),
    "фокус должен ставиться только когда вкладка «Пошук» реально открыта",
  );
});
