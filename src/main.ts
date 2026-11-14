/**
 * Firmware Desktop Client — Entry Point
 *
 * Инициализация Tauri-плагинов, затем запуск TDLib runtime и основного UI.
 */

import { invoke } from "@tauri-apps/api/core";
import { applyStaticI18n, bindLangSwitcher, t } from "./i18n";
import { App } from "./ui/App";
import { startUpdateWatch } from "./ui/UpdateGate";
import { api } from "./api";
import { store } from "./store";
import { setCredentialsSettled } from "./credsState";
import {
  createBeaconState,
  findFallbackServerUrl,
  registerBeaconAttempt,
  shouldAttemptBeacon,
} from "./ui/BeaconPolicy";

/**
 * Telegram API credentials.
 *
 * Zero Secrets in Binary: кредов в билде НЕТ (гейт `verify_no_secrets`).
 * Единственный источник — сервер:
 *   • повторный запуск — сохранённая DesktopSession (auth.json) → GET /api/client-config;
 *   • свежая установка — POST /desktop/auth/credentials (pair-код удалён 2026-09-22).
 * Пока креды не получены, TDLib не стартует и показывается видимая ошибка
 * с кнопкой повтора (не молча — BUG-AUTH-WIN32-001).
 */
let TELEGRAM_API_ID = 0;
let TELEGRAM_API_HASH = "";

/** Промис первой попытки получить креды (отдаётся в TdlibAuthPage, см. credsState.ts). */
let credentialsSettled: Promise<void> = Promise.resolve();

/**
 * SP-07 S-2 — Silent Beacon: состояние backoff-политики поиска резервного адреса.
 * Живёт в рамках процесса: не чаще 3 попыток за сессию (см. BeaconPolicy).
 */
let beaconState = createBeaconState();

/**
 * Резервный адрес сервера, когда fetch не достучался до текущего (SP-07 S-2).
 *
 * Порядок: локальный кеш `userData/config.json` (мгновенно, без сети) → маяк в
 * описании бота через TDLib (второй, независимый по транспорту контур).
 * Ноль сообщений в PM (D-006); любая неудача → `null` (fail-open: остаёмся на
 * текущем адресе). Хук вызывается только при СБОЕ ТРАНСПОРТА (см. ApiClient).
 */
async function resolveFallbackServerUrl(_failedUrl: string): Promise<string | null> {
  const now = Date.now();
  if (!shouldAttemptBeacon(beaconState, now)) {
    console.warn("[beacon] attempt skipped (backoff policy)");
    return null;
  }
  beaconState = registerBeaconAttempt(beaconState, now);

  const cached = await store.loadServerUrlCache();
  const result = await findFallbackServerUrl({
    cached,
    readDescription: async () => {
      const botUsername = store.get()?.bot_username ?? "";
      const res = await invoke<{ description?: string }>("tdlib_get_bot_description", {
        username: botUsername || undefined,
      });
      return res?.description ?? "";
    },
  });
  if (!result) return null;

  if (result.source === "beacon") {
    await store.saveServerUrlCache({
      server_url: result.url,
      beacon_ts: result.ts,
      beacon_kid: result.kid,
    });
  }
  console.warn(`[beacon] server url resolved from ${result.source}: ${result.url}`);
  return result.url;
}

/** Подключить хук переключения адреса к ApiClient (вызывается один раз при старте). */
function installBeaconFailover(): void {
  api.onServerUnreachable = resolveFallbackServerUrl;
}

async function main() {
  // BUG-WHITESCREEN-001: Safety timeout — если через 20 секунд ничего не показалось,
  // форсируем показ auth page с сообщением об ошибке.
  const SAFETY_TIMEOUT_MS = 20_000;
  let safetyFired = false;
  const safetyTimer = setTimeout(() => {
    safetyFired = true;
    console.error("[main] SAFETY TIMEOUT: initialization stalled, showing fallback UI");
    const loadingEl = document.getElementById("authLoadingOverlay");
    if (loadingEl) {
      loadingEl.innerHTML = `
        <div style="text-align:center; padding:20px 0;">
          <p style="font-size:24px; margin-bottom:12px;">⚠️</p>
          <p style="font-size:14px; color:var(--text-dim); margin-bottom:8px;">${escapeHtml(t("main.load_failed"))}</p>
          <p style="font-size:12px; color:var(--text-dim);">${escapeHtml(t("main.load_failed_hint"))}</p>
        </div>`;
    }
    const authPage = document.getElementById("authPage");
    if (authPage) authPage.style.display = "flex";
  }, SAFETY_TIMEOUT_MS);

  try {
    // 0. i18n: применяем сохранённый язык к статике и привязываем переключатель UK|RU|EN
    applyStaticI18n();
    bindLangSwitcher();

    // 0b. SP-07 S-2: резервный адрес сервера (кеш config.json → маяк в описании бота).
    installBeaconFailover();

    // 1. Запускаем TDLib runtime в user auth mode — БЕЗ БЛОКИРОВКИ UI
    //    startTdlibRuntime() может занимать до 30с (TDLib init + 1st auth state).
    //    Если делать await — пользователь видит чёрный экран, пока все секции
    //    скрыты display:none. Запускаем fire-and-forget, auth page покажется сразу.
    // BUG-AUTH-SAFETY-001: startTdlibRuntime() fire-and-forget НЕ должна
    // блокировать очистку safetyTimer. Таймер управляется TdlibAuthPage:
    // очищается при получении первого tdlib-auth-state события.
    // Если startTdlibRuntime отклоняется — showFallbackError покажет ошибку.
    // Zero Secrets in Binary: креды приходят с сервера, TDLib стартует ПОСЛЕ них.
    // credentialsSettled даёт TdlibAuthPage возможность не слать TDLib-команды
    // раньше времени (иначе sidecar отдаёт -32000 «runtime not initialized» —
    // именно это выглядело как красная ошибка в релизе 0.3.0).
    credentialsSettled = (async () => {
      const ok = await ensureTelegramCredentials(safetyTimer);
      if (!ok) return;
      await startTdlibRuntime().catch((e) => {
        console.error("[main] TDLib runtime background error:", e);
        clearTimeout(safetyTimer);
        if (!safetyFired) showFallbackError(e);
      });
    })();
    setCredentialsSettled(credentialsSettled);

    // 2. Запускаем App — передаём safetyTimer для управления в TdlibAuthPage
    const app = new App(safetyTimer);
    await app.init();

    // 3. Принудительное обновление (server-driven, команда из админки).
    //    Проверка идёт сразу после старта UI и далее раз в 30 минут; при наличии
    //    новой версии экран блокируется до установки. В dev/e2e выключено
    //    (app.isPackaged=false) — см. electron/updater.ts.
    startUpdateWatch();
  } catch (e: any) {
    console.error("[main] Fatal initialization error:", e);
    // BUG-AUTH-SAFETY-001: критическая ошибка init — очищаем safety timer,
    // чтобы он не срабатывал позже и не перезаписывал fallback UI.
    clearTimeout(safetyTimer);
    if (!safetyFired) showFallbackError(e);
  } finally {
    // NOTE: safetyTimer НЕ очищается здесь для нормального пути — он
    // управляется TdlibAuthPage: очищается при получении первого
    // tdlib-auth-state события или при ошибке startTdlibRuntime.
    // Если очистить здесь — TDLib может не успеть прислать ответ за 20с
    // при холодном старте, и пользователь застреет на спиннере навсегда.
  }
}

/** BUG-WHITESCREEN-001: Показать fallback UI при ошибке инициализации */
function showFallbackError(err: Error): void {
  const loadingEl = document.getElementById("authLoadingOverlay");
  if (loadingEl) {
    loadingEl.innerHTML = `
      <div style="text-align:center; padding:20px 0;">
        <p style="font-size:24px; margin-bottom:12px;">❌</p>
        <p style="font-size:14px; color:var(--text-dim); margin-bottom:8px;">${escapeHtml(t("main.load_error_title"))}</p>
        <pre style="font-size:11px; color:var(--error); max-width:400px; margin:0 auto; white-space:pre-wrap; word-break:break-word;">${escapeHtml(err?.message ?? String(err))}</pre>
      </div>`;
  }
  const authPage = document.getElementById("authPage");
  if (authPage) authPage.style.display = "flex";
}

function escapeHtml(s: string): string {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

/**
 * Получить Telegram API credentials (Zero Secrets in Binary).
 *
 * Путь одинаков для dev-стендов (e2e-prod.sh / e2e-prod32.sh) и релиза:
 *   1. повторный запуск — сохранённая DesktopSession (auth.json) → GET /api/client-config (Bearer);
 *   2. свежая установка — POST /desktop/auth/credentials (client-key + лимит по
 *      реальному IP; pair-код удалён 2026-09-22) → api_id/api_hash → обычная
 *      авторизация Telegram (телефон/QR/2FA).
 *
 * Возвращает true, если креды установлены. Иначе показывает видимую ошибку с
 * кнопкой повтора (не молча — BUG-AUTH-WIN32-001).
 */
async function ensureTelegramCredentials(
  safetyTimer: ReturnType<typeof setTimeout>,
): Promise<boolean> {
  if (TELEGRAM_API_ID && TELEGRAM_API_HASH) {
    return true;
  }

  // 1) Повторный запуск: сохранённая сессия + /api/client-config.
  try {
    const auth = await store.load();
    if (auth?.access_token) {
      api.setToken(auth.access_token);
      const cfg = await api.getClientConfig();
      if (cfg?.ok && cfg.telegram_api_id && cfg.telegram_api_hash) {
        TELEGRAM_API_ID = cfg.telegram_api_id;
        TELEGRAM_API_HASH = cfg.telegram_api_hash;
        console.log(`[main] telegram credentials from client-config (api_id=${TELEGRAM_API_ID})`);
        return true;
      }
    }
  } catch (e) {
    console.warn("[main] client-config credentials failed:", e);
  }

  // 2) Свежий запуск: серверная выдача кред. Safety-timeout отключаем — вместо
  //    таймаута покажем собственную ошибку с кнопкой «Попробовать ещё раз».
  clearTimeout(safetyTimer);
  try {
    const res = await api.getDesktopCredentials();
    if (res?.ok && res.telegram_api_id && res.telegram_api_hash) {
      TELEGRAM_API_ID = res.telegram_api_id;
      TELEGRAM_API_HASH = res.telegram_api_hash;
      console.log(`[main] telegram credentials from server (api_id=${TELEGRAM_API_ID})`);
      return true;
    }
    showCredentialsError(`credentials refused: ${res?.error ?? "unknown_error"}`);
  } catch (e: any) {
    showCredentialsError(e?.message ?? String(e));
  }
  return false;
}

/** Видимая ошибка получения кред (вместо страшного `-32000` от sidecar). */
function showCredentialsError(detail: string): void {
  const authPage = document.getElementById("authPage");
  if (authPage) authPage.style.display = "flex";
  const overlay = document.getElementById("authLoadingOverlay");
  if (!overlay) return;
  overlay.innerHTML = `
    <div style="text-align:center; padding:12px;">
      <p style="font-size:14px; color:var(--text); margin-bottom:6px;">${escapeHtml(t("main.creds_error"))}</p>
      <p style="font-size:11px; color:var(--text-dim); word-break:break-word;">${escapeHtml(detail)}</p>
      <button id="retryCredsBtn" class="btn btn-secondary" style="margin-top:10px; font-size:13px;">
        ${escapeHtml(t("main.retry"))}
      </button>
    </div>`;
  document.getElementById("retryCredsBtn")?.addEventListener("click", () => {
    overlay.innerHTML = `<span style="color:var(--text-dim);">${escapeHtml(t("main.loading"))}</span>`;
    ensureTelegramCredentials(setTimeout(() => {}, 0))
      .then((ok) => {
        if (ok) return startTdlibRuntime();
      })
      .catch((e) => console.error("[main] credentials retry failed:", e));
  });
}

// bootstrap через pair-код УДАЛЁН (2026-09-22, решение владельца): pair-кодов
// и подтверждения в боте больше нет. Креды Telegram выдаёт сервер —
// см. ensureTelegramCredentials() → api.getDesktopCredentials().

/** Запустить TDLib runtime (если ещё не запущен) */
async function startTdlibRuntime(): Promise<void> {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    console.warn("[main] TELEGRAM_API_ID or TELEGRAM_API_HASH not set — TDLib auth disabled");
    showFallbackError(
      new Error(
        "Telegram API credentials not configured. Launch with VITE_TELEGRAM_API_ID/HASH "
        + "or restore a previous session to fetch them from the server.",
      ),
    );
    return;
  }

  try {
    const result = await invoke<string>("tdlib_start_runtime", {
      apiId: TELEGRAM_API_ID,
      apiHash: TELEGRAM_API_HASH,
    });
    console.log(`[main] TDLib runtime start: ${result}`);
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error(`[main] TDLib runtime start failed: ${errMsg}`);

    // BUG-AUTH-WIN32-001: Show visible error feedback when TDLib fails to start.
    // The auth page normally shows "Завантаження..." spinner — replace it with
    // a user-visible error so the user isn't stuck staring at a loading screen.
    const overlay = document.getElementById("authLoadingOverlay");
    if (overlay) {
      overlay.innerHTML = `
        <div style="color: var(--danger, #ff5252); font-size: 14px; padding: 12px;">
          <strong>${escapeHtml(t("main.tdlib_start_error"))}</strong><br>
          <span style="font-size: 12px; color: var(--text-dim, #888); margin-top: 6px; display: inline-block;">
            ${escapeHtml(errMsg)}
          </span><br>
          <button id="retryTdlibBtn" style="margin-top: 12px; padding: 8px 20px; border-radius: 6px; border: 1px solid var(--danger, #ff5252); background: transparent; color: var(--danger, #ff5252); cursor: pointer; font-size: 13px;">
            ${escapeHtml(t("main.retry"))}
          </button>
        </div>
      `;
      const retryBtn = document.getElementById("retryTdlibBtn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          // Restore loading overlay and retry
          if (overlay) {
            overlay.innerHTML = `<span style="color: var(--text-dim, #888);">${escapeHtml(t("main.loading"))}</span>`;
          }
          startTdlibRuntime();
        });
      }
    }

    // Also show a toast-like fallback error in case overlay isn't found
    showFallbackError(new Error(`TDLib runtime: ${errMsg}`));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  document.body.innerHTML = `
    <div style="padding:40px; text-align:center;">
      <h2 style="color:#ff5252;">${escapeHtml(t("main.critical_error"))}</h2>
      <pre style="color:#888; margin-top:16px;">${escapeHtml(err.message)}</pre>
    </div>
  `;
});
