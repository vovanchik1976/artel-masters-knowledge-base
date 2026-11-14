/**
 * Гейт маршрутизации TDLib-команд через Electron-мост
 * (BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001, 2026-10-31).
 *
 * # Живой инцидент
 *
 * Владелец нажал «Выйти» на уже авторизованном клиенте и попробовал войти по
 * номеру. Экран входа показался, но движок ответил
 * `PHONE_AUTH_ALREADY_AUTHORIZED` — TDLib остался в `authorizationStateReady`.
 * Причина: `handle_tdlib_logout` в движке ЕСТЬ и корректен (`logOut` + restart
 * той же БД), но в `electron/main.ts` команды `tdlib_logout` не было в
 * switch — мост уходил в default и отдавал
 * `NOT_IMPLEMENTED: "tdlib_logout" …`. Заодно так же были мертвы
 * `tdlib_set_email` и `tdlib_check_email_code`: весь email-вход TDLib.
 *
 * # Инварианты
 *
 * 1. Любой `invoke("tdlib_*")` из renderer имеет `case "tdlib_*"` в мосту
 *    (иначе UI вызывает то, чего мост не знает).
 * 2. Мост не маршрутизирует команду, которой нет в dispatch движка
 *    (иначе мост обещает то, чего нет).
 *
 * Гейт по ИСХОДНИКАМ: Electron/движок не запускаются.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Корень `desktop-electron` — от `tmp-tests/tests` вверх по дереву. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `корень desktop-electron не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Все `.ts` из `src/` рекурсивно (renderer — единственный, кто зовёт мост). */
function rendererSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(path.join(projectRoot(), "src"));
  return out;
}

/**
 * TDLib-команды, которые renderer реально вызывает.
 *
 * Смотрим не только на «прямой» вызов (`invoke<string>("tdlib_x")`), но и на
 * весь текст аргументов после `invoke(` — иначе тернарник
 * `invoke(mode === "logout" ? "tdlib_logout" : "tdlib_reset_auth")` выпадал бы
 * из гейта (а именно эта команда и была мертва в мосту).
 */
function invokedCommands(): Set<string> {
  const found = new Set<string>();
  for (const file of rendererSources()) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\binvoke\s*[(<]/g)) {
      const args = text.slice(m.index ?? 0, (m.index ?? 0) + 240);
      for (const cmd of args.matchAll(/"(tdlib_[a-z0-9_]+)"/g)) found.add(cmd[1]);
    }
  }
  assert.ok(
    found.size >= 10,
    `подозрительно мало tdlib-вызовов в renderer (${found.size}) — сломался разбор invoke()`,
  );
  return found;
}

/** Команды, которые мост (`electron/main.ts`) маршрутизирует в sidecar. */
function bridgedCommands(): Set<string> {
  const text = read(path.join("electron", "main.ts"));
  const found = new Set<string>();
  for (const m of text.matchAll(/case\s+"(tdlib_[a-z0-9_]+)"/g)) found.add(m[1]);
  return found;
}

/**
 * Команды, которые движок (`engine-core/src/main.rs`) реально диспетчерит.
 *
 * Dispatch-таблица держит и одиночные arm'ы (`"tdlib_x" => handler()`), и
 * сцепки через `|` (`"a" | "b" | "c" => ...`), поэтому смотрим на оба вида —
 * иначе шесть сервисных команд выглядели бы «нереализованными».
 */
function engineCommands(): Set<string> {
  const text = read(path.join("engine-core", "src", "main.rs"));
  const found = new Set<string>();
  for (const m of text.matchAll(/"(tdlib_[a-z0-9_]+)"(?=\s*(?:\||=>))/g)) found.add(m[1]);
  return found;
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

test("мост маршрутизирует КАЖДУЮ tdlib-команду, которую зовёт renderer", () => {
  const missing = diff(invokedCommands(), bridgedCommands());
  assert.deepEqual(
    missing,
    [],
    `electron/main.ts не маршрутизирует: ${missing.join(", ")} — invoke() упрётся в NOT_IMPLEMENTED`,
  );
});

test("выход из аккаунта и email-вход доходят до движка", () => {
  const bridged = bridgedCommands();
  for (const cmd of ["tdlib_logout", "tdlib_set_email", "tdlib_check_email_code"]) {
    assert.ok(
      bridged.has(cmd),
      `${cmd} отсутствует в switch electron/main.ts — команда движка недостижима из UI`,
    );
  }
});

test("мост не обещает команд, которых нет в dispatch движка", () => {
  const ghosts = diff(bridgedCommands(), engineCommands());
  assert.deepEqual(
    ghosts,
    [],
    `electron/main.ts маршрутизирует несуществующие команды: ${ghosts.join(", ")}`,
  );
});
