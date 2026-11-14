/**
 * Диагностика «код не приходит»: каталог и имена файлов логов
 * (BUG-AUTH-CODE-002, 2026-10-13).
 *
 * RED (test-first): сторож `startPhoneAuthWatchdog` (30 с молчания TDLib)
 * отправлял пользователя в `%LOCALAPPDATA%\firmware-desktop-client\logs` и
 * просил прислать `auth_debug.log`, `tdlib_trace.log`, `tdlib_diag.log`,
 * `tdlib_cpp.log` — каталог и имена остались от снесённой Tauri-линии
 * (`desktop/`, вынесена в `firmware-tauri-desktop`). Реальный лог
 * Electron-порта ОДИН: `<userData>/logs/tdlib.log`, где `userData` =
 * `%APPDATA%\ARTEL` (Windows) / `~/.config/ARTEL` (Linux) —
 * [`electron/main.ts`](../electron/main.ts) `clientLogDir()` →
 * `app.getPath("userData")/logs`, туда же смотрит `FW_TDLIB_LOG_PATH`.
 *
 * Почему это дефект, а не косметика: живой инцидент «код авторизации не
 * приходит в ТГ» невозможно разобрать без `tdlib.log` (там виден ответ
 * Telegram: `PHONE_CODE_FLOOD`, `connectionState`, `sentCodeType`). Подсказка
 * вела в несуществующий каталог и к несуществующим файлам — RCA упирался в
 * «логов нет».
 *
 * Контракт после фикса:
 *   1) UI НЕ хардкодит каталог — берёт его из main через
 *      `invoke("engine.sidecarStatus")` → `log_dir` (единственный источник
 *      правды, тот же, что настраивает `FW_TDLIB_LOG_PATH`);
 *   2) сообщение пользователю называет РЕАЛЬНЫЕ файлы (`tdlib.log`,
 *      `main-sidecar.log`, `engine-core.log`) — см. `src/ui/AuthDiag.ts`;
 *   3) ни в одном словаре i18n нет фантомных имён Tauri-эпохи.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AUTH_DIAG_FILES,
  authDiagFilesList,
  buildNoCodeDiagnostics,
  type AuthDiagTranslate,
} from "../src/ui/AuthDiag";

/** Корень desktop-electron: поднимаемся от `tmp-tests/tests` до каталога с `electron/main.ts`. */
function projectFile(rel: string): string {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`${rel} не найден (старт поиска: ${__dirname})`);
    }
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(projectFile(rel), "utf8");
}

/**
 * Код без комментариев: гейты про пути/имена проверяют РАНТАЙМ-строки, а
 * доккомментарии обязаны иметь право объяснять историю дефекта (иначе справка
 * «раньше тут был фантомный путь» сама становится нарушением).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Исходник без комментариев (для гейтов по коду). */
function readCode(rel: string): string {
  return stripComments(read(rel));
}

/** Имена/каталоги Tauri-эпохи: в Electron-порте их не существует. */
const PHANTOM_LOG_MARKERS = [
  "firmware-desktop-client",
  "auth_debug.log",
  "tdlib_trace.log",
  "tdlib_diag.log",
  "tdlib_cpp.log",
];

test("TdlibAuthPage не отправляет пользователя в несуществующий каталог логов", () => {
  const src = readCode(path.join("src", "ui", "TdlibAuthPage.ts"));
  for (const marker of PHANTOM_LOG_MARKERS) {
    assert.ok(
      !src.includes(marker),
      `в TdlibAuthPage.ts остался фантомный маркер «${marker}» — подсказка ведёт в никуда`,
    );
  }
  assert.ok(
    !src.includes("%LOCALAPPDATA%"),
    "каталог логов нельзя хардкодить в UI (%LOCALAPPDATA%): реальный путь даёт main",
  );
});

test("каталог логов берётся из main через engine.sidecarStatus", () => {
  const src = readCode(path.join("src", "ui", "TdlibAuthPage.ts"));
  assert.ok(
    src.includes("engine.sidecarStatus"),
    "TdlibAuthPage обязан запросить каталог логов у main (invoke(\"engine.sidecarStatus\"))",
  );
  assert.ok(
    /log_dir/.test(src),
    "из ответа engine.sidecarStatus нужно читать поле log_dir (его отдаёт sidecarDiagnostics)",
  );
});

test("main строит каталог логов от app.getPath(\"userData\")", () => {
  const src = read(path.join("electron", "main.ts"));
  const fn = /function clientLogDir\(\)[^]*?\n\}/.exec(src);
  assert.ok(fn, "в main.ts нет clientLogDir() — источника правды для каталога логов");
  assert.ok(
    fn![0].includes('app.getPath("userData")'),
    "clientLogDir обязан строиться от app.getPath(\"userData\") (иначе разъедется с TDLib) и он же отдаётся как log_dir",
  );
});

test("i18n-подсказка называет реальные файлы логов и не содержит фантомных", () => {
  const locales = ["uk", "ru", "en"];
  for (const lang of locales) {
    const src = read(path.join("src", "i18n", "locales", `${lang}.ts`));
    const diagSend = /diag_send:\s*"([^"]*)"/.exec(src)?.[1] ?? "";
    assert.ok(diagSend.length > 0, `${lang}.ts: нет текста auth.diag_send`);
    for (const marker of PHANTOM_LOG_MARKERS) {
      assert.ok(
        !diagSend.includes(marker),
        `${lang}.ts: auth.diag_send по-прежнему просит фантомный файл «${marker}»`,
      );
    }
    assert.match(
      diagSend,
      /tdlib\.log/,
      `${lang}.ts: auth.diag_send обязан называть реальный файл tdlib.log`,
    );
    assert.match(
      diagSend,
      /auth-flow\.log/,
      `${lang}.ts: auth.diag_send обязан называть stage-level auth-flow.log`,
    );
  }
});

test("buildNoCodeDiagnostics подставляет каталог из main", () => {
  const seen: Array<{ key: string; params?: Record<string, string> }> = [];
  const fakeT: AuthDiagTranslate = (key, params) => {
    seen.push({ key, params });
    if (key === "auth.diag_logs") return `logs@${params?.dir}`;
    if (key === "auth.diag_net_state") return `net=${params?.state}`;
    return key;
  };

  const dir = "C:\\Users\\u\\AppData\\Roaming\\ARTEL\\logs";
  const msg = buildNoCodeDiagnostics({
    logDir: dir,
    connectionState: "connectionStateWaitingForNetwork",
    t: fakeT,
  });

  assert.ok(msg.includes(dir), "в подсказке обязан быть каталог, отданный main (log_dir)");
  assert.ok(
    msg.includes("connectionStateWaitingForNetwork"),
    "состояние сети обязано попадать в подсказку (сеть vs доставка кода)",
  );
  assert.deepEqual(
    seen.map((c) => c.key),
    ["auth.diag_no_code", "auth.diag_net_state", "auth.diag_logs", "auth.diag_send"],
    "порядок частей подсказки фиксирован: сначала «кода нет», потом сеть, потом логи",
  );
});

test("без ответа main путь НЕ выдумывается", () => {
  const seen: string[] = [];
  const fakeT: AuthDiagTranslate = (key) => {
    seen.push(key);
    return key;
  };

  const msg = buildNoCodeDiagnostics({ logDir: null, connectionState: null, t: fakeT });

  assert.ok(!seen.includes("auth.diag_logs"), "без log_dir нельзя показывать каталог");
  assert.ok(!seen.includes("auth.diag_send"), "без каталога просить файлы бессмысленно");
  assert.ok(!/\/(logs|firmware|AppData|LOCALAPPDATA)/i.test(msg), "в тексте не должно быть выдуманного пути");
  for (const marker of PHANTOM_LOG_MARKERS) {
    assert.ok(!msg.includes(marker), `в тексте не должно быть фантомного маркера «${marker}»`);
  }
});

/** Пути ОС в UI хардкодить нельзя: единственный источник — main (`log_dir`). */
const HARDCODED_OS_PATH_MARKERS = [
  "%APPDATA%",
  "%LOCALAPPDATA%",
  "AppData",
  "C:\\",
  "/home/",
  "~/.config",
  ".config/ARTEL",
  "/Users/",
];

test("UI не хардкодит ни Windows-, ни Linux-путь (путь отдаёт main)", () => {
  for (const rel of [path.join("src", "ui", "AuthDiag.ts"), path.join("src", "ui", "TdlibAuthPage.ts")]) {
    const src = readCode(rel);
    for (const marker of HARDCODED_OS_PATH_MARKERS) {
      assert.ok(
        !src.includes(marker),
        `${rel}: хардкод пути «${marker}» — путь обязан приходить из main (иначе на Linux-машине подсказка врёт)`,
      );
    }
  }
});

test("на Linux (эта машина) log_dir = FW_ELECTRON_LOG_DIR или userData/logs", () => {
  const src = read(path.join("electron", "main.ts"));
  const fn = /function clientLogDir\(\)[^]*?\n\}/.exec(src);
  assert.ok(fn, "в main.ts нет clientLogDir() — источника правды для каталога логов");
  const body = fn![0];
  assert.ok(
    body.includes("FW_ELECTRON_LOG_DIR"),
    "clientLogDir обязан чтить FW_ELECTRON_LOG_DIR: e2e-прогоны на Linux кладут логи в проект (desktop-electron/logs/e2e-prod*)",
  );
  assert.ok(
    /process\.platform\s*!==\s*"win32"/.test(body),
    "override FW_ELECTRON_LOG_DIR — только Linux-ветка (Win-путь не меняется)",
  );
  assert.ok(
    /log_dir:\s*clientLogDir\(\)/.test(src),
    "engine.sidecarStatus обязан отдавать log_dir = clientLogDir() — иначе подсказка UI разъедется с файлом TDLib",
  );
});

test("AUTH_DIAG_FILES перечисляет реальные файлы журналов", () => {
  assert.ok(
    (AUTH_DIAG_FILES as readonly string[]).includes("tdlib.log"),
    "главный файл разбора инцидента — tdlib.log",
  );
  assert.ok(
    (AUTH_DIAG_FILES as readonly string[]).includes("auth-flow.log"),
    "прямой MTP handoff пишет безопасную диагностику в auth-flow.log",
  );
  const list = authDiagFilesList();
  assert.ok(list.includes("auth-flow.log") && list.includes("tdlib.log") && list.includes("main-sidecar.log"));
  for (const marker of PHANTOM_LOG_MARKERS) {
    assert.ok(!list.includes(marker), `в списке файлов остался фантом «${marker}»`);
  }
});
