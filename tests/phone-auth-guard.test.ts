/**
 * Гейт «вход по номеру не падает на 400 unexpected» (живой репорт владельца, 2026-10-31).
 *
 * ПРЕЖДЕ (RED): клиент вызывал `setAuthenticationPhoneNumber` БЕЗ проверки
 * состояния TDLib. TDLib принимает этот запрос только в
 * `authorizationStateWaitPhoneNumber`; в любом другом состоянии ответ —
 * `400 Call to setAuthenticationPhoneNumber unexpected`, и мастер видел на экране
 * «🔑 Авторизация Telegram» сырой текст ошибки: `Ошибка (set_phone): Call to
 * setAuthenticationPhoneNumber unexpected (код 400)`.
 *
 * ПОСЛЕ: отказ формирует САМ движок — типизированным кодом, ДО отправки:
 *   `PHONE_AUTH_NOT_READY`            — TDLib ещё в инициализации;
 *   `PHONE_AUTH_IN_PROGRESS:<state>`  — уже идёт шаг входа (код/2FA/QR/email);
 *   `PHONE_AUTH_ALREADY_AUTHORIZED`   — TDLib уже Ready.
 * UI разбирает код чистым модулем `PhoneAuthGuard`, показывает человеческий текст
 * и сам приводит экран к фактическому шагу (`tdlib_check_auth`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePhoneAuthGuard } from "../src/ui/PhoneAuthGuard";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}
function read(file: string): string {
  return fs.readFileSync(path.join(projectRoot(), file), "utf8");
}
/** Вырезать комментарии — гейты по исходникам не должны ловить собственные доки. */
function code(file: string): string {
  return read(file).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── T1–T7: чистый разбор кода отказа ─────────────────────────────────────────

test("T1: PHONE_AUTH_NOT_READY — TDLib ещё не ждёт номер, повторить можно сразу", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_NOT_READY");
  assert.ok(g, "код not_ready обязан распознаваться");
  assert.equal(g!.kind, "not_ready");
  assert.equal(g!.state, "");
  assert.equal(g!.resync, false, "перезапрос состояния бессмысленен — TDLib ещё не готов");
  assert.equal(g!.expectsCode, false);
  assert.equal(g!.needsReset, false);
});

test("T2: PHONE_AUTH_IN_PROGRESS:wait_code — экран обязан перейти к вводу кода", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_IN_PROGRESS:wait_code");
  assert.ok(g);
  assert.equal(g!.kind, "auth_in_progress");
  assert.equal(g!.state, "wait_code");
  assert.equal(g!.expectsCode, true);
  assert.equal(g!.expectsPassword, false);
  assert.equal(g!.resync, true, "экран должен догнать TDLib (код уже отправлен)");
  assert.equal(g!.needsReset, false);
});

test("T3: PHONE_AUTH_IN_PROGRESS:wait_password — экран 2FA, сброс не нужен", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_IN_PROGRESS:wait_password");
  assert.ok(g);
  assert.equal(g!.kind, "auth_in_progress");
  assert.equal(g!.expectsPassword, true);
  assert.equal(g!.resync, true);
  assert.equal(g!.needsReset, false);
});

test("T4: PHONE_AUTH_IN_PROGRESS:wait_other_device (QR) — без сброса номер не принять", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_IN_PROGRESS:wait_other_device");
  assert.ok(g);
  assert.equal(g!.kind, "auth_in_progress");
  assert.equal(g!.needsReset, true, "pending QR-запрос TDLib не отпустит сам");
  assert.equal(g!.expectsCode, false);
});

test("T5: PHONE_AUTH_ALREADY_AUTHORIZED — вход уже выполнен", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_ALREADY_AUTHORIZED");
  assert.ok(g);
  assert.equal(g!.kind, "already_authorized");
  assert.equal(g!.state, "ready");
});

test("T6: чужой текст (сырой TDLib 400) guard-кодом не считается", () => {
  assert.equal(parsePhoneAuthGuard("Call to setAuthenticationPhoneNumber unexpected"), null);
  assert.equal(parsePhoneAuthGuard(""), null);
  assert.equal(parsePhoneAuthGuard(undefined), null);
  assert.equal(parsePhoneAuthGuard(null), null);
});

test("T7: хвостовое пояснение после кода не мешает разбору", () => {
  const g = parsePhoneAuthGuard("PHONE_AUTH_IN_PROGRESS:wait_code (TDLib уже ждёт код)");
  assert.ok(g);
  assert.equal(g!.kind, "auth_in_progress");
  assert.equal(g!.state, "wait_code");
});

// ── T8–T10: гейты по исходникам ──────────────────────────────────────────────

test("T8: submitPhone разбирает guard-код и приводит экран к шагу TDLib", () => {
  const src = code("src/ui/TdlibAuthPage.ts");
  const start = src.indexOf("private async submitPhone");
  const end = src.indexOf("private async submitEmail");
  assert.ok(start >= 0 && end > start, "submitPhone/submitEmail не найдены");
  const body = src.slice(start, end);
  assert.ok(
    body.includes("parsePhoneAuthGuard("),
    "submitPhone обязан разбирать типизированный отказ движка, иначе мастер снова увидит сырой 400",
  );
  assert.ok(
    src.includes("private _onPhoneAuthGuardRefused("),
    "нужен обработчик guard-отказа (человеческий текст + кнопки)",
  );
  const handler = src.slice(src.indexOf("private _onPhoneAuthGuardRefused("));
  assert.ok(handler.includes("auth.already_authorized"), "случай «уже авторизован» — человеческим текстом");
  assert.ok(handler.includes("auth.phone_auth_not_ready"), "случай «TDLib ещё запускается» — человеческим текстом");
  assert.ok(handler.includes("auth.phone_auth_in_progress"), "случай «уже идёт шаг входа» — человеческим текстом");
  assert.ok(handler.includes("auth.phone_auth_needs_reset"), "случай pending QR — подсказка про «Скинути»");
  assert.ok(src.includes("private async _resyncAuthStep("), "нужен перезапрос состояния (экран догоняет TDLib)");
  const resync = src.slice(src.indexOf("private async _resyncAuthStep("));
  assert.ok(resync.includes('"tdlib_check_auth"'), "перезапрос состояния — через tdlib_check_auth");
  assert.ok(!src.includes("setAuthenticationPhoneNumber"), "renderer не собирает TDLib-payload руками");
});

test("T9: set_phone проверяет состояние TDLib ДО отправки запроса", () => {
  const rust = read("engine-core/src/tdlib_runtime.rs");
  assert.ok(rust.includes("fn is_phone_login_state"), "нужен предикат состояния для ввода номера");
  assert.ok(rust.includes("fn phone_auth_state_error"), "нужен типизированный отказ (код для UI)");
  assert.ok(rust.includes("fn wait_for_state"), "нужно ожидание состояния (нет гонки холодного старта)");
  assert.ok(rust.includes("PHONE_AUTH_NOT_READY"), "код not_ready");
  assert.ok(rust.includes("PHONE_AUTH_IN_PROGRESS"), "код in_progress");
  assert.ok(rust.includes("PHONE_AUTH_ALREADY_AUTHORIZED"), "код already_authorized");

  const start = rust.indexOf("pub fn set_phone");
  const end = rust.indexOf("pub fn check_code");
  assert.ok(start >= 0 && end > start, "set_phone/check_code не найдены");
  const body = rust.slice(start, end);
  assert.ok(body.includes("phone_auth_state_error"), "set_phone обязан звать типизированную проверку");
  assert.ok(
    body.indexOf("phone_auth_state_error") < body.indexOf("send_value"),
    "проверка состояния ОБЯЗАНА идти до send_value — иначе TDLib отвечает 400 unexpected",
  );

  // Тот же класс дефекта у email-ветки: setAuthenticationEmailAddress валиден
  // только в authorizationStateWaitEmailAddress.
  const emStart = rust.indexOf("pub fn set_email_address");
  const emEnd = rust.indexOf("pub fn check_email_code");
  assert.ok(emStart >= 0 && emEnd > emStart, "set_email_address/check_email_code не найдены");
  const emBody = rust.slice(emStart, emEnd);
  assert.ok(emBody.includes("email_auth_state_error"), "email-ветка тоже не должна слать запрос вслепую");
});

test("T10: человеческие тексты есть во всех локалях, сырой «unexpected» не показывается", () => {
  for (const lang of ["ru", "uk", "en"]) {
    const text = read(`src/i18n/locales/${lang}.ts`);
    for (const key of [
      "phone_auth_not_ready",
      "phone_auth_in_progress",
      "phone_auth_needs_reset",
      "email_auth_not_ready",
      "err_unexpected_step",
    ]) {
      assert.ok(text.includes(`${key}:`), `${lang}: нет ключа ${key}`);
    }
  }
  const src = code("src/ui/TdlibAuthPage.ts");
  const translate = src.slice(src.indexOf("private _translateError("), src.indexOf("// Completion"));
  assert.ok(
    translate.includes("unexpected") && translate.includes("auth.err_unexpected_step"),
    "_translateError обязан переводить «unexpected» в понятный шаг, а не показывать текст TDLib",
  );
});
