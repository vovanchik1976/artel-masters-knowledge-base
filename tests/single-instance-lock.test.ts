/**
 * Замок одного экземпляра (BUG-SINGLE-INSTANCE-001) — гейт по ИСХОДНИКУ
 * [`electron/main.ts`](../electron/main.ts).
 *
 * Почему гейт по тексту, а не поведенческий тест: main-процесс Electron в
 * `node:test` не запускается — `app`/`BrowserWindow` существуют только в
 * рантайме Electron. При этом инвариант критичен: две копии клиента делят ОДИН
 * `userData` (`%APPDATA%\ARTEL` / `~/.config/ARTEL`: `auth.json`, каталог
 * состояния TDLib, логи) и общие temp-каталоги (`firmware-desktop/`,
 * `tdlib_upload_parts/`) — вторая копия означала бы две TDLib-сессии на один
 * каталог состояния и взаимное затирание `auth.json`.
 *
 * RED (до фикса): в `main.ts` не было ни `requestSingleInstanceLock`, ни
 * `second-instance` — вторая копия стартовала как полноправный экземпляр.
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

test("main.ts берёт замок одного экземпляра ДО app.whenReady()", () => {
  const src = mainSource();
  const lockAt = src.indexOf("app.requestSingleInstanceLock()");
  assert.ok(
    lockAt >= 0,
    "в main.ts нет app.requestSingleInstanceLock() — вторая копия стартует свободно",
  );
  const readyAt = src.indexOf("app.whenReady(");
  assert.ok(
    readyAt > lockAt,
    "замок обязан браться РАНЬШЕ whenReady: иначе окно и TDLib-сессия уже подняты",
  );
});

test("отказ в замке завершает процесс НЕНУЛЕВЫМ кодом", () => {
  const src = mainSource();
  const varName = /const\s+(\w+)\s*(?::[^=]*)?=\s*app\.requestSingleInstanceLock\(\)/.exec(src)?.[1];
  assert.ok(varName, "результат requestSingleInstanceLock обязан сохраняться в переменную");
  const branch = new RegExp(`if \\(!${varName}\\)\\s*\\{([\\s\\S]*?)\\}`).exec(src);
  assert.ok(branch, `нет ветки \`if (!${varName})\` — отказ в замке не обработан`);
  const exitCall = /(?:process|app)\.exit\((\d+)\)/.exec(branch[1]);
  assert.ok(exitCall, "ветка отказа обязана завершать процесс (process.exit/app.exit)");
  assert.notEqual(
    Number(exitCall[1]),
    0,
    "код 0 дал бы «тихий успех» в харнессах (e2e-prod*.sh, smoke-release.sh запускают клиент и смотрят код)",
  );
});

test("второй запуск поднимает УЖЕ открытое окно (second-instance)", () => {
  const src = mainSource();
  const handlerAt = src.indexOf('app.on("second-instance"');
  assert.ok(
    handlerAt >= 0,
    "нет обработчика second-instance — у пользователя впечатление «программа не запустилась»",
  );
  const body = src.slice(handlerAt, handlerAt + 600);
  assert.match(body, /focus\(\)/, "открытое окно обязано получать фокус");
  assert.match(body, /(restore|show)\(\)/, "свёрнутое/скрытое окно обязано восстанавливаться");
});
