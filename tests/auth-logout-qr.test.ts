/**
 * Гейт «выход из аккаунта → QR работает» (BUG-AUTH-LOGOUT-QR-001, 2026-11-10).
 *
 * Живой репорт владельца: «Если выполнить выход из аккаунта в ARTEL, то QR не
 * генерируется… Приходится закрывать клиент полностью и перезапускать.»
 *
 * Причина (по логам стенда `logs/e2e-prod32/bridge.log`):
 *   bridge FAIL tdlib_qr_login: sidecar error -32000: QR: TDLib login token
 *   requires authorizationStateWaitPhoneNumber (current: authorizationStateClosed)
 * То есть после `auth.logOut` новый клиент TDLib в ЭТОМ ЖЕ процессе сразу
 * отдаёт `authorizationStateClosed` (общий TDLib-инстанс закрытого клиента
 * остаётся в памяти) — `requestQrCodeAuthentication` отклоняется, QR не приходит.
 * Обходной путь пользователя (перезапуск приложения) работает, потому что НОВЫЙ
 * ПРОЦЕСС = чистое состояние TDLib.
 *
 * Что проверяем:
 *   1) main-процесс после `tdlib_logout` пересоздаёт sidecar (новый процесс) и
 *      поднимает TDLib runtime заново на ТОМ ЖЕ каталоге сессии (future-auth-token
 *      в БД переживает выход → вход по номеру остаётся мгновенным);
 *   2) Rust `handle_tdlib_logout` переносит future-токены в новый runtime
 *      (иначе вход по номеру после выхода перестал бы быть «без кода»);
 *   3) каталог состояния при выходе НЕ сносится (мгновенный повторный вход).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "electron", "main.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("корень не найден (старт: " + __dirname + ")");
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot(), rel), "utf8");
}

test("T1: только tdlib_logout пересоздаёт sidecar (guard в общем блоке case'ов)", () => {
  const src = read("electron/main.ts");
  assert.ok(src.includes("restartSidecarAfterLogout"), "нет пересоздания sidecar");
  const fn = src.slice(
    src.indexOf("async function restartSidecarAfterLogout"),
    src.indexOf("async function initSidecar"),
  );
  assert.ok(fn.includes("sidecarManager().stop()"), "sidecar не останавливается");
  assert.ok(fn.includes("sidecarManager().start()"), "sidecar не стартует заново");
  assert.ok(
    fn.includes("tdlib_start_runtime"),
    "runtime TDLib не поднимается заново на том же каталоге сессии",
  );
  // FALL-THROUGH-РЕГРЕСС (2026-11-11): `case "tdlib_logout"` обязан быть ПЛОСКИМ
  // ярлыком в общей цепочке, а пересоздание sidecar — под guard'ом
  // `cmd === "tdlib_logout"` ВНУТРИ общего блока. Иначе все case'ы ВЫШЕ ярлыка
  // (tdlib_is_ready / tdlib_shutdown — их дергает poll каждые 0.5–2 с)
  // проваливаются в логаут → цикл «логаут + рестарт sidecar», QR не работает.
  const label = src.indexOf('case "tdlib_logout":');
  assert.ok(label > 0, "case tdlib_logout не найден");
  const afterLabel = src.slice(label, label + 200);
  assert.match(
    afterLabel,
    /case "tdlib_logout":\s*\n\s*case "tdlib_reset_auth":/,
    `case "tdlib_logout" должен быть плоским ярлыком в цепочке fall-through, а не блоком с restart (получено: ${afterLabel.slice(0, 80)})`,
  );
  const guard = src.indexOf('if (cmd === "tdlib_logout")');
  assert.ok(guard > label, "guard cmd === tdlib_logout не найден после цепочки");
  assert.ok(
    src.slice(guard, guard + 200).includes("restartSidecarAfterLogout()"),
    "пересоздание sidecar должно вызываться ТОЛЬКО под guard'ом cmd === tdlib_logout",
  );
});

test("T2: Rust переносит future-токены в новый runtime после выхода", () => {
  const src = read("engine-core/src/main.rs");
  const start = src.indexOf("fn handle_tdlib_logout()");
  assert.ok(start > 0, "в main.rs нет handle_tdlib_logout");
  const body = src.slice(start, src.indexOf("\nfn ", start + 10));
  assert.ok(
    body.includes("auth_tokens"),
    "handle_tdlib_logout не переносит future-токены (вход по номеру станет «с кодом»)",
  );
  assert.ok(
    body.includes("rt.auth_tokens()"),
    "токены не снимаются со старого runtime",
  );
});

test("T3: каталог состояния при выходе не сносится (мгновенный повторный вход)", () => {
  const src = read("engine-core/src/main.rs");
  const start = src.indexOf("fn handle_tdlib_logout()");
  const body = src.slice(start, src.indexOf("\nfn ", start + 10));
  assert.ok(
    !body.includes("cleanup_state_dir"),
    "handle_tdlib_logout сносит каталог состояния — теряется future-auth-token",
  );
});

test("T4: путь БД сессии не меняется после выхода", () => {
  const src = read("engine-core/src/tdlib_runtime.rs");
  const start = src.indexOf("fn tdlib_db_path(");
  assert.ok(start > 0, "нет tdlib_db_path");
  const body = src.slice(start, src.indexOf("\n    }", start));
  assert.ok(
    !body.includes("__relogin") && !body.includes("relogin_session"),
    "каталог сессии переключается — future-auth-token в БД перестанет использоваться",
  );
});

test("T5: пересоздание sidecar не теряет проброс событий в renderer", () => {
  const src = read("electron/main.ts");
  assert.ok(
    src.includes("forwardSidecarEvent"),
    "проброс событий sidecar вынесен в отдельную функцию",
  );
  assert.ok(
    src.includes("sidecarManager().onEvent(forwardSidecarEvent)"),
    "подписка на события не переиспользует общий обработчик",
  );
});

// ── Фаза 2 (2026-11-11, по tdlib.log стенда) ────────────────────────────────
// Официальный контракт TDLib (td_api.tl → logOut): «Closes the TDLib instance
// after a proper logout. ALL LOCAL DATA WILL BE DESTROYED. After the logout
// completes, updateAuthorizationState with authorizationStateClosed will be
// sent». Отзыв сессии на сервере (ответ `ok` на logOut) — НЕ конец логаута:
// дальше TDLib АСИНХРОННО уничтожает ключи и локальную БД, и только потом
// шлёт authorizationStateClosed. Живое доказательство (tdlib.log, 2026-11-10
// 22:18:57–58 UTC): sidecar убит через 104 мс после `ok` → БД осталась в
// `authorizationStateLoggingOut` → свежий клиент продолжил логаут
// («Destroy all databases») и отдал authorizationStateClosed вместо
// WaitPhoneNumber → QR на экране входа мёртв до полного перезапуска.

test("T6: handle_tdlib_logout дожидается ЛОКАЛЬНОГО завершения логаута (authorizationStateClosed)", () => {
  const src = read("engine-core/src/main.rs");
  const start = src.indexOf("fn handle_tdlib_logout()");
  assert.ok(start > 0, "в main.rs нет handle_tdlib_logout");
  const body = src.slice(start, src.indexOf("\nfn ", start + 10));
  assert.ok(
    body.includes("wait_authorization_closed"),
    "handle_tdlib_logout не дожидается локального завершения логаута: убитый до Closed runtime оставляет БД в authorizationStateLoggingOut, свежий клиент продолжает логаут (уничтожает БД) и отдаёт Closed вместо WaitPhoneNumber",
  );
});

test("T7: wait_authorization_closed — ограниченный по времени опрос Closed, не вечный sleep", () => {
  const src = read("engine-core/src/tdlib_runtime.rs");
  const start = src.indexOf("pub fn wait_authorization_closed");
  assert.ok(start > 0, "в tdlib_runtime.rs нет wait_authorization_closed");
  const body = src.slice(start, src.indexOf("\n    }", start));
  assert.ok(
    body.includes("authorizationStateClosed"),
    "wait_authorization_closed не смотрит authorizationStateClosed",
  );
  assert.ok(
    body.includes("Instant::now()") && body.includes("sleep"),
    "wait_authorization_closed обязан быть опросом с дедлайном, а не фиксированным sleep",
  );
});

test("T8: свежий runtime после логаута страхуется от «хвоста логаута» в БД (Closed → пересоздание)", () => {
  const src = read("engine-core/src/main.rs");
  const start = src.indexOf("fn spawn_tdlib_runtime_after_logout");
  assert.ok(
    start > 0,
    "в main.rs нет spawn_tdlib_runtime_after_logout (страховка от Closed после свежего старта)",
  );
  const body = src.slice(start, src.indexOf("\nfn ", start + 10));
  assert.ok(
    body.includes("wait_not_closed_after_start") && body.includes("shutdown"),
    "страховка обязана: дождаться рабочего состояния свежего клиента; при Closed — пересоздать (каталог после дестроя логаута чист)",
  );
  const rt = read("engine-core/src/tdlib_runtime.rs");
  const wStart = rt.indexOf("pub fn wait_not_closed_after_start");
  assert.ok(
    wStart > 0,
    "в tdlib_runtime.rs нет wait_not_closed_after_start",
  );
});
