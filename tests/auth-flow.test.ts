/** Auth contract: direct MTP phone login is primary; QR remains an explicit option. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function root(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  return dir;
}
function read(file: string): string { return fs.readFileSync(path.join(root(), file), "utf8"); }
function code(file: string): string {
  return read(file).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("auth page shows QR as primary, phone as secondary", () => {
  const html = read("index.html");
  assert.ok(html.indexOf('id="authPageQrMethodBtn"') < html.indexOf('id="authPagePhoneMethodBtn"'));
  const codeStep = html.slice(html.indexOf('id="authPageStepCode"'), html.indexOf('id="authPageStepPassword"'));
  assert.ok(codeStep.includes('id="authPageCodeQrBtn"'));
  assert.ok(!codeStep.includes("PhoneApproval"));
  assert.ok(!html.includes("Telegram Login"));
});

test("auth page has no native-phone or Telegram Login fallback path", () => {
  const src = code("src/ui/TdlibAuthPage.ts");
  assert.ok(!src.includes("widgetLoginStart"));
  assert.ok(!src.includes("startPhoneApproval"));
  assert.ok(!src.includes("startNativePhoneFallback"));
  assert.ok(!src.includes("nativePhoneFallback"));
  assert.ok(!src.includes("mtp_auth_start"));
  assert.ok(!src.includes("mtp_auth_check_code"));
  assert.ok(!src.includes("mtp_auth_check_password"));
  assert.ok(!src.includes("mtp_auth_handoff_to_tdlib"));
  assert.ok(!src.includes("mtp_auth_cancel"));
  assert.ok(!src.includes("mtp_auth_finish"));
  assert.ok(src.includes('invoke<string>("tdlib_set_phone"'));
  assert.ok(src.includes('invoke<string>("tdlib_check_code"'));
  assert.ok(src.includes('invoke<string>("tdlib_check_password"'));
});

test("phone auth remains direct MTP plus explicit QR; no Widget API or SMS promises", () => {
  const src = code("src/ui/TdlibAuthPage.ts");
  assert.ok(!src.includes("widgetLogin"));
  assert.ok(!src.includes("reportAuthenticationCodeMissing"));
  assert.ok(src.includes('invoke<string>("tdlib_reset_auth")'));
  assert.ok(src.includes('invoke<{ status: string }>("tdlib_qr_login")'));
});

test("removed auth fallbacks are absent from all locale bundles", () => {
  for (const lang of ["ru", "uk", "en"]) {
    const text = read(`src/i18n/locales/${lang}.ts`);
    assert.ok(!text.includes("approval_button"), `${lang}: Telegram Login button removed`);
    assert.ok(!text.includes("mtp_native_fallback"), `${lang}: native fallback removed`);
    assert.ok(text.includes("mtp_handoff_unauthorized"), `${lang}: TDLib 401 feedback`);
  }
});

test("TDLib ready triggers API pairing, no MTP handoff in main", () => {
  const main = code("electron/main.ts");
  const runtime = read("engine-core/src/tdlib_runtime.rs");
  // Нет MTP хендлеров в main
  assert.ok(!main.includes("mtp_auth_start"), "no mtp_auth_start handler");
  assert.ok(!main.includes("mtp_auth_check_code"), "no mtp_auth_check_code handler");
  assert.ok(!main.includes("mtp_auth_check_password"), "no mtp_auth_check_password handler");
  assert.ok(!main.includes("mtp_auth_handoff_to_tdlib"), "no mtp_auth_handoff_to_tdlib handler");
  assert.ok(!main.includes("mtp_auth_finish"), "no mtp_auth_finish handler");
  assert.ok(!main.includes("mtp_auth_cancel"), "no mtp_auth_cancel handler");
  assert.ok(!main.includes("./mtp-auth"), "no mtp-auth import");
  // TDLib runtime готов к WaitPhoneNumber для QR
  assert.ok(runtime.includes("fn is_qr_login_state(state: &str) -> bool"));
  assert.ok(runtime.includes('state == "authorizationStateWaitPhoneNumber"'));
});

test("TDLib-native phone flow has no MTP handoff", () => {
  const src = code("src/ui/TdlibAuthPage.ts");
  assert.ok(src.indexOf("private async finishMtpHandoff") === -1, "finishMtpHandoff removed");
  assert.ok(!src.includes("mtp_auth_handoff_to_tdlib"), "no mtp_auth_handoff_to_tdlib");
  assert.ok(!src.includes("mtp_auth_finish"), "no mtp_auth_finish");
  assert.ok(!src.includes("mtp_auth_cancel"), "no mtp_auth_cancel");
  assert.ok(src.includes('case "wait_code"'), "wait_code event handled in tdlib-auth-state");
  assert.ok(src.includes("configureCodeResend(event.payload.next_code_type"), "wait_code configures resend from next_code_type");
});


test("TDLib auth errors are reported safely without MTP", () => {
  const page = code("src/ui/TdlibAuthPage.ts");
  // Нет ссылок на MTP ошибки в UI
  assert.ok(!page.includes("mtp_auth"), "no MTP auth in UI");
  assert.ok(!page.includes("_formatMtpError"), "no _formatMtpError");
  assert.ok(!page.includes("_formatMtpDelivery"), "no _formatMtpDelivery");
  // TDLib ошибки проходят через общий хендлер
  assert.ok(page.includes("tdlib-auth-error"), "tdlib-auth-error handled");

  const main = code("electron/main.ts");
  assert.ok(!main.includes("mtp_auth"), "no MTP handlers in main");
  assert.ok(!main.includes("normalizeMtpAuthError"), "no MTP error normalizer");

  const diag = code("src/ui/AuthDiag.ts");
  assert.ok(diag.includes('"auth-flow.log"'));
});

test("TDLib set_phone errors are reported safely", () => {
  const page = code("src/ui/TdlibAuthPage.ts");
  // Вызов tdlib_set_phone при submitPhone
  assert.ok(page.includes('invoke<string>("tdlib_set_phone"'), "tdlib_set_phone called");
  // Нет MTP
  assert.ok(!page.includes("mtp_auth_start"), "no mtp_auth_start");
  // Ошибки отображаются через общий префикс
  assert.ok(page.includes('t("auth.error_prefix"'), "errors use common prefix");

  const runtime = read("engine-core/src/tdlib_runtime.rs");
  assert.ok(runtime.includes('"@type": "setAuthenticationPhoneNumber"'), "setAuthenticationPhoneNumber in runtime");
  assert.ok(runtime.includes("fn set_phone"), "set_phone in runtime");
});

test("SP25 shows email only when Telegram requests it and explains QR-is-primary", () => {
  const html = read("index.html");
  const phoneStep = html.slice(html.indexOf('id="authPageStepPhone"'), html.indexOf('id="authPageStepEmailAddress"'));
  assert.ok(phoneStep.includes('data-i18n="auth.phone_note"'));
  assert.ok(html.includes('id="authPageStepEmailAddress"'));
  assert.ok(html.includes('id="authPageStepEmailCode"'));

  const src = code("src/ui/TdlibAuthPage.ts");
  assert.ok(src.includes('case "wait_email_address"'));
  assert.ok(src.includes('case "wait_email_code"'));
  assert.ok(src.includes('invoke<string>("tdlib_set_email"'));
  assert.ok(src.includes('invoke<string>("tdlib_check_email_code"'));
  assert.ok(src.includes('status === "wait_email_code"'));
});

test("SP25 forwards native TDLib email auth methods without exposing input in logs", () => {
  const rust = read("engine-core/src/tdlib_runtime.rs");
  assert.ok(rust.includes('"@type": "setAuthenticationEmailAddress"'));
  assert.ok(rust.includes('"@type": "checkAuthenticationEmailCode"'));
  assert.ok(rust.includes('"@type": "emailAddressAuthenticationCode"'));
  assert.ok(rust.includes('"authorizationStateWaitEmailAddress"'));
  assert.ok(rust.includes('"authorizationStateWaitEmailCode"'));

  for (const lang of ["ru", "uk", "en"]) {
    const text = read(`src/i18n/locales/${lang}.ts`);
    assert.ok(text.includes("phone_note"), `${lang}: QR-is-primary phone note`);
    assert.ok(text.includes("email_code_label"), `${lang}: email code label`);
  }
});

test("SP25 first-run delivery gate accepts Telegram's native email auth states", () => {
  const script = read("e2e-prod.sh");
  assert.ok(script.includes("authorizationStateWait(PhoneNumber|Code|EmailAddress|EmailCode)"));
  assert.ok(script.includes("status=wait_(code|email_address|email_code)"));
  assert.ok(script.includes("phone/email auth state"));
});

test("auth code screen avoids duplicate delivery text and only offers Telegram-authorized resend", () => {
  const src = code("src/ui/TdlibAuthPage.ts");
  assert.ok(!src.includes('this.log(codeMsg, "info")'));
  assert.ok(src.includes("configureCodeResend(event.payload.next_code_type, event.payload.timeout ?? 0)"));
  assert.ok(src.includes("if (!this._canResendCode) return"));

  const rust = read("engine-core/src/tdlib_runtime.rs");
  assert.ok(rust.includes('"next_code_type": next_code_type'));
  assert.ok(rust.includes('"timeout": timeout'));

  for (const lang of ["ru", "uk", "en"]) {
    const text = read(`src/i18n/locales/${lang}.ts`);
    assert.ok(text.includes("qr_from_code"), `${lang}: explicit QR option remains`);
  }
});

test("SP25 matches desktop code settings and hides resend without a Telegram next channel", () => {
  const rust = read("engine-core/src/tdlib_runtime.rs");
  const settings = rust.slice(rust.indexOf("fn build_phone_auth_settings"), rust.indexOf("fn capture_authentication_token"));
  assert.match(settings, /"allow_missed_call":\s*false/);
  assert.match(settings, /"has_unknown_phone_number":\s*false/);
  assert.match(settings, /"authentication_tokens":\s*auth_tokens/);

  const src = code("src/ui/TdlibAuthPage.ts");
  const waitCode = src.slice(src.indexOf('case "wait_code"'), src.indexOf('case "wait_password"'));
  assert.ok(waitCode.includes("configureCodeResend(event.payload.next_code_type, event.payload.timeout ?? 0)"));
  assert.ok(!waitCode.includes('resendCodeBtn.style.display = "inline-block"'));
  const configure = src.slice(src.indexOf("private configureCodeResend"), src.indexOf("private ", src.indexOf("private configureCodeResend") + 8));
  assert.ok(configure.includes('this._canResendCode ? "inline-block" : "none"'));
  assert.ok(configure.includes("Math.max(0, timeoutSeconds) * 1000"));
  assert.ok(configure.includes("delayMs > 0"));
  assert.ok(configure.includes("this._canResendCode && this.resendCodeBtn"));
});
