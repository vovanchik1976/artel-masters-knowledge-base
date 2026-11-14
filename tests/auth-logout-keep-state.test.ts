/**
 * Выход из аккаунта с сохранением «билетов» мгновенного входа
 * (BUG-AUTH-CODE-006, future-auth-token, 2026-10-20) — гейт по ИСХОДНИКУ
 * [`engine-core/src/main.rs`](../engine-core/src/main.rs) и
 * [`src/ui/App.ts`](../src/ui/App.ts).
 *
 * Доки Telegram (core.telegram.org/api/auth → «Future auth tokens»): при
 * `auth.logOut` сервер возвращает `future_auth_token`; TDLib хранит его
 * В КАТАЛОГЕ СОСТОЯНИЯ, и следующий `auth.sendCode` из того же каталога
 * передаёт `logout_tokens` → Telegram сразу возвращает `SentCodeSuccess` —
 * вход Вообще без доставки кода (мгновенно). Это официальная механика
 * «сиюминутного повторного входа».
 *
 * Инварианты:
 *  1. `tdlib_logout` зарегистрирован в dispatch engine-core.
 *  2. `handle_tdlib_logout` вызывает TDLib `logOut` (отзыв сессии в сети).
 *  3. Внутри `handle_tdlib_logout` НЕТ `cleanup_state_dir` — каталог
 *     состояния обязан пережить выход (иначе token lost → код → «окна»).
 *  4. Кнопка «Выйти» (App.disconnect) зовёт `tdlib_logout`, а не
 *     `tdlib_reset_auth` (тот по-прежнему сносит каталог — он для
 *     «сбросить застрявший вход», где токенов нет).
 *
 * RED (до фикса): в main.rs нет `tdlib_logout`, App.disconnect дернул
 * `resetAuth()` → `tdlib_reset_auth` → каталог снесён → повторный вход по коду.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "engine-core", "src", "main.rs"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`корень не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

function mainRustSource(): string {
  return fs.readFileSync(path.join(repoRoot(), "engine-core", "src", "main.rs"), "utf8");
}

function appSource(): string {
  return fs.readFileSync(path.join(repoRoot(), "src", "ui", "App.ts"), "utf8");
}

/** Тело функции (от её определения до следующей \nfn на том же уровне). */
function functionBody(src: string, fnName: string): string {
  const start = src.indexOf(`fn ${fnName}`);
  assert.ok(start >= 0, `в main.rs нет fn ${fnName}`);
  const rest = src.slice(start + 1);
  const nextFn = rest.search(/\n(fn |#\[test\]|mod |impl )/);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
}

test("logOut-гигиена: tdlib_logout зарегистрирован в dispatch engine-core", () => {
  const src = mainRustSource();
  assert.ok(
    src.includes(`"tdlib_logout" => handle_tdlib_logout()`),
    "dispatch не ведёт tdlib_logout → команда недоступна UI",
  );
});

test("logOut-гигиена: handle_tdlib_logout шлёт TDLib logOut и НЕ сносит каталог состояния", () => {
  const body = functionBody(mainRustSource(), "handle_tdlib_logout");
  assert.ok(
    body.includes(`"@type": "logOut"`),
    "handle_tdlib_logout обязан вызвать сетевой logOut (отзыв сессии + future_auth_token)",
  );
  assert.ok(
    !body.includes("cleanup_state_dir"),
    "handle_tdlib_logout НЕ ВПРАВЕ удалить каталог состояния: там живут future-токены мгновенного входа",
  );
  assert.ok(
    body.includes("state_kept"),
    "ответ tdlib_logout обязан декларировать state_kept (контракт сохранности каталога)",
  );
});

function authPageSource(): string {
  return fs.readFileSync(path.join(repoRoot(), "src", "ui", "TdlibAuthPage.ts"), "utf8");
}

/** Тело `resetAuth()` — до следующего публичного метода (`destroy`). */
function resetAuthBody(): string {
  const src = authPageSource();
  const start = src.indexOf("async resetAuth(");
  assert.ok(start >= 0, "в TdlibAuthPage.ts нет async resetAuth()");
  const rest = src.slice(start);
  const end = rest.indexOf("destroy(): void");
  assert.ok(end > 0, "не нашли конец resetAuth (destroy)");
  return rest.slice(0, end);
}

/** Тело `disconnect()` в App.ts (до конца класса). */
function disconnectBody(): string {
  const src = appSource();
  const start = src.indexOf("async disconnect()");
  assert.ok(start >= 0, "в App.ts нет async disconnect()");
  return src.slice(start);
}

test("logOut fail-closed: TDLib зовётся ПЕРВЫМ, локальный сброс — только после успеха", () => {
  // BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001: раньше resetAuth() сначала рвал
  // локальное состояние (флаги, слушатели, токен) и только потом звал
  // tdlib_logout. Если выход не удался (мост не маршрутизировал команду —
  // NOT_IMPLEMENTED), клиент оставался с ЖИВЫМ TDLib, но на экране входа:
  // любая попытка входа получала PHONE_AUTH_ALREADY_AUTHORIZED.
  assert.ok(
    authPageSource().includes(
      'async resetAuth(mode: "reset" | "logout" = "reset"): Promise<boolean>',
    ),
    "resetAuth обязан возвращать Promise<boolean>: вызывающий должен узнать об отказе",
  );
  const body = resetAuthBody();
  const invokeAt = body.indexOf('invoke(mode === "logout" ? "tdlib_logout" : "tdlib_reset_auth")');
  const localResetAt = body.indexOf("this._authResolved = false");
  assert.ok(invokeAt >= 0, "resetAuth обязан звать tdlib_logout/tdlib_reset_auth");
  assert.ok(
    localResetAt > invokeAt,
    "локальный сброс (_authResolved/flags/listeners) обязан идти ПОСЛЕ ответа TDLib",
  );
  const failAt = body.indexOf("return false");
  assert.ok(failAt > invokeAt, "при отказе TDLib resetAuth возвращает false (fail-closed)");
  assert.ok(
    body.indexOf("this.showAuthPage()") > failAt,
    "экран входа показывается ТОЛЬКО после успешного выхода — иначе вход поверх живой сессии",
  );
});

test("App.disconnect не рвёт локальную сессию, если TDLib не вышел", () => {
  const body = disconnectBody();
  const at = body.indexOf('resetAuth("logout")');
  assert.ok(at >= 0, "disconnect обязан звать resetAuth(\"logout\")");
  assert.ok(
    body.includes("const loggedOut = await this.tdlibAuthPage.resetAuth(\"logout\")"),
    "результат выхода обязан проверяться (иначе локальная сессия снесена впустую)",
  );
  const guardAt = body.indexOf("if (!loggedOut)");
  assert.ok(guardAt > at, "нужен ранний выход при отказе TDLib (if (!loggedOut) return)");
  const clearAt = body.indexOf("api.setToken(null)");
  assert.ok(
    clearAt === -1 || clearAt > guardAt,
    "очистка токена/локальной сессии — только после успешного выхода",
  );
});

test("PHONE_AUTH_ALREADY_AUTHORIZED не тупик: экран завершает вход (pairing)", () => {
  const src = authPageSource();
  const start = src.indexOf('case "already_authorized":');
  assert.ok(start >= 0, "в _onPhoneAuthGuardRefused нет ветки already_authorized");
  const end = src.indexOf('case "not_ready":', start);
  const block = src.slice(start, end > start ? end : start + 800);
  assert.ok(
    block.includes("_doApiPairing"),
    "TDLib уже авторизован — экран обязан завершить вход (getMe + authPair), а не показывать тупик",
  );
});

test("logOut-гигиена: кнопка «Выйти» (App.disconnect) зовёт tdlib_logout, не reset_auth", () => {
  const src = appSource();
  assert.ok(
    src.includes(`resetAuth("logout")`),
    "App.disconnect должен вызывать resetAuth(\"logout\") → tdlib_logout (сохранение.future-токенов)",
  );
  // В disconnect-пути не должно остаться голого resetAuth() (это снос каталога
  // при выходе ИЗ авторизованной сессии — потеря мгновенного повторного входа).
  const disconnectAt = src.indexOf("async disconnect()");
  assert.ok(disconnectAt >= 0, "в App.ts нет async disconnect()");
  const suffix = src.slice(disconnectAt);
  const end = suffix.search(/\n(?:async |private |public |}\s*$)/);
  const disconnectBody = end === -1 ? suffix : suffix.slice(0, end);
  assert.ok(
    disconnectBody.includes(`resetAuth("logout")`),
    "внутри disconnect() должен быть именно logout-режим resetAuth",
  );
});
