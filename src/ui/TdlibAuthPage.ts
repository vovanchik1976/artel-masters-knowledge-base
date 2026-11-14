/**
 * TdlibAuthPage — страница авторизации через TDLib (QR/телефон/email).
 *
 * # Архитектура (v4.0 — Event-Driven / Single Consumer)
 *
 * ## Проблема v3.0
 *
 * Раньше Tauri-команды (tdlib_qr_login, tdlib_set_phone, ...) были блокирующими:
 * они вызывали `receive()` на том же Mutex'е, что и `run_receive_loop()`.
 * Это приводило к race condition: между `send()` и `receive()` Mutex освобождался,
 * и receive loop мог украсть ответ (или наоборот).
 *
 * ## Решение v4.0
 *
 * **Single Consumer**: только `run_receive_loop()` вызывает `receive()`.
 * Все Tauri-команды авторизации — fire-and-forget (отправляют запрос и сразу
 * возвращают управление). Ответы приходят асинхронно через Tauri-события.
 *
 * ## Data Flow
 *
 * ```text
 * 1. UI вызывает invoke("tdlib_qr_login")     ← blocking return {"status":"sent"}
 * 2. Rust отправляет { @type: "requestQrCodeAuthentication" } в TDLib
 * 3. TDLib обрабатывает и шлёт updateAuthorizationState
 * 4. run_receive_loop() получает update, эмитит событие:
 *    app_handle.emit("tdlib-auth-state", { status: "qr_link", link: "tg://..." })
 * 5. TdlibAuthPage слушает событие и отображает QR
 * ```
 *
 * ## Event Types
 *
 * | status | payload | когда |
 * |--------|---------|-------|
 * | `"ready"` | `{}` | TDLib авторизован (QR-скан или code/password) |
 * | `"closed"` | `{}` | Пользователь вышел |
 * | `"wait_phone"` | `{}` | Ожидание номера телефона |
 * | `"wait_email_address"` | `{ allow_apple_id, allow_google_id }` | TDLib запросил email |
 * | `"wait_email_code"` | `{ email_address_pattern, code_length }` | Ожидание email-кода |
 * | `"qr_link"` | `{ link }` | QR-код сгенерирован |
 * | `"wait_code"` | `{ code_type }` | Код отправлен, ожидание ввода |
 * | `"wait_password"` | `{ hint }` | 2FA пароль |
 *
 * Ошибки: `tdlib-auth-error` → `{ extra, message, code }`
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn, type Event } from "@tauri-apps/api/event";
import { store } from "../store";
import { setTdlibUserAuthorized } from "../tdlibAuth";
import { api } from "../api";
import { t, tLoose } from "../i18n";
import { credentialsReady } from "../credsState";
// Диагностика «код не приходить» — чистый модуль (BUG-AUTH-CODE-002).
import { authDiagFilesList } from "./AuthDiag";
import { parsePhoneAuthGuard, type PhoneAuthGuard } from "./PhoneAuthGuard";

// ЭЛЕКТРОН-ПОРТ (отклонение от mainline): локальная генерация QR вместо
// внешнего api.qrserver.com — см. src/qr.ts и PORT_DIVERGENCES.md.
import { qrDataUrl } from "../qr";

/** DOM ID — authPage контейнер */
const AUTH_PAGE_ID = "authPage";
const MAIN_SECTION_ID = "mainSection";

/** Сколько ждать между проверками готовности при QR-сканировании (мс) */
const QR_POLL_INTERVAL_MS = 2000;

/** Типизированный payload события tdlib-auth-state */
interface TdlibAuthStateEvent {
  status: string;
  link?: string;
  code_type?: string;
  next_code_type?: string | null;
  timeout?: number;
  hint?: string;
  email_address_pattern?: string;
  code_length?: number;
  allow_apple_id?: boolean;
  allow_google_id?: boolean;
}

/** Типизированный payload события tdlib-auth-error */
interface TdlibAuthErrorEvent {
  extra: string;
  message: string;
  code: number;
}

/** Типизированный payload события tdlib-connection-state */
interface TdlibConnectionStateEvent {
  state: string;
}

/** Типизированный payload события tdlib-my-id (ответ getMe) */
interface TdlibMyIdEvent {
  tg_id: number;
  first_name: string;
  last_name: string;
  username: string;
}

/**
 * Форматированный auth log с timestamp для отладки.
 * Записывает в console.debug + сохраняет в window.__authLog.
 */
function authLogUI(layer: string, message: string, data?: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = data
    ? `[${ts}] [${layer.padEnd(8)}] ${message} | ${data}`
    : `[${ts}] [${layer.padEnd(8)}] ${message}`;
  console.debug(line);
  // Сохраняем последние 500 строк в глобальном массиве для анализа
  if (!(window as any).__authLog) (window as any).__authLog = [];
  (window as any).__authLog.push(line);
  if ((window as any).__authLog.length > 500) (window as any).__authLog.shift();
}

export class TdlibAuthPage {
  private onAuthenticated: () => void;
  private _qrPollTimer: ReturnType<typeof setInterval> | null = null;
  private _unlistenAuthState: UnlistenFn | null = null;
  private _unlistenAuthError: UnlistenFn | null = null;
  private _unlistenConnectionState: UnlistenFn | null = null;
  /** Флаг: авторизация уже завершена (чтобы не вызвать onAuthenticated дважды) */
  private _authResolved = false;
  /**
   * BUG-AUTH-015: shared promise — при повторном вызове _doApiPairing()
   * второй caller ждёт завершения первого, а НЕ резолвит сразу.
   * Предыдущий boolean-флаг вызывал race: guard возвращал undefined,
   * и .then() на caller'е срабатывал ДО установки токена.
   */
  private _pairingPromise: Promise<void> | null = null;
  /** Флаг: ожидаем код (чтобы не переключаться на stepCode повторно) */
  private _expectingCode = false;
  /** Windows diagnostics: watchdog for fire-and-forget phone auth hangs. */
  private _phoneAuthWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last TDLib connection state emitted by Rust receive loop. */
  private _lastConnectionState = "unknown";
  /** Каталог логов из main (кэш; `undefined` — ещё не запрашивали, BUG-AUTH-CODE-002). */
  private _authLogDir: string | null | undefined = undefined;


  /**
   * BUG-AUTH-CODE-004: «уйти на QR с экрана кода». TDLib принимает
   * `requestQrCodeAuthentication` только когда НЕТ pending auth query, поэтому
   * сначала обязателен `tdlib_reset_auth`, а QR запрашивается уже на
   * событии `wait_phone` (после пересоздания клиента).
   */
  private _pendingQrAfterReset = false;
  /** BUG-AUTH-FSM-READY: TDLib уже в Ready — блокируем повторную отправку кода */
  private _tdlibAuthorized = false;
  /** FIX-AUTH-READY-TIMEOUT: флаг — в submitCode() случился timeout ожидания Ready */
  private _submitErrorTimeout = false;
  /**
   * Host-Mediation auto-/start: последний tg_id, которому уже отправлен /start.
   * Хранится по tg_id (НЕ boolean по процессу): BUG-AUTO-START-001 — единый
   * флаг на процесс блокировал авто-/start для следующего аккаунта после
   * reset/смены аккаунта в том же окне → новый юзер не получал PM с ботом →
   * upload падал с 400 Chat not found.
   */
  private _autoStartSentFor: number | null = null;

  // DOM references
  private authPage: HTMLElement;
  private mainSection: HTMLElement;
  private statusEl: HTMLElement;
  private errorEl: HTMLElement;

  // Step containers
  private step0: HTMLElement;
  private stepQr: HTMLElement;
  private stepPhone: HTMLElement;
  private stepEmailAddress: HTMLElement;
  private stepEmailCode: HTMLElement;
  private stepCode: HTMLElement;
  private stepPassword: HTMLElement;

  // Step 0 buttons
  private qrBtn: HTMLElement | null;
  private phoneBtn: HTMLElement | null;

  // QR elements
  private qrImage: HTMLImageElement | null;
  private qrPlaceholder: HTMLElement | null;
  private qrLink: HTMLAnchorElement | null;
  private qrCancelBtn: HTMLElement | null;
  private qrResetBtn: HTMLElement | null;

  // Phone elements
  private phoneInput: HTMLInputElement | null;
  private phoneSubmitBtn: HTMLElement | null;
  private phoneCancelBtn: HTMLElement | null;
  private phoneResetBtn: HTMLElement | null;

  // Native TDLib email auth elements.
  private emailInput: HTMLInputElement | null;
  private emailSubmitBtn: HTMLElement | null;
  private emailResetBtn: HTMLElement | null;
  private emailCodeInput: HTMLInputElement | null;
  private emailCodeSubmitBtn: HTMLElement | null;
  private emailCodeResetBtn: HTMLElement | null;
  private emailCodeQrBtn: HTMLElement | null;
  private emailDisplay: HTMLElement | null;

  // Code elements
  private codeInput: HTMLInputElement | null;
  private codeSubmitBtn: HTMLElement | null;
  private codeCancelBtn: HTMLElement | null;
  private codeResetBtn: HTMLElement | null;
  private resendCodeBtn: HTMLElement | null;
  private _resendEnableTimer: ReturnType<typeof setTimeout> | null = null;
  private _canResendCode = false;
  private phoneDisplay: HTMLElement | null;
  /**
   * BUG-AUTH-CODE-004: видимая подсказка о КАНАЛЕ доставки кода.
   * Элемент `#authPageCodeDeliveryInfo` был в разметке, но код в него никогда
   * не писал — мастер видел «Код отправлен на +380…» и ждал SMS, хотя
   * `authenticationCodeTypeTelegramMessage` приходит сообщением внутрь
   * приложения Telegram (чат «Telegram», 777000).
   */
  private codeDeliveryInfo: HTMLElement | null;
  /** Переход на QR-вход прямо с экрана кода (через reset_auth). */
  private codeQrBtn: HTMLElement | null;

  // Password elements
  private passwordInput: HTMLInputElement | null;
  private passwordSubmitBtn: HTMLElement | null;
  private passwordCancelBtn: HTMLElement | null;
  private passwordResetBtn: HTMLElement | null;
  private passwordHint: HTMLElement | null;

  /**
   * BUG-AUTH-SAFETY-001: Принимаем safetyTimer ID от main.ts (через App.ts).
   * Таймер очищается при получении первого tdlib-auth-state события
   * (любого статуса: ready, wait_phone, wait_code, etc.) или при ошибке.
   * Это предотвращает очистку в main.ts finally блоке до того,
   * как TDLib успеет прислать ответ при холодном старте (30с).
   */
  private _safetyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onAuthenticated: () => void, safetyTimer?: ReturnType<typeof setTimeout>) {
    this.onAuthenticated = onAuthenticated;
    this._safetyTimer = safetyTimer ?? null;

    // Контейнеры
    this.authPage = document.getElementById(AUTH_PAGE_ID) as HTMLElement;
    this.mainSection = document.getElementById(MAIN_SECTION_ID) as HTMLElement;
    this.statusEl = document.getElementById("authPageStatus") as HTMLElement;
    this.errorEl = document.getElementById("authPageError") as HTMLElement;

    // Step'ы
    this.step0 = document.getElementById("authPageStep0") as HTMLElement;
    this.stepQr = document.getElementById("authPageStepQr") as HTMLElement;
    this.stepPhone = document.getElementById("authPageStepPhone") as HTMLElement;
    this.stepEmailAddress = document.getElementById("authPageStepEmailAddress") as HTMLElement;
    this.stepEmailCode = document.getElementById("authPageStepEmailCode") as HTMLElement;
    this.stepCode = document.getElementById("authPageStepCode") as HTMLElement;
    this.stepPassword = document.getElementById("authPageStepPassword") as HTMLElement;

    // Кнопки выбора метода
    this.qrBtn = document.getElementById("authPageQrMethodBtn");
    this.phoneBtn = document.getElementById("authPagePhoneMethodBtn");

    // QR
    this.qrImage = document.getElementById("authPageQrCodeImg") as HTMLImageElement;
    this.qrPlaceholder = document.getElementById("authPageQrPlaceholder");
    this.qrLink = document.getElementById("authPageQrLink") as HTMLAnchorElement;
    this.qrCancelBtn = document.getElementById("authPageQrBackBtn");
    this.qrResetBtn = document.getElementById("authPageQrResetBtn");

    // Phone
    this.phoneInput = document.getElementById("authPagePhone") as HTMLInputElement;
    this.phoneSubmitBtn = document.getElementById("authPageRequestCodeBtn");
    this.phoneCancelBtn = document.getElementById("authPagePhoneBackBtn");
    this.phoneResetBtn = document.getElementById("authPagePhoneResetBtn");

    this.emailInput = document.getElementById("authPageEmail") as HTMLInputElement;
    this.emailSubmitBtn = document.getElementById("authPageSetEmailBtn");
    this.emailResetBtn = document.getElementById("authPageEmailResetBtn");
    this.emailCodeInput = document.getElementById("authPageEmailCode") as HTMLInputElement;
    this.emailCodeSubmitBtn = document.getElementById("authPageCheckEmailCodeBtn");
    this.emailCodeResetBtn = document.getElementById("authPageEmailCodeResetBtn");
    this.emailCodeQrBtn = document.getElementById("authPageEmailCodeQrBtn");
    this.emailDisplay = document.getElementById("authPageEmailDisplay");

    // Code
    this.codeInput = document.getElementById("authPageCode") as HTMLInputElement;
    this.codeSubmitBtn = document.getElementById("authPageCheckCodeBtn");
    this.codeCancelBtn = document.getElementById("authPageCodeBackBtn");
    this.codeResetBtn = document.getElementById("authPageCodeResetBtn");
    this.resendCodeBtn = document.getElementById("authPageResendCodeBtn");
    this.codeDeliveryInfo = document.getElementById("authPageCodeDeliveryInfo");
    this.codeQrBtn = document.getElementById("authPageCodeQrBtn");
    this.phoneDisplay = document.getElementById("authPagePhoneDisplay");

    // Password
    this.passwordInput = document.getElementById("authPagePassword") as HTMLInputElement;
    this.passwordSubmitBtn = document.getElementById("authPageCheckPasswordBtn");
    this.passwordCancelBtn = document.getElementById("authPagePasswordBackBtn");
    this.passwordResetBtn = document.getElementById("authPagePasswordResetBtn");
    this.passwordHint = document.getElementById("authPagePasswordHint");

    this.bindEvents();
  }

  private bindEvents(): void {
    // Step 0: выбор метода
    this.qrBtn?.addEventListener("click", () => this.startQrAuth());
    this.phoneBtn?.addEventListener("click", () => this.startPhoneAuth());


    // QR
    this.qrCancelBtn?.addEventListener("click", () => this.resetAuth());
    this.qrResetBtn?.addEventListener("click", () => this.resetAuth());

    // Phone
    this.phoneSubmitBtn?.addEventListener("click", () => this.submitPhone());
    this.phoneInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitPhone();
    });
    this.phoneCancelBtn?.addEventListener("click", () => this.resetAuth());
    this.phoneResetBtn?.addEventListener("click", () => {
      if (this.phoneInput) this.phoneInput.value = "";
      this.resetAuth();
    });

    // Email states are entered only when Telegram/TDLib emits them.
    this.emailSubmitBtn?.addEventListener("click", () => this.submitEmail());
    this.emailInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitEmail();
    });
    this.emailResetBtn?.addEventListener("click", () => this.resetAuth());
    this.emailCodeSubmitBtn?.addEventListener("click", () => this.submitEmailCode());
    this.emailCodeInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitEmailCode();
    });
    this.emailCodeResetBtn?.addEventListener("click", () => this.resetAuth());
    this.emailCodeQrBtn?.addEventListener("click", () => this.startQrFromCode());

    // Code
    this.codeSubmitBtn?.addEventListener("click", () => this.submitCode());
    this.codeInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitCode();
    });
    this.codeCancelBtn?.addEventListener("click", () => this.resetAuth());
    this.codeResetBtn?.addEventListener("click", () => {
      if (this.codeInput) this.codeInput.value = "";
      this.resetAuth();
    });
    this.resendCodeBtn?.addEventListener("click", () => this.resendCode());
    this.codeQrBtn?.addEventListener("click", () => this.startQrFromCode());

    // Password
    this.passwordSubmitBtn?.addEventListener("click", () => this.submitPassword());
    this.passwordInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitPassword();
    });
    this.passwordCancelBtn?.addEventListener("click", () => this.resetAuth());
    this.passwordResetBtn?.addEventListener("click", () => {
      if (this.passwordInput) this.passwordInput.value = "";
      this.resetAuth();
    });
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Проверить статус и показать authPage при необходимости.
   *
   * # Event-Driven Flow
   *
   * 1. Если есть сохранённый auth.json — API сессия есть, пропускаем TDLib auth.
   * 2. Запускаем event listener (ловит async ответ от receive loop).
   * 3. Вызываем tdlib_check_auth() — fire-and-forget getAuthorizationState.
   * 4. Показываем authPage.
   * 5. Receive loop пришлёт событие с актуальным статусом.
   */
  async checkAndShow(): Promise<void> {
    this._authResolved = false;
    authLogUI("UI  ", "checkAndShow: START");

    // Шаг 1: Проверяем сохранённую API сессию (auth.json)
    const auth = await store.load();
    authLogUI("UI  ", "checkAndShow: store.load()", auth ? `auth=${JSON.stringify(auth).slice(0, 100)}...` : "no auth");
    
    if (auth) {
      const tdlibReady = await this._isTdlibReady();
      authLogUI("UI  ", "checkAndShow: _isTdlibReady()", String(tdlibReady));
      
      if (tdlibReady) {
        this.log("TDLib already authorized (API session)", "info");
        authLogUI("UI  ", "checkAndShow: already authorized via store, resolving");
        setTdlibUserAuthorized(true);
        // Показываем UI сразу с сохранённым токеном (fast path)
        // v4.2: В фоне обновляем токен (если сохранённый протух на сервере).
        // _pairingInternal() вызовет resolveAuth() ещё раз — _authResolved
        // защищает от double вызова.
        // BUG-AUTH-NO-TGID: не даём unhandled rejection — если сохранённый
        // токен (напр. staging) недействителен на проде (401), показываем
        // понятную ошибку и не оставляем mainSection с currentTgId=0.
        this._doApiPairing().catch((e: any) => {
          if (e?.message?.startsWith("BANNED:")) {
            const banReason = e.message.replace("BANNED: ", "");
            this.showError(t("auth.banned", { reason: banReason }));
            this.log(`User is banned: ${banReason}`, "error");
            return;
          }
          authLogUI("UI  ", "fast path: _doApiPairing error", e?.message ?? String(e));
          console.warn("[TdlibAuthPage] fast path pairing error", e);
          this.showError(t("auth.api_pairing_error", { err: e?.message ?? String(e) }));
          this.log(`API pairing error: ${e?.message ?? String(e)}`, "error");
          this.setButtonsEnabled(true, this.codeResetBtn);
        });
        this.resolveAuth();
        return;
      }
    }

    // Шаг 2: Запускаем event listener (ловит async ответы от receive loop)
    authLogUI("UI  ", "checkAndShow: starting event listener");
    await this.startEventListener();

    // Шаг 3: Fire-and-forget запрос состояния авторизации
    // Receive loop ответит событием tdlib-auth-state.
    // BUG-FIRST-RUN-002: ждём получения Telegram-кред (Zero Secrets: их выдаёт
    // сервер) — иначе sidecar отвечает `-32000 TDLib runtime not initialized`,
    // и в релизе 0.3.0 это выглядело как красная ошибка ещё до входа.
    await credentialsReady();
    try {
      await invoke<string>("tdlib_check_auth");
      authLogUI("UI  ", "checkAndShow: tdlib_check_auth sent OK");
      this.log("Authorization state request sent", "debug");
    } catch (e: any) {
      authLogUI("UI  ", "checkAndShow: tdlib_check_auth ERROR", e?.message ?? String(e));
      this.log(`tdlib_check_auth error: ${e?.message ?? String(e)}`, "warn");
    }

    // Шаг 4: Показываем auth page (если уже ready — событие закроет её)
    authLogUI("UI  ", "checkAndShow: showing auth page");
    this.showAuthPage();
  }

  /**
   * Сброс авторизации.
   *
   * mode="reset"  — «сбросить застрявший вход» (кнопки «Скинути»): каталог
   *                 состояния СНОСИТСЯ — там нет данных сессии, терять нечего.
   * mode="logout" — «Выйти из аккаунта» (App.disconnect): сначала сетевой
   *                 auth.logOut (отзыв сессии; TDLib сохраняет future_auth_token
   *                 В КАТАЛОГЕ), затем restart ТОЙ ЖЕ БД без удаления каталога
   *                 (BUG-AUTH-CODE-006). → Повторный вход мгновенный, без кода
   *                 (доки «Future auth tokens»).
   *
   * @returns true — TDLib принял выход/сброс и экран входа показан;
   *          false — движок отказал, локальное состояние НЕ тронуто.
   *
   * # Fail-closed (BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001, 2026-10-31)
   *
   * Сначала TDLib, потом локальный сброс. Живой инцидент: мост Electron не
   * маршрутизировал `tdlib_logout` и отвечал `NOT_IMPLEMENTED`, но клиент всё
   * равно показывал экран входа, уже снеся свои флаги и токен. TDLib при этом
   * оставался в `authorizationStateReady` → любая попытка входа получала
   * `PHONE_AUTH_ALREADY_AUTHORIZED`: тупик без выхода, кроме перезапуска.
   * Теперь отказ движка = ничего не меняем и говорим об этом человеку.
   */
  async resetAuth(mode: "reset" | "logout" = "reset"): Promise<boolean> {
    try {
      await invoke(mode === "logout" ? "tdlib_logout" : "tdlib_reset_auth");
    } catch (e: any) {
      const err = e?.message ?? String(e);
      authLogUI("UI  ", `resetAuth(${mode}): TDLib отказал`, err);
      this.log(`TDLib reset error: ${err}`, "error");
      this.showError(t(mode === "logout" ? "auth.logout_failed" : "auth.reset_failed"));
      return false;
    }

    this.log(
      mode === "logout"
        ? "TDLib logOut complete (state dir KEPT for instant re-login)"
        : "TDLib auth reset complete",
      "info",
    );

    // Локальное состояние сбрасываем ТОЛЬКО после того, как TDLib подтвердил
    // выход/сброс — иначе экран входа окажется поверх живой сессии.
    this._pendingQrAfterReset = false;
    this._authResolved = false;
    this._expectingCode = false;
    // BUG-AUTO-START-001: сбрасываем авто-/start, чтобы после сброса/смены
    // аккаунта в том же окне новый юзер получил /start повторно.
    this._autoStartSentFor = null;
    // BUG-AUTH-FSM-READY v2: сбрасываем флаги и включаем поля ввода
    this._tdlibAuthorized = false;
    // FIX-AUTH-READY-TIMEOUT: сбрасываем флаг timeout-а при повторной авторизации
    this._submitErrorTimeout = false;
    setTdlibUserAuthorized(false);
    // BUG-AUTH-NO-TGID: сбрасываем зависший общий промис партия. Если authPair
    // завис (или вернёт ошибку после таймаута), _pairingPromise навсегда
    // остаётся pending и следующий _doApiPairing() упирается в "AWAIT existing" —
    // клиент застревает на окне авторизации. Принудительный сброс даёт
    // возможность начать вход заново.
    this._pairingPromise = null;
    this.stopQrPoll();
    this.stopEventListener();
    if (this.codeInput) this.codeInput.disabled = false;
    if (this.codeInput) this.codeInput.value = "";
    if (this.passwordInput) this.passwordInput.value = "";
    if (this.emailInput) this.emailInput.value = "";
    if (this.emailCodeInput) this.emailCodeInput.value = "";
    this.setButtonsEnabled(true, this.codeSubmitBtn, this.resendCodeBtn, this.codeResetBtn);

    // «Начать заново» — экран выбора метода, а не подвисший прошлый шаг.
    this.goToStep0();
    // После сброса запускаем listener и показываем страницу
    await this.startEventListener();
    // Гонка «restart TDLib ↔ регистрация слушателя»: движок мог прислать
    // wait_phone ещё до того, как мы подписались. Просим состояние явно —
    // ответ придёт событием и экран догонит фактический шаг.
    void invoke<string>("tdlib_check_auth").catch(() => undefined);
    this.showAuthPage();
    return true;
  }

  /** Освободить ресурсы */
  destroy(): void {
    this.stopQrPoll();
    this.stopEventListener();
  }

  // ──────────────────────────────────────────────
  // QR Auth
  // ──────────────────────────────────────────────

  private async startQrAuth(): Promise<void> {
    this.clearError();
    this.showStep(this.stepQr);
    this.hideQrImage();

    // Показываем placeholder
    if (this.qrPlaceholder) this.qrPlaceholder.style.display = "flex";

    try {
      // Fire-and-forget: запрос QR-кода
      // Receive loop эмитнет tdlib-auth-state { status: "qr_link", link: "..." }
      await invoke<{ status: string }>("tdlib_qr_login");
      this.log("QR code requested, waiting...", "info");

      // Добавляем polling как fallback (если событие не пришло)
      this.startQrPoll();
    } catch (e: any) {
      this.showError(t("auth.qr_request_error", { err: e?.message ?? String(e) }));
      this.goToStep0();
    }
  }

  private startQrPoll(): void {
    this.stopQrPoll();
    this._qrPollTimer = setInterval(async () => {
      try {
        const ready = await this._isTdlibReady();
        if (ready && !this._authResolved) {
          this.log("QR: TDLib ready (poll)", "info");
          setTdlibUserAuthorized(true);
          this.stopQrPoll();
          // BUG-AUTH-NO-TGID: НЕ показываем mainSection без API pairing.
          // resolveAuth() напрямую оставляет currentTgId=0 в App.ts, т.к.
          // событие tdlib-my-id запрашивается только внутри _doApiPairing()
          // (tdlib_get_my_id → getMe). UploadPage/DownloadPage получают
          // «нет tg_id». _doApiPairing() сам вызовет resolveAuth() после
          // установки Bearer-токена и обновления tg_id.
          this._doApiPairing().catch((e: any) => {
            if (e?.message?.startsWith("BANNED:")) {
              const banReason = e.message.replace("BANNED: ", "");
              this.showError(t("auth.banned", { reason: banReason }));
              this.log(`User is banned: ${banReason}`, "error");
              return;
            }
            authLogUI("UI  ", "QR poll: _doApiPairing non-ban error", e?.message ?? String(e));
            console.warn("[TdlibAuthPage] QR poll pairing error", e);
            this.showError(t("auth.api_pairing_error", { err: e?.message ?? String(e) }));
            this.log(`API pairing error: ${e?.message ?? String(e)}`, "error");
            // Включаем RESET кнопку, но НЕ codeSubmitBtn/resendCodeBtn
            this.setButtonsEnabled(true, this.codeResetBtn);
          });
        }
      } catch {
        // Игнорируем ошибки polling
      }
    }, QR_POLL_INTERVAL_MS);
  }

  private stopQrPoll(): void {
    if (this._qrPollTimer) {
      clearInterval(this._qrPollTimer);
      this._qrPollTimer = null;
    }
  }

  // ──────────────────────────────────────────────
  // Phone Auth
  // ──────────────────────────────────────────────

  private startPhoneAuth(): void {
    this.clearError();
    this.showStep(this.stepPhone);
    this.phoneInput?.focus();
  }

  private async submitPhone(): Promise<void> {
    const phone = this.phoneInput?.value.trim();
    authLogUI("UI  ", "submitPhone: user clicked", phone ? "phone supplied (redacted)" : "empty");
    
    if (!phone) {
      this.showError(t("auth.enter_phone"));
      return;
    }

    this.clearError();
    this.setButtonsEnabled(false, this.phoneSubmitBtn);
    this._expectingCode = false;

    try {
      await credentialsReady();
      authLogUI("UI  ", "submitPhone: starting TDLib-native phone auth", "phone and API hash redacted");
      // Fire-and-forget: ответ приходит через tdlib-auth-state { status: "wait_code" }
      await invoke<string>("tdlib_set_phone", { phone });
      // Чтобы сторож (30 с) мог выдать диагностику, если wait_code не пришёл.
      this._expectingCode = true;
      this.log("Phone number sent, waiting for TDLib auth state...", "info");
      this.startPhoneAuthWatchdog(phone);
    } catch (e: any) {
      const raw = typeof e?.message === "string" ? e.message : "AUTH_FAILED";
      authLogUI("UI  ", "submitPhone: TDLib refused phone auth", raw);
      // Движок сам отказал ДО отправки (например, TDLib ждёт код или ещё
      // стартует) — это не «ошибка сети», а факт: экран приводим к факту.
      const refusal = parsePhoneAuthGuard(raw);
      if (refusal) {
        this._onPhoneAuthGuardRefused(refusal);
        return;
      }
      this.showError(t("auth.error_prefix", { err: raw }));
      this.setButtonsEnabled(true, this.phoneSubmitBtn);
    }
  }

  /**
   * Отказ движка на вход по номеру (см. `PhoneAuthGuard`).
   *
   * Вместо сырого `400 Call to setAuthenticationPhoneNumber unexpected`
   * показываем, что фактически ждёт Telegram, и приводим экран к этому шагу:
   * `resync` перезапрашивает состояние, обработчик события рисует код/2FA/email.
   * Сброс не делаем сами — «танцу» reset+set_phone место только за кнопкой
   * «Сбросить» (иначе сжигаются лимиты доставки кода, BUG-AUTH-CODE-006).
   */
  private _onPhoneAuthGuardRefused(refusal: PhoneAuthGuard): void {
    authLogUI(
      "UI  ",
      "submitPhone: refused locally (no TDLib call)",
      `kind=${refusal.kind} state=${refusal.state || "none"}`,
    );
    this._expectingCode = false;
    this.stopPhoneAuthWatchdog();
    switch (refusal.kind) {
      case "already_authorized":
        // TDLib уже авторизован (сессия жива), но API-сессии у клиента нет.
        // Это не ошибка входа, а НЕЗАВЕРШЁННЫЙ вход: доводим его до конца
        // (getMe → authPair → resolveAuth). Раньше экран показывал тупик
        // «Авторизация уже выполнена. Нажмите Сбросить» — и человек, который
        // хотел просто войти, упирался в red-строку (BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001).
        this.log(t("auth.finishing_sign_in"), "info");
        void this._doApiPairing().catch((e: any) => {
          authLogUI("UI  ", "guard already_authorized: pairing failed", e?.message ?? String(e));
          this.showError(t("auth.api_pairing_error", { err: e?.message ?? String(e) }));
        });
        break;
      case "not_ready":
        this.showError(t("auth.phone_auth_not_ready"));
        break;
      case "auth_in_progress":
      default:
        this.showError(
          t(refusal.needsReset ? "auth.phone_auth_needs_reset" : "auth.phone_auth_in_progress"),
        );
        break;
    }
    if (refusal.resync) void this._resyncAuthStep();
    this.setButtonsEnabled(true, this.phoneSubmitBtn, this.phoneResetBtn);
  }

  /**
   * Перезапросить состояние авторизации: `getAuthorizationState` отвечает
   * событием `tdlib-auth-state`, и обработчик рисует ФАКТИЧЕСКИЙ шаг
   * (код/2FA/email/QR). Так экран догоняет TDLib без reset+set_phone.
   */
  private async _resyncAuthStep(): Promise<void> {
    try {
      await invoke<string>("tdlib_check_auth");
    } catch (e: any) {
      authLogUI("UI  ", "_resyncAuthStep: tdlib_check_auth failed", e?.message ?? String(e));
    }
  }

  private async submitEmail(): Promise<void> {
    const email = this.emailInput?.value.trim() ?? "";
    if (!email) {
      this.showError(t("auth.enter_email"));
      return;
    }
    this.clearError();
    this.setButtonsEnabled(false, this.emailSubmitBtn);
    try {
      await invoke<string>("tdlib_set_email", { email });
      // Do not retain the address in the form after handing it to TDLib.
      if (this.emailInput) this.emailInput.value = "";
    } catch (e: any) {
      const raw = typeof e?.message === "string" ? e.message : "AUTH_FAILED";
      // Движок отказывает ДО отправки, если TDLib не в шаге waitEmailAddress
      // (иначе был бы сырой `400 ... unexpected`).
      if (raw.startsWith("EMAIL_AUTH_ALREADY_AUTHORIZED")) {
        this.showError(t("auth.already_authorized"));
      } else if (raw.startsWith("EMAIL_AUTH_NOT_READY")) {
        this.showError(t("auth.email_auth_not_ready"));
        void this._resyncAuthStep();
      } else {
        this.showError(t("auth.error_prefix", { err: raw }));
      }
      this.setButtonsEnabled(true, this.emailSubmitBtn);
    }
  }

  private async submitEmailCode(): Promise<void> {
    const code = this.emailCodeInput?.value.trim() ?? "";
    if (!code) {
      this.showError(t("auth.enter_email_code"));
      return;
    }
    this.clearError();
    this.setButtonsEnabled(false, this.emailCodeSubmitBtn);
    try {
      await invoke<string>("tdlib_check_email_code", { code });
      if (this.emailCodeInput) this.emailCodeInput.value = "";
    } catch (e: any) {
      this.showError(t("auth.error_prefix", { err: e?.message ?? String(e) }));
      this.setButtonsEnabled(true, this.emailCodeSubmitBtn);
    }
  }

  private async submitCode(): Promise<void> {
    // BUG-AUTH-FSM-READY: TDLib уже в Ready — блокируем
    if (this._tdlibAuthorized) {
      authLogUI("UI  ", "submitCode: BLOCKED — TDLib already in Ready state");
      this.showError(t("auth.already_authorized"));
      return;
    }

    const code = this.codeInput?.value.trim();
    authLogUI("UI  ", "submitCode: user entered code", `len=${code?.length || 0}`);
    
    if (!code) {
      this.showError(t("auth.enter_code"));
      return;
    }

    this.clearError();
    this.setButtonsEnabled(false, this.codeSubmitBtn, this.resendCodeBtn);

    try {
      // Fire-and-forget: отправляем код подтверждения
      // Receive loop эмитнет:
      //   tdlib-auth-state { status: "ready" } — авторизация
      //   tdlib-auth-state { status: "wait_password", hint: "..." } — 2FA
      //   tdlib-auth-error — ошибка
      authLogUI("UI  ", "submitCode: invoke tdlib_check_code", `len=${code.length}`);
      await invoke<string>("tdlib_check_code", { code });
      authLogUI("UI  ", "submitCode: invoke returned OK (fire-and-forget)");
      this.log("Code sent, waiting...", "info");

      // FIX-AUTH-READY-TIMEOUT (Fix 5): если авторизация не завершилась
      // событием "ready" в течение 60 секунд — показываем ошибку с кнопкой
      // сброса. Без этого UI зависает на сообщении "Code sent, waiting..."
      // если TDLib отправил код, но статус Ready так и не пришёл (зависание
      // сети, зависание TDLib, отсутствие ответа от Telegram DC).
      if (!this._tdlibAuthorized) {
        authLogUI("UI  ", "submitCode: waiting for tdlib-auth-state 'ready' (60s timeout)");
        await this._waitForReadyEvent(60000);
      } else {
        authLogUI("UI  ", "submitCode: already authorized — ready event already received");
      }
    } catch (e: any) {
      // FIX-AUTH-READY-TIMEOUT: обрабатываем timeout отдельно
      if (e?.message?.startsWith("TIMEOUT_WAITING_READY")) {
        this._submitErrorTimeout = true;
        authLogUI("UI  ", "submitCode: ready-event TIMEOUT", e?.message);
        this.showError(t("auth.code_submit_timeout"));
        this.log("⏳ Ready wait timeout exceeded", "error");
        this.setButtonsEnabled(true, this.codeResetBtn);
      } else {
        this._submitErrorTimeout = false;
        authLogUI("UI  ", "submitCode: ERROR", e?.message ?? String(e));
        this.showError(t("auth.error_prefix", { err: e?.message ?? String(e) }));
        this.setButtonsEnabled(true, this.codeSubmitBtn, this.resendCodeBtn);
      }
    } finally {
      // Для timeout-кейса finally НЕ должен включать codeSubmitBtn —
      // только кодResetBtn (установлено в catch). Используем флаг.
      if (!this._submitErrorTimeout) {
        this.setButtonsEnabled(true, this.codeSubmitBtn, this.resendCodeBtn);
      }
      this._submitErrorTimeout = false; // сбрасываем для следующего вызова
    }
  }

  /**
   * FIX-AUTH-READY-TIMEOUT (Fix 5): Ждёт событие tdlib-auth-state { status: "ready" }
   * в течение указанного таймаута (мс). Если событие уже пришло — резолвит
   * сразу. Если таймаут истёк — отклоняет с ошибкой TIMEOUT_WAITING_READY.
   */
  private async _waitForReadyEvent(timeoutMs: number): Promise<void> {
    // Если уже авторизованы — событие "ready" уже обработано в startEventListener
    if (this._tdlibAuthorized) return;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`TIMEOUT_WAITING_READY after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event: Event<TdlibAuthStateEvent>) => {
        const { status } = event.payload;
        authLogUI("UI  ", "_waitForReadyEvent: tdlib-auth-state", `status=${status}`);
        if (status === "ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };

      listen<TdlibAuthStateEvent>("tdlib-auth-state", handler)
        .catch((e: any) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`_waitForReadyEvent listen failed: ${e?.message ?? e}`));
          }
        });
    });
  }

  /**
   * Повтор кода — ТОЛЬКО нативный resendAuthenticationCode (`tdlib_resend_code`).
   *
   * «Танец» reset_auth+set_phone (BUG-AUTH-013 v3) больше НЕ используется:
   * он возвращает тот же канал и сжигает лимиты доставки (BUG-AUTH-CODE-006).
   * Telegram сам решает, разрешён ли повтор: если нет (`next_code_type = null`),
   * движок ответит ошибкой — показываем честный текст и QR-выход.
   */
  private async resendCode(): Promise<void> {
    if (!this._canResendCode) return;
    this.clearError();
    this.setButtonsEnabled(false, this.codeSubmitBtn, this.resendCodeBtn);
    try {
      await invoke<string>("tdlib_resend_code");
      this.log("Native code resend requested, waiting...", "info");
      // Свежий wait_code обновит подсказку канала (code_type от Telegram).
    } catch (e: any) {
      authLogUI("UI  ", "resendCode: tdlib_resend_code FAILED", e?.message ?? String(e));
      this.showError(t("auth.resend_unavailable"));
      this.setButtonsEnabled(true, this.resendCodeBtn, this.codeQrBtn);
    }
  }

  /**
   * BUG-AUTH-CODE-005: уход на QR-вход с экрана кода.
   *
   * `requestQrCodeAuthentication` TDLib принимает только когда нет pending
   * auth query (запроса кода по номеру), поэтому сначала полный reset; сам QR
   * запрашивается на событии `wait_phone` (см. ветку `_pendingQrAfterReset`).
   */
  private async startQrFromCode(): Promise<void> {
    if (this.codeInput) this.codeInput.value = "";
    if (this.passwordInput) this.passwordInput.value = "";
    this.clearError();
    this.setButtonsEnabled(false, this.codeQrBtn, this.emailCodeQrBtn);
    this._pendingQrAfterReset = true;
    try {
      authLogUI("UI  ", "startQrFromCode: reset_auth before QR");
      await invoke<string>("tdlib_reset_auth");
    } catch (e: any) {
      this._pendingQrAfterReset = false;
      authLogUI("UI  ", "startQrFromCode: reset FAILED", e?.message ?? String(e));
      this.showError(t("auth.error_prefix", { err: e?.message ?? String(e) }));
      this.setButtonsEnabled(true, this.codeQrBtn, this.emailCodeQrBtn);
    }
  }

  /**
   * BUG-AUTH-CODE-005: показать КАНАЛ доставки кода прямо на экране кода.
   *
   * Канал выбирает Telegram, а не клиент. При
   * `authenticationCodeTypeTelegramMessage` код — служебное сообщение от
   * «Telegram» (777000) в ДРУГОЙ уже авторизованной сессии аккаунта
   * («can be viewed from another active session»), поэтому в этом окне он
   * появиться не может. Подсказка объясняет, где искать; рядом — кнопка
   * QR-входа, единственный путь, не зависящий от доставки кода.
   *
   * Кнопки «пусть придёт SMS» здесь нет намеренно: TDLib-метод
   * `reportAuthenticationCodeMissing` помечен «for official mobile
   * applications only» и принимает `mobile_network_code` (не номер телефона),
   * то есть из стороннего клиента он не даёт SMS (BUG-AUTH-CODE-004).
   */
  private showCodeDeliveryInfo(text: string): void {
    if (this.codeDeliveryInfo) {
      this.codeDeliveryInfo.textContent = text;
      this.codeDeliveryInfo.style.display = "block";
    }
    if (this.codeQrBtn) this.codeQrBtn.style.display = "inline-block";
  }

  private async submitPassword(): Promise<void> {
    const password = this.passwordInput?.value ?? "";
    if (!password) {
      this.showError(t("auth.enter_password"));
      return;
    }

    this.clearError();
    this.setButtonsEnabled(false, this.passwordSubmitBtn);

    try {
      // Fire-and-forget: отправляем 2FA пароль
      // Receive loop эмитнет tdlib-auth-state { status: "ready" } или tdlib-auth-error
      await invoke<string>("tdlib_check_password", { password });
      this.log("Password sent, waiting...", "info");
    } catch (e: any) {
      this.showError(t("auth.error_prefix", { err: e?.message ?? String(e) }));
    } finally {
      this.setButtonsEnabled(true, this.passwordSubmitBtn);
    }
  }

  // ──────────────────────────────────────────────
  // Safety timer management
  // ──────────────────────────────────────────────

  /**
   * BUG-AUTH-SAFETY-001: Очистить safety timer при получении первого auth state.
   * TDLib при холодном старте может занимать до 30с, а safety timer = 20с.
   * Если timer не очистить здесь — пользователь застревает на спиннере.
   */
  private _clearSafetyTimer(): void {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }
  }

  // ──────────────────────────────────────────────
  // Event listener (tdlib-auth-state + tdlib-auth-error)
  // ──────────────────────────────────────────────

  /**
   * Запустить слушатели событий от receive loop.
   *
   * Обрабатывает:
   * - `tdlib-auth-state` — все статусы авторизации
   * - `tdlib-auth-error` — ошибки авторизации с @extra-маршрутизацией
   */
  private async startEventListener(): Promise<void> {
    this.stopEventListener();

    try {
      // BUG-AUTH-SAFETY-001: очищаем safety timer ТОЛЬКО при получении первого
      // auth state события (в обработчике ниже). Не очищаем здесь — если
      // TDLib зависнет и НИКОГДА не пришлёт событие, safety timer должен
      // сработать и показать fallback UI, а не оставить пользоватца на
      // спиннере навсегда.
      // ── tdlib-auth-state: статусы авторизации ──
      this._unlistenAuthState = await listen<TdlibAuthStateEvent>(
        "tdlib-auth-state",
        async (event) => {
          const { status, link, code_type, hint } = event.payload;
          // BUG-AUTH-SAFETY-001: первое auth state событие — значит,
          // runtime откликнулся. Очищаем safety timer.
          this._clearSafetyTimer();
          const safePayload = status === "wait_email_code"
            ? { status, code_length: event.payload.code_length ?? 0 }
            : event.payload;
          const eventStr = JSON.stringify(safePayload);
          authLogUI("UI  ", `Event: tdlib-auth-state`, eventStr);
          this.log(`TDLib auth event: ${status}`, "info");
          if (status !== "wait_code") this.configureCodeResend(null, 0);

          switch (status) {
            case "ready":
              authLogUI("UI  ", "Event: ready — AUTH SUCCESS");
              if (!this._authResolved) {
                // BUG-AUTH-FSM-READY: TDLib Ready — блокируем отправку кода
                this._tdlibAuthorized = true;
                setTdlibUserAuthorized(true);
                this.stopQrPoll();
                // Показываем статус привязки API, скрываем поля ввода кода
                this.log("TDLib authorization complete. Pairing API...", "info");
                this.setButtonsEnabled(false, this.codeSubmitBtn, this.resendCodeBtn);
                if (this.codeInput) this.codeInput.disabled = true;
                // v4.3: _doApiPairing() сам вызывает resolveAuth() после
                // установки токена (api.setToken). .then() / .catch()
                // НЕ нужны для resolveAuth — это предотвращает race:
                //   ❌ SKIP guard → .then() fires → resolveAuth() без токена
                //   ✅ shared promise → ждём оригинал → resolveAuth() с токеном
                this._doApiPairing().catch((e: any) => {
                  // Обрабатываем ТОЛЬКО бан — resolveAuth уже вызван внутри
                  if (e?.message?.startsWith("BANNED:")) {
                    const banReason = e.message.replace("BANNED: ", "");
                    this.showError(t("auth.banned", { reason: banReason }));
                    this.log(`User is banned: ${banReason}`, "error");
                    return;
                  }
                  // FIX-AUTH-TIMEOUT (Fix 4): distinguish tdlib-my-id timeout
                  // from generic API pairing errors for clearer user messaging.
                  if (e?.message?.includes("Timeout waiting for tdlib-my-id")) {
                    authLogUI("UI  ", "Event: _doApiPairing TIMEOUT (tdlib-my-id)", e?.message);
                    console.warn("[TdlibAuthPage] _doApiPairing timeout", e);
                    this.showError(t("auth.pairing_timeout"));
                    this.log("⏳ Authorization confirmation timeout exceeded", "error");
                    this.setButtonsEnabled(true, this.codeResetBtn);
                    return;
                  }
                  // Небан-ошибка: resolveAuth() НЕ вызван (api.authPair упал).
                  // Показываем ошибку и предлагаем сброс, но НЕ даём ввести код снова.
                  authLogUI("UI  ", "Event: _doApiPairing non-ban error", e?.message ?? String(e));
                  console.warn("[TdlibAuthPage] _doApiPairing non-ban error", e);
                  this.showError(t("auth.api_pairing_error", { err: e?.message ?? String(e) }));
                  this.log(`API pairing error: ${e?.message ?? String(e)}`, "error");
                  // Включаем RESET кнопку, но НЕ codeSubmitBtn/resendCodeBtn
                  this.setButtonsEnabled(true, this.codeResetBtn);
                  // FIX-NON-BAN-API-ERROR: всё равно показываем main UI, чтобы
                  // пользователь не был застрял на auth page. mainSection делаем видимым,
                  // ошибка уже отображена через showError().
                  this.hideAuthPage();
                });
              }
              break;

            case "closed":
              authLogUI("UI  ", "Event: closed — auth session closed");
              // BUG-AUTH-FSM-READY: сбрасываем флаг при закрытии сессии
              this._tdlibAuthorized = false;
              setTdlibUserAuthorized(false);
              this._expectingCode = false;
              this.stopPhoneAuthWatchdog();
              this.showAuthPage();
              break;

            case "wait_phone":
              authLogUI("UI  ", "Event: wait_phone — awaiting method selection");
              this._expectingCode = false;
              this.stopPhoneAuthWatchdog();
              
              // BUG-AUTH-CODE-004: QR-вход после reset (кнопка «Войти по QR»
              // на экране кода). QR нельзя просить при висящем auth-запросе
              // по номеру, поэтому ждём именно wait_phone нового клиента.
              if (this._pendingQrAfterReset) {
                this._pendingQrAfterReset = false;
                authLogUI("UI  ", "Auto-QR: reset done, requesting QR");
                this.startQrAuth().catch((e: any) => {
                  authLogUI("UI  ", "Auto-QR: startQrAuth FAILED", e?.message ?? String(e));
                  this.showError(t("auth.qr_request_error", { err: e?.message ?? String(e) }));
                  this.goToStep0();
                });
                break;
              }

              break;

            case "wait_email_address":
              this._expectingCode = false;
              this.stopPhoneAuthWatchdog();
              this.clearError();
              this.showStep(this.stepEmailAddress);
              this.emailInput?.focus();
              break;

            case "wait_email_code":
              this._expectingCode = false;
              this.stopPhoneAuthWatchdog();
              this.clearError();
              if (this.emailDisplay) {
                this.emailDisplay.textContent = event.payload.email_address_pattern ?? "";
              }
              if (this.emailCodeInput) {
                this.emailCodeInput.value = "";
                const length = event.payload.code_length ?? 0;
                if (length > 0) this.emailCodeInput.maxLength = length;
                else this.emailCodeInput.removeAttribute("maxlength");
              }
              this.setButtonsEnabled(true, this.emailCodeSubmitBtn);
              this.showStep(this.stepEmailCode);
              this.emailCodeInput?.focus();
              break;

            case "qr_link":
              authLogUI("UI  ", "Event: qr_link", link ? `link=${link.slice(0, 50)}...` : "no link");
              if (link) {
                this.showStep(this.stepQr);
                this.showQrImage(link);
                this.log("QR code received, waiting for scanning...", "info");
              }
              break;

            case "wait_code":
              authLogUI("UI  ", "Event: wait_code", `code_type=${code_type ?? "unknown"} next=${event.payload.next_code_type ?? "none"}`);
              // Показываем сообщение о типе кода
              const codeMsg = this._formatCodeTypeMessage(code_type ?? "");

              // BUG-AUTH-FSM-READY v2: включаем поля ввода (сброшены после Ready/reset)
              if (this.codeInput) {
                this.codeInput.disabled = false;
                this.codeInput.inputMode = "numeric";
              }
              this.setButtonsEnabled(
                true,
                this.codeSubmitBtn,
                this.codeQrBtn,
              );
              this.configureCodeResend(event.payload.next_code_type, event.payload.timeout ?? 0);

              // Переключаемся на ввод кода
              this.showStep(this.stepCode);
              // BUG-AUTH-CODE-005: канал доставки — ВИДИМО на экране кода
              // (и куда идти, если этим каналом код не пришёл — QR).
              this.showCodeDeliveryInfo(codeMsg);
              this.codeInput?.focus();
              this._expectingCode = false;
              this.stopPhoneAuthWatchdog();
              break;

            case "wait_password":
              authLogUI("UI  ", "Event: wait_password", `hint=${hint ?? "(no hint)"}`);
              this.showPasswordHint(hint ?? "");
              this.showStep(this.stepPassword);
              this.passwordInput?.focus();
              break;

            default:
              authLogUI("UI  ", "Event: UNKNOWN STATUS", status);
              this.log(`Unhandled status: ${status}`, "debug");
          }
        },
      );

      // ── tdlib-auth-error: ошибки авторизации ──
      this._unlistenAuthError = await listen<TdlibAuthErrorEvent>(
        "tdlib-auth-error",
        (event) => {
          const { extra, message, code } = event.payload;
          const emailAuthError = extra === "set_email_address" || extra === "check_email_code";
          const safeMessage = emailAuthError ? "(email authorization details redacted)" : message;
          authLogUI("UI  ", `Event: tdlib-auth-error`, `extra=${extra} message=${safeMessage} code=${code}`);
          const errorMsg = t("auth.error_code", { extra, message: safeMessage, code });
          this.log(`TDLib auth error: ${errorMsg}`, "error");

          // BUG-AUTH-SAFETY-001: ошибка авторизации — очищаем safety timer,
          // иначе он сработает позже и перезапишет UI сообщением о таймауте.
          this._clearSafetyTimer();

          // Показываем ошибку пользователю
          this.showError(this._translateError(message, code));
          this._expectingCode = false;
          this.stopPhoneAuthWatchdog();

          // Страховка: если TDLib всё же ответил «unexpected» на set_phone
          // (гонка состояния), экран обязан догнать фактический шаг, а не
          // остаться на форме номера с красной строкой техотчёта.
          if (extra === "set_phone" && message.toLowerCase().includes("unexpected")) {
            void this._resyncAuthStep();
          }

          // Включаем кнопки, если они были выключены
          this.setButtonsEnabled(true, this.phoneSubmitBtn, this.codeSubmitBtn, this.passwordSubmitBtn,
            this.emailSubmitBtn, this.emailCodeSubmitBtn);
        },
      );

      // ── tdlib-connection-state: диагностика сетевого подключения ──
      // BUG-AUTH-WIN32-002 (investigation): показываем состояние сети TDLib
      // пользователю. Критически важно для диагностики проблем "код не приходит"
      // на Windows — если TDLib не может соединиться с Telegram DC, пользователь
      // увидит "Waiting for network..." вместо бесконечного ожидания.
      this._unlistenConnectionState = await listen<TdlibConnectionStateEvent>(
        "tdlib-connection-state",
        (event) => {
          const { state } = event.payload;
          this._lastConnectionState = state || "unknown";
          authLogUI("UI  ", `Event: tdlib-connection-state`, state);
          this.log(`🌐 ${state}`, "info");
        },
      );

      this.log("TDLib auth event listeners started", "debug");
    } catch (e: any) {
      this.log(`Failed to listen events: ${e?.message ?? String(e)}`, "warn");
    }
  }

  private stopEventListener(): void {
    if (this._unlistenAuthState) {
      this._unlistenAuthState();
      this._unlistenAuthState = null;
    }
    if (this._unlistenAuthError) {
      this._unlistenAuthError();
      this._unlistenAuthError = null;
    }
    if (this._unlistenConnectionState) {
      this._unlistenConnectionState();
      this._unlistenConnectionState = null;
    }
    this.stopPhoneAuthWatchdog();
  }

  // ──────────────────────────────────────────────
  // UI helpers
  // ──────────────────────────────────────────────

  /** Показать страницу auth (скрыть mainSection) */
  private showAuthPage(): void {
    // BUG-WHITESCREEN-001: Скрываем loading overlay и показываем step0
    const loadingOverlay = document.getElementById("authLoadingOverlay");
    if (loadingOverlay) loadingOverlay.style.display = "none";
    if (this.step0) this.step0.style.display = "";

    // Сбрасываем inline display (мог быть установлен PrerequisitesPage.render())
    this.authPage.style.display = "";
    this.mainSection.style.display = "none";
    this.authPage.classList.add("visible");
    this.goToStep0();
  }

  /** Скрыть страницу auth, показать mainSection */
  private hideAuthPage(): void {
    // BUG-WHITESCREEN-001: authPage теперь display:flex по умолчанию — нужно явно скрыть
    this.authPage.classList.remove("visible");
    this.authPage.style.display = "none";
    this.mainSection.style.display = "block";
  }

  /** Показать конкретный step */
  private showStep(step: HTMLElement): void {
    [this.step0, this.stepQr, this.stepPhone, this.stepEmailAddress, this.stepEmailCode,
      this.stepCode, this.stepPassword].forEach((s) => {
      s.classList.remove("active");
    });
    step.classList.add("active");
  }

  /** Вернуться к выбору метода */
  private goToStep0(): void {
    this.stopQrPoll();
    this.stopPhoneAuthWatchdog();
    this._expectingCode = false;
    this.clearError();
    // BUG-AUTH-CODE-004: экран кода покинут — убираем подсказку канала и выходы.
    if (this.codeDeliveryInfo) this.codeDeliveryInfo.style.display = "none";
    this.configureCodeResend(null, 0);
    if (this.emailInput) this.emailInput.value = "";
    if (this.emailCodeInput) this.emailCodeInput.value = "";
    if (this.emailDisplay) this.emailDisplay.textContent = "";
    if (this.codeQrBtn) this.codeQrBtn.style.display = "none";
    this.showStep(this.step0);
    // BUG-AUTH-012: Включаем все кнопки, которые могли быть отключены в ходе авторизации
    // (submitPhone отключает phoneSubmitBtn, submitCode отключает codeSubmitBtn/resendCodeBtn,
    //  submitPassword отключает passwordSubmitBtn, а resetAuth не включает их обратно)
    this.setButtonsEnabled(true, this.phoneSubmitBtn, this.codeSubmitBtn, this.resendCodeBtn,
        this.passwordSubmitBtn, this.qrBtn, this.phoneBtn, this.emailSubmitBtn, this.emailCodeSubmitBtn);
  }

  /** Show resend only when Telegram supplied a next delivery method. */
  private configureCodeResend(nextCodeType: string | null | undefined, timeoutSeconds: number): void {
    if (this._resendEnableTimer) clearTimeout(this._resendEnableTimer);
    this._resendEnableTimer = null;
    this._canResendCode = Boolean(nextCodeType);
    if (!this.resendCodeBtn) return;

    this.resendCodeBtn.style.display = this._canResendCode ? "inline-block" : "none";
    const delayMs = Math.max(0, timeoutSeconds) * 1000;
    (this.resendCodeBtn as HTMLButtonElement).disabled = !this._canResendCode || delayMs > 0;
    if (this._canResendCode && delayMs > 0) {
      this._resendEnableTimer = setTimeout(() => {
        this._resendEnableTimer = null;
        if (this._canResendCode && this.resendCodeBtn) {
          (this.resendCodeBtn as HTMLButtonElement).disabled = false;
        }
      }, delayMs);
    }
  }

  /** Показать QR изображение (локальная генерация, без сети) */
  private showQrImage(link: string): void {
    let qrUrl = "";
    try {
      qrUrl = qrDataUrl(link, 4, 8);
    } catch (e: any) {
      // Не срываем авторизацию: ссылка ниже всё равно даст ручной вход.
      authLogUI("UI  ", "showQrImage: local QR generation failed", String(e));
    }
    if (this.qrImage) {
      this.qrImage.src = qrUrl;
      this.qrImage.style.display = qrUrl ? "block" : "none";
    }
    if (this.qrPlaceholder) this.qrPlaceholder.style.display = "none";
    if (this.qrLink) {
      this.qrLink.href = link;
      this.qrLink.textContent = link;
    }
  }

  /** Скрыть QR изображение */
  private hideQrImage(): void {
    if (this.qrImage) {
      this.qrImage.style.display = "none";
      this.qrImage.src = "";
    }
    if (this.qrLink) {
      this.qrLink.href = "#";
      this.qrLink.textContent = "";
    }
  }

  /** Показать подсказку для 2FA пароля */
  private showPasswordHint(hint: string): void {
    if (this.passwordHint) {
      this.passwordHint.textContent = hint
        ? t("auth.password_hint", { hint })
        : t("auth.enter_password");
      this.passwordHint.style.display = "block";
    }
  }

  /** Показать ошибку */
  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.style.display = "block";
  }

  /** Очистить ошибку */
  private clearError(): void {
    this.errorEl.textContent = "";
    this.errorEl.style.display = "none";
  }

  /** Показать статус */
  private log(msg: string, type: string = "info"): void {
    this.statusEl.textContent = msg;
    console.log(`[TdlibAuthPage] ${type}: ${msg}`);
  }

  /** Stop phone auth watchdog if it is active. */
  private stopPhoneAuthWatchdog(): void {
    if (this._phoneAuthWatchdogTimer) {
      clearTimeout(this._phoneAuthWatchdogTimer);
      this._phoneAuthWatchdogTimer = null;
    }
  }

  /**
   * Диагностика «код не приходит» (BUG-AUTH-CODE-002).
   *
   * Windows/Linux production: `tdlib_set_phone` — fire-and-forget. Если
   * `authorizationStateWaitCode` не пришёл, показываем ГДЕ лежат логи и что из
   * них нужно. Каталог логов запрашиваем у main (`engine.sidecarStatus` →
   * `log_dir`): реальный путь — `<userData>/logs` (`%APPDATA%\ARTEL` /
   * `~/.config/ARTEL`), файл — `tdlib.log`. Хардкод `%LOCALAPPDATA%\...` и
   * имена `auth_debug.log/tdlib_trace.log/...` были наследством Tauri-линии и
   * уводили разбор инцидента в пустой каталог.
   */
  private startPhoneAuthWatchdog(phone: string): void {
    this.stopPhoneAuthWatchdog();
    this._phoneAuthWatchdogTimer = setTimeout(() => {
      void this.onPhoneAuthWatchdogFire(phone);
    }, 30000);
  }

  /** Тело сторожа (async: каталог логов приходит от main). */
  private async onPhoneAuthWatchdogFire(phone: string): Promise<void> {
    if (!this._expectingCode) return;

    const logDir = await this.resolveAuthLogDir();
    if (!this._expectingCode) return; // за время запроса код мог прийти

    authLogUI(
      "UI  ",
      "phone-auth-watchdog: wait_code timeout — предлагаем QR",
      `phone=${phone} last_connection_state=${this._lastConnectionState} log_dir=${logDir ?? "(main не ответил)"} files=${authDiagFilesList()}`,
    );

    // Код не пришёл за 30 с — предлагаем пользователю авторизоваться по QR-коду.
    this.showError(t("auth.phone_qr_timeout"));
    this.setButtonsEnabled(true, this.phoneSubmitBtn, this.phoneResetBtn);
  }

  /**
   * Каталог логов из main (кэш на сессию). `null` — мост недоступен:
   * подсказку без пути лучше, чем с выдуманным (BUG-AUTH-CODE-002).
   */
  private async resolveAuthLogDir(): Promise<string | null> {
    if (this._authLogDir !== undefined) return this._authLogDir;
    try {
      const status = await invoke<{ log_dir?: string }>("engine.sidecarStatus", {});
      this._authLogDir = status?.log_dir ?? null;
    } catch (e: any) {
      authLogUI("UI  ", "resolveAuthLogDir: engine.sidecarStatus failed", e?.message ?? String(e));
      this._authLogDir = null;
    }
    return this._authLogDir;
  }

  /** Включить/выключить кнопки */
  private setButtonsEnabled(enabled: boolean, ...buttons: (HTMLElement | null)[]): void {
    buttons.forEach((btn) => {
      if (btn) (btn as HTMLButtonElement).disabled = !enabled;
    });
  }

  /** Форматировать сообщение о типе кода */
  private _formatCodeTypeMessage(codeType: string): string {
    switch (codeType) {
      case "authenticationCodeTypeTelegramMessage":
        return t("auth.code_telegram");
      case "authenticationCodeTypeSms":
        return t("auth.code_sms");
      case "authenticationCodeTypeCall":
        return t("auth.code_call");
      case "authenticationCodeTypeFlashCall":
        return t("auth.code_flash");
      case "authenticationCodeTypeMissedCall":
        return t("auth.code_missed");
      case "authenticationCodeTypeFragment":
        return t("auth.code_fragment");
      default:
        return t("auth.code_default");
    }
  }

  /** Перевести ошибку TDLib в человеческое сообщение */
  private _translateError(message: string, code: number): string {
    // TDLib ошибки для авторизации
    if (code === 400) {
      if (message.includes("PHONE_NUMBER_INVALID")) return t("auth.err_phone_invalid");
      if (message.includes("PHONE_CODE_INVALID")) return t("auth.err_code_invalid");
      if (message.includes("PASSWORD_HASH_INVALID")) return t("auth.err_password_invalid");
      if (message.includes("PHONE_CODE_EXPIRED")) return t("auth.err_code_expired");
      // «Call to setAuthenticationPhoneNumber unexpected» и родственные: TDLib
      // получил команду не в том шаге входа. Причина для мастера — «ждём другой
      // шаг», а не текст метода TDLib.
      if (message.toLowerCase().includes("unexpected")) return t("auth.err_unexpected_step");
    }
    if (code === 429) {
      return t("auth.err_too_many");
    }
    if (code === 406) {
      return t("auth.err_406");
    }
    return t("auth.err_generic", { code, message });
  }

  // ──────────────────────────────────────────────
  // Completion
  // ──────────────────────────────────────────────

  /**
   * API pairing после TDLib-ready.
   *
   * v3.7: После успешной TDLib-авторизации (status="ready") нужно:
   * 1. Получить tg_id через TDLib getMe
   * 2. Зарегистрировать DesktopSession на сервере (authPair)
   * 3. Сохранить auth.json (access_token, refresh_token, tg_id)
   * 4. Установить Bearer-токен для API-запросов
   *
   * Без этого Upload/Download не работают (401 Unauthorized + "нет tg_id").
   * Search работает, т.к. не требует Bearer-токена.
   *
   *
   * v4.2: shared promise — второй caller ждёт первый, не резолвит раньше времени.
   * v4.3: api.setToken() перед store.save() — токен всегда устанавливается,
   *       даже если save() падает (write_auth_file не зарегистрирован в Rust).
   */
  private async _doApiPairing(options: { deferResolveAuth?: boolean } = {}): Promise<void> {
    // BUG-AUTH-015 v2: shared promise — если уже выполняется, ждём результат
    if (this._pairingPromise) {
      authLogUI("UI  ", "_doApiPairing: AWAIT existing — waiting for the first one to finish", "warn");
      console.warn("[TdlibAuthPage] _doApiPairing: awaiting existing pairing");
      return this._pairingPromise;
    }

    authLogUI("UI  ", "_doApiPairing: START (shared promise)");

    this._pairingPromise = this._pairingInternal(options.deferResolveAuth === true);
    try {
      return await this._pairingPromise;
    } finally {
      this._pairingPromise = null;
      authLogUI("UI  ", "_doApiPairing: PROMISE CLEARED");
    }
  }

  /**
   * Внутренняя реализация _doApiPairing — гарантирует что:
   * 1. Токен устанавливается ДО сохранения в файл
   * 2. store.save() не блокирует flow при ошибке
   * 3. resolveAuth() вызывается только после установки токена
   */
  private async _pairingInternal(deferResolveAuth = false): Promise<void> {
    authLogUI("UI  ", "_pairingInternal: START");

    // ── Шаг 1: Устанавливаем слушатель tdlib-my-id ДО отправки getMe ──
    const myIdEvent = await new Promise<TdlibMyIdEvent>((resolve, reject) => {
      // Таймаут 15 секунд
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for tdlib-my-id (15s)"));
      }, 15000);

      // Сначала устанавливаем слушатель (иначе race condition)
      listen<TdlibMyIdEvent>("tdlib-my-id", (event) => {
        clearTimeout(timer);
        authLogUI("UI  ", "_doApiPairing: got tdlib-my-id", JSON.stringify(event.payload));
        resolve(event.payload);
      }).then((unlisten) => {
        // Слушатель установлен — теперь можно послать getMe
        authLogUI("UI  ", "_doApiPairing: listener registered, sending tdlib_get_my_id");
        invoke("tdlib_get_my_id").catch((e: any) => {
          clearTimeout(timer);
          unlisten();
          reject(new Error(`tdlib_get_my_id failed: ${e?.message ?? e}`));
        });
      }).catch((e: any) => {
        clearTimeout(timer);
        reject(new Error(`listen failed: ${e?.message ?? e}`));
      });
    });

    // ── Шаг 2: Формируем display name ──
    const displayName = myIdEvent.username ||
      [myIdEvent.first_name, myIdEvent.last_name].filter(Boolean).join(" ").trim() ||
      `user_${myIdEvent.tg_id}`;

    // ── Шаг 3: Создаём API-сессию на сервере ──
    authLogUI("UI  ", "_doApiPairing: calling api.authPair", `tg_id=${myIdEvent.tg_id}`);
    let authResult;
    try {
      // BUG-PROD-SYNC-002: передаём профиль из TDLib getMe — сервер создаёт/
      // обогащает строку users (появляется в админке с именем).
      authResult = await api.authPair(myIdEvent.tg_id, {
        username: myIdEvent.username?.trim() || null,
        first_name: myIdEvent.first_name?.trim() || null,
      });
    } catch (e: any) {
      // Проверяем, не является ли ошибка баном (HTTP 403 с is_banned)
      if (e?.is_banned || (e?.message && e.message.includes("banned"))) {
        const banReason = e?.ban_reason || e?.message || "SPAM UPLOAD";
        authLogUI("UI  ", `_doApiPairing: USER BANNED — ${banReason}`, "error");
        this.showError(t("auth.banned", { reason: banReason }));
        this.log(`User is banned: ${banReason}`, "error");
        // Не прерываем TDLib сессию, но не даём войти в клиент
        throw new Error(`BANNED: ${banReason}`);
      }
      throw e; // перебрасываем оригинальную ошибку
    }
    authLogUI("UI  ", "_pairingInternal: authPair OK", `access_token=${authResult.access_token.slice(0, 20)}...`);

    // ── Шаг 3.5: Проверка на бан (для случая, если сервер вернул 200 с is_banned) ──
    if (authResult.is_banned) {
      const banReason = authResult.ban_reason || "SPAM UPLOAD";
      authLogUI("UI  ", `_pairingInternal: USER BANNED (200) — ${banReason}`, "error");
      this.showError(t("auth.banned", { reason: banReason }));
      this.log(`User is banned: ${banReason}`, "error");
      throw new Error(`BANNED: ${banReason}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Шаг 4: Устанавливаем Bearer-токен ДО сохранения в файл
    // ═══════════════════════════════════════════════════════════════════
    if (!authResult.access_token) {
      // BUG-AUTH-015: защита от undefined access_token
      authLogUI("UI  ", "!!! _pairingInternal: access_token is EMPTY/UNDEFINED", "error");
      console.warn("[TdlibAuthPage] _pairingInternal: access_token is empty/undefined");
    } else {
      api.setToken(authResult.access_token);
      authLogUI("UI  ", "_pairingInternal: api.setToken OK", `token=${authResult.access_token.slice(0, 20)}...`);
      console.debug("[TdlibAuthPage] _pairingInternal: api.setToken OK, tg_id=" + myIdEvent.tg_id);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Шаг 5: Сохраняем в локальное хранилище (auth.json) — best-effort
    // ═══════════════════════════════════════════════════════════════════
    // BUG-AUTH-015: Rust-команда write_auth_file может отсутствовать.
    // Если save() падает — это НЕ критично, токен уже установлен.
    try {
      await store.save({
        access_token: authResult.access_token,
        refresh_token: authResult.refresh_token,
        tg_id: myIdEvent.tg_id,
        username: displayName,
        // SP-07 S-2: username бота — по нему маяк находит описание бота в TDLib.
        bot_username: authResult.pm_bot_username ?? undefined,
      });
      authLogUI("UI  ", "_pairingInternal: store.save OK");
    } catch (e: any) {
      authLogUI("UI  ", "_pairingInternal: store.save FAILED (non-fatal)", e?.message ?? String(e));
      console.warn("[TdlibAuthPage] _pairingInternal: store.save failed", e);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Шаг 6: Join storage chat — УДАЛЁН (инцидент Vault 2026-09-17).
    // Юзер НЕ член приватного каталога: сервер больше не выдаёт инвайт/ID
    // (гейт tests_upload/test_no_invite_leak.py). Скачивание — через
    // PM-доставку Host-Mediation (ADR).
    // ═══════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════
    // Шаг 6.5: Auto-/start — Host-Mediation (ADR 2026-09-02)
    // ═══════════════════════════════════════════════════════════════════
    // Bot API не позволяет боту инициировать диалог — инициатива всегда
    // за юзером. Поэтому Desktop сам открывает ЛС с ботом (createPrivateChat)
    // и отправляет /start, создавая канал «бот ↔ юзер», который
    // Host-Mediation использует для upload (resolve_pm_chat_id).
    // Best-effort: ошибка не блокирует вход; дубли /start безвредны (idempotent),
    // а _autoStartSentFor ограничивает отправку одним разом на tg_id.
    if (authResult.pm_bot_chat_id) {
      const botUserId = authResult.pm_bot_chat_id;
      if (this._autoStartSentFor !== myIdEvent.tg_id) {
        this._autoStartSentFor = myIdEvent.tg_id;
        authLogUI("UI  ", `_pairingInternal: auto-start bot PM`, `tg_id=${myIdEvent.tg_id} bot_user_id=${botUserId}`);
        try {
          const started = await invoke<string>("tdlib_send_bot_start", {
            botUserId,
            botUsername: authResult.pm_bot_username ?? undefined,
          });
          authLogUI("UI  ", `_pairingInternal: auto-start OK`, started);
          this.log(`Bot enabled automatically (PM opened)`, "info");
        } catch (e: any) {
          authLogUI("UI  ", `_pairingInternal: auto-start failed (non-fatal)`, e?.message ?? String(e));
          this.log(`Warning: bot auto-start failed — ${e?.message ?? e}`, "warn");
        }
      } else {
        authLogUI("UI  ", `_pairingInternal: auto-start already sent for tg_id=${myIdEvent.tg_id}, skipping`);
      }
    } else {
        authLogUI("UI  ", "_pairingInternal: pm_bot_chat_id not provided (host off / non-host)");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Шаг 7: resolveAuth — завжди викликаємо, joinStorageChat не обов'язковий
    // ═══════════════════════════════════════════════════════════════════
    if (!deferResolveAuth) this.resolveAuth();
    authLogUI("UI  ", `_pairingInternal: COMPLETE (storage join removed — Vault incident 2026-09-17)`, `tg_id=${myIdEvent.tg_id}`);
    this.log(`API session created: tg_id=${myIdEvent.tg_id}`, "info");
  }

  /** Успешная авторизация — скрываем authPage, вызываем callback */
  private resolveAuth(): void {
    if (this._authResolved) return;
    this._authResolved = true;

    // BUG-AUTH-SAFETY-001: очищаем safety timer при успешной авторизации
    this._clearSafetyTimer();
    this.stopQrPoll();
    this.stopEventListener();
    this.hideAuthPage();
    this.onAuthenticated();
  }

  /** Проверить готовность TDLib runtime */
  private async _isTdlibReady(): Promise<boolean> {
    try {
      return await invoke<boolean>("tdlib_is_ready");
    } catch {
      return false;
    }
  }
}
