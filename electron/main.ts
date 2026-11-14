/**
 * Electron main — процесс приложения (Node 16 в Electron 22).
 *
 * Win7/8 порт ARTEL. М0+М3:
 *  - создаёт окно и грузит Vite-dev-server (dev) либо собранный renderer;
 *  - IPC-мост-диспетчер: принимает ЛЮБУЮ tauri-команду (строку) и
 *    маршрутизирует: Electron API (dialog/fs/auth-file/open_url) / sidecar
 *    (engine.*) / NOT_IMPLEMENTED (TDLib-команды — рубеж M4; fs/scan/archive
 *    firmware — рубеж M2). Это полифилл tauri invoke для скопированного 1:1 UI.
 *
 * Sidecar-бинарь (engine-core) ищется в порядке:
 *   1. env ENGINE_CORE_PATH (задаёт dev7.sh);
 *   2. установленное приложение (app.isPackaged): <resources>/engine-core/engine-core.exe
 *      (electron-builder extraResources, рядом лежат runtime-DLL TDLib);
 *   3. dev-fallback: ../engine-core/target/debug|release/engine-core (относительно запуска).
 */

import { ChatTray, trayIconFile } from "./chat-tray";
import { ChatSettingsStore } from "./chat-settings";
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray } from "electron";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SidecarManager, NO_TIMEOUT_MS } from "./sidecar-manager";
import {
  geoPatchLg,
  geoPatchSamsung,
  geoScanLg,
  geoScanSamsung,
} from "./geo-unlock/service";
import { rotateLogFile, pruneOldLogs, CLIENT_LOG_NAME_RE } from "./log-rotation";
import {
  checkForUpdate,
  currentVersion,
  downloadPending,
  installPending,
} from "./updater";
import { IPC_CHANNEL, type BridgeRequest, type BridgeResult, type BridgeOk, type BridgeErr } from "../shared/ipc";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5197";

let telegramApiCredentials: { apiId: number; apiHash: string } | null = null;
let activeAuthFlowId: string | null = null;
let hiddenLoginTokenWaiter: { resolve: (link: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

function requestHiddenTdlibLoginToken(): Promise<string> {
  if (hiddenLoginTokenWaiter) return Promise.reject(new Error("AUTH_FAILED"));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (hiddenLoginTokenWaiter?.timer === timer) hiddenLoginTokenWaiter = null;
      reject(new Error("TDLIB_QR_TIMEOUT"));
    }, 30_000);
    hiddenLoginTokenWaiter = { resolve, reject, timer };
    sidecarManager().request("tdlib_qr_login", {}).catch(() => {
      if (hiddenLoginTokenWaiter?.timer === timer) {
        clearTimeout(timer);
        hiddenLoginTokenWaiter = null;
        reject(new Error("TDLIB_QR_FAILED"));
      }
    });
  });
}

async function isTdlibReadyForMtpHandoff(): Promise<boolean> {
  try {
    return Boolean(await sidecarManager().request("tdlib_is_ready", {}));
  } catch {
    return false;
  }
}

/**
 * Рантайм-профиль. Идея: dev умеет запускаться в режиме, ПОВЕДЕНЧЕСКИ
 * идентичном релизу, чтобы класс «в dev работает, в релизе нет» ловился ДО
 * сборки инсталлятора (см. docs/RELEASE_PROCESS.md §3, стадия 1).
 *
 *  - SMOKE_RUN  — headless-самотест (`--smoke-run`): окно не показывается,
 *                 выполняются проверки, процесс завершается кодом 0/1.
 *                 Это машинный гейт релиза (scripts/smoke-release.sh).
 *  - PROD_LIKE  — parity-режим (`--prod-like` / FW_ELECTRON_PROD_LIKE=1):
 *                 sidecar берётся ТОЛЬКО из FW_ELECTRON_SIDECAR_DIR (имитация
 *                 <resources>/engine-core упакованного приложения), HMR
 *                 выключен, renderer грузится из dist-renderer/ (как в пакете).
 */
const SMOKE_RUN = process.argv.includes("--smoke-run");
const PROD_LIKE =
  process.env.FW_ELECTRON_PROD_LIKE === "1" || process.argv.includes("--prod-like");

/**
 * Замок одного экземпляра (BUG-SINGLE-INSTANCE-001).
 *
 * Две копии клиента делят ОДИН `userData` (`%APPDATA%\ARTEL` /
 * `~/.config/ARTEL`): `auth.json`, каталог состояния TDLib (одна сессия на
 * два процесса = порча состояния), файл-логи — плюс общие temp-каталоги
 * (`firmware-desktop/`, `tdlib_upload_parts/`). Поэтому второй экземпляр не
 * стартует вовсе: замок берём ДО `whenReady` (окно и sidecar ещё не подняты),
 * а процесс завершаем кодом **3** — «тихий» 0 выглядел бы в харнессах
 * (`e2e-prod*.sh`, `smoke-release.sh` запускают клиент и смотрят код возврата)
 * как успешный прогон, в котором просто не было окна.
 */
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  console.error("[main] ARTEL уже запущен — второй экземпляр не стартует (exit 3)");
  process.exit(3);
}

/**
 * Повторный запуск (двойной клик по ярлыку) не создаёт второе окно, а поднимает
 * уже открытое — иначе у пользователя впечатление «программа не открылась».
 */
app.on("second-instance", () => {
  if (SMOKE_RUN) return; // headless-гейт: окно намеренно скрыто
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

/** Нормализует camelCase-ключи в snake_case (имитация конвертации Tauri v2). */
function normalizeSnake(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    const snake = k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    out[snake] = v;
  }
  return out;
}

function resolveSidecarBin(): string {
  const exe = process.platform === "win32" ? "engine-core.exe" : "engine-core";

  // 0) PROD-LIKE (гейт parity): путь к sidecar обязателен и проверяется ДО
  //    старта. Именно так ведёт себя упакованное приложение — sidecar лежит в
  //    ФИКСИРОВАННОМ месте (<resources>/engine-core), а не ищется по фолбэкам.
  //    Если файла нет — падаем громко, а не «молча берём dev-бинарь».
  if (PROD_LIKE) {
    const dir = process.env.FW_ELECTRON_SIDECAR_DIR;
    if (!dir) {
      throw new Error(
        "PROD_LIKE: не задан FW_ELECTRON_SIDECAR_DIR (каталог с sidecar, имитирующий <resources>/engine-core)",
      );
    }
    // Имя зависит от платформы, но ia32 e2e-профиль (e2e-prod32.sh) стейджит
    // Windows engine-core.exe на Linux-хосте (запуск через wine-обёртку
    // FW_ELECTRON_SIDECAR_WRAPPER) — принимаем оба имени.
    const candidates =
      process.platform === "win32" ? [exe] : [exe, "engine-core.exe"];
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    const p = path.join(dir, exe);
    throw new Error(`PROD_LIKE: sidecar не найден по фиксированному пути: ${p}`);
  }

  // 1) env ENGINE_CORE_PATH задаёт dev7.sh (наиболее надёжно).
  const envBin = process.env.ENGINE_CORE_PATH;
  if (envBin && fs.existsSync(envBin)) return envBin;

  // 2) Установленное приложение: electron-builder extraResources кладёт sidecar
  //    вместе с runtime-DLL TDLib в <resources>/engine-core/ (см. package.json →
  //    build.extraResources, from "win-bundle"). Внутри app.asar исполняемый файл
  //    лежать НЕ может (asar не исполняется ОС), поэтому это отдельный каталог.
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "engine-core", exe);
    if (fs.existsSync(packed)) return packed;
    return packed; // ожидаемый путь — ошибка sidecar будет ясной
  }

  // 3) fallback (dev): ищем относительно места запуска. Собранный main живёт в
  //    dist-electron/electron/, исходник — в electron/. Пробуем оба уровня.
  const rels = [
    path.join(__dirname, "..", "engine-core", "target"),
    path.join(__dirname, "..", "..", "engine-core", "target"),
  ];
  for (const base of rels) {
    for (const sub of ["debug", "release"]) {
      const c = path.join(base, sub, "engine-core");
      if (fs.existsSync(c)) return c;
    }
  }
  return path.join(rels[1], "debug", exe); // ожидаемый путь — ошибка будет ясной
}

/**
 * Разрешает путь к sidecar и НЕМЕДЛЕННО падает с кодом 2, если он не найден.
 * Молчаливый старт без sidecar — источник «в dev работало, в релизе пусто»:
 * клиент открывался, но все engine.* вызовы отваливались.
 */
function resolveSidecarBinOrExit(): string {
  try {
    return resolveSidecarBin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[main] FATAL: sidecar не разрешён: ${msg}`);
    process.exit(2);
  }
}

/** Каталог файл-логов клиента — переживает закрытие терминала.
 * Вызывать ТОЛЬКО после app.whenReady() — раньше app.getPath() недоступен
 * (smoke-run падал с "Cannot read properties of undefined (reading 'getPath')").
 *
 * Linux-dev/RCA (e2e-prod32): если задан env FW_ELECTRON_LOG_DIR — логи уходят
 * в папку проекта (напр. desktop-electron/logs/e2e-prod32), а НЕ в userData.
 * Ветка только для Linux (process.platform !== "win32"); Win-путь не меняется. */
function clientLogDir(): string {
  if (process.platform !== "win32") {
    const override = (process.env.FW_ELECTRON_LOG_DIR ?? "").trim();
    if (override.length > 0) return override;
  }
  return path.join(app.getPath("userData"), "logs");
}

/** Ленивая настройка файлового лога TDLib (BUG-AUTH-CODE-001).
 * Вызывать после app.whenReady(): точный ответ Telegram (например, почему
 * не приходит login-код по телефону) виден только в логе самой TDLib.
 * Пишем в <userData>/logs/tdlib.log (Linux-dev/RCA: в FW_ELECTRON_LOG_DIR);
 * sidecar включает его по env FW_TDLIB_LOG_PATH.
 * Windows: %APPDATA%\ARTEL\logs\tdlib.log — этот файл и нужен для разбора.
 *
 * Linux-dev/RCA (e2e-prod32, engine-core.exe под wine): Windows-бинарь POSIX-путь
 * `/home/...` не откроет — транслируем корень в `Z:\...` (wine монтирует `/` как
 * `Z:\`). Ветка только для Linux при заданном FW_ELECTRON_SIDECAR_WRAPPER=wine;
 * Win-путь не меняется. */
function setupTdlibLogPath(): void {
  try {
    const logDir = clientLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    // BUG-LOG-ROTATION-001: чистка файловых логов старше 7 дней (один раз при
    // старте). Ротация «максимум 2 файла, >5 МБ» — в rotateLogFile при записи.
    pruneOldLogs(logDir, CLIENT_LOG_NAME_RE);
    let tdlibPath = path.join(logDir, "tdlib.log");
    if (
      process.platform !== "win32" &&
      (process.env.FW_ELECTRON_SIDECAR_WRAPPER ?? "") === "wine"
    ) {
      tdlibPath = `Z:\\${tdlibPath.replace(/\//g, "\\").replace(/^\\/, "")}`;
    }
    process.env.FW_TDLIB_LOG_PATH = tdlibPath;
  } catch (e) {
    console.warn("[main] tdlib log path not configured:", e);
  }
}

/** Ленивый sidecar: создаётся после app.whenReady() (нужен clientLogDir).
 * Путь к бинарю резолвится лениво, т.к. PROD_LIKE-гейт требует env
 * FW_ELECTRON_SIDECAR_DIR, который smoke/e2e выставляют до whenReady. */
let sidecar: SidecarManager | null = null;
let sidecarBinResolved = "";
/** Говорящий релиз (2026-09-22): файловый журнал старта sidecar. В упакованном
 *  приложении консоли нет, а engine-core.log создаётся только при УСПЕШНОМ
 *  spawn — падение лоадера/антивирус/нехватка DLL оставляли релиз немым.
 *  Пишем: путь к бинарю, exists/размер, код выхода/сигнал, хвост stderr. */
function writeSidecarLog(line: string): void {
  try {
    const dir = clientLogDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "main-sidecar.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort — лог не должен ломать приложение */
  }
}

/** Записать RCA-строку download-потока в файл (Linux-dev, e2e-prod32).
 * Best-effort: лог не должен ломать передачу. Формат — одна JSON-строка с
 * префиксом `[dl-rca]`, те же поля, что Rust-хелпер (op/phase/ms/...), чтобы
 * single и multi лежали рядом в `download-rca.log`. Ротация: максимум 2 файла,
 * >5 МБ (BUG-LOG-ROTATION-001, общий хелпер log-rotation; prune >7 дней — при старте).
 * Win-путь не меняется: пишется в clientLogDir() (там Win-ветки нет). */
function writeDownloadRcaLog(line: string): void {
  try {
    const dir = clientLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "download-rca.log");
    rotateLogFile(dir, "download-rca.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] [dl-rca] ${line}\n`);
  } catch {
    /* best-effort — лог не должен ломать приложение */
  }
}
function writeBridgeLog(line: string): void {
  try {
    const dir = clientLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "bridge.log");
    // Ротация: максимум 2 файла, >5 МБ (BUG-LOG-ROTATION-001).
    // BUG-M2-RPC-TIMEOUT-001 (CAPA): неуспешная команда обязана остаться в
    // файле — в релизе нет консоли, а разбор «ошибка RPC» без текста невозможен.
    rotateLogFile(dir, "bridge.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort — лог не должен ломать приложение */
  }
}

function sidecarManager(): SidecarManager {
  if (!sidecar) {
    if (!sidecarBinResolved) sidecarBinResolved = resolveSidecarBinOrExit();
    sidecar = new SidecarManager(sidecarBinResolved, clientLogDir());
  }
  return sidecar;
}
function sidecarBin(): string {
  if (!sidecarBinResolved) sidecarBinResolved = resolveSidecarBinOrExit();
  return sidecarBinResolved;
}
/** Диагностическая сводка по бинарю sidecar (для engine.sidecarStatus и лога). */
function sidecarDiagnostics(): Record<string, unknown> {
  const bin = sidecarBin();
  let exists = false;
  let size: number | null = null;
  try {
    const st = fs.statSync(bin);
    exists = st.isFile();
    size = st.size;
  } catch {
    /* нет файла — и есть вероятная причина */
  }
  const mgr = sidecarManager();
  return {
    bin_path: bin,
    bin_exists: exists,
    bin_size: size,
    resources_dir: app.isPackaged ? path.join(process.resourcesPath, "engine-core") : null,
    running: mgr.isRunning(),
    last_error: mgr.lastLifecycleError(),
    log_dir: clientLogDir(),
  };
}

// ── Локальное хранилище auth.json (полифилл read/write/remove_auth_file) ──────
// В mainline этих команд НЕТ в Rust (BUG-AUTH-015) — UI вызывает их, но они падают.
// В Electron-версии персистим сессию в userData/auth.json, чтобы вход сохранялся
// между запусками (Q6-вариант близкий к (а): токен в памяти + TDLib-сессия позже).
function authFilePath(): string {
  return path.join(app.getPath("userData"), "auth.json");
}

/** userData/config.json — локальный кеш адреса сервера из маяка (SP-07 S-2). */
function configFilePath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function readAuthFile(): string {
  const p = authFilePath();
  if (!fs.existsSync(p)) throw new Error("auth.json not found");
  return fs.readFileSync(p, "utf8");
}

function createWindow(): BrowserWindow {
  // Глобальный копипаст (все поля + логи, 2026-09-24):
  // минимальный Edit-меню с ролями — без него Ctrl+C/X/V/A на Win7/8
  // работают только в фокусе штатного меню. Подписи даёт сама ОС.
  // Убрано главное меню "Edit" (верхняя левая часть окна) — оно не нужно
  // пользователю и мешает чистому UI. Контекстное меню ПКМ (копипаст) работает
  // независимо через win.webContents.on("context-menu") ниже.
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: PROD_LIKE ? "ARTEL (prod-like)" : "ARTEL (Electron Win7/8)",
    // SMOKE_RUN: окно не показываем — тест идёт headless (годен для CI/SSH).
    show: !SMOKE_RUN,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload использует require() для contextBridge/ipcRenderer
    },
  });

  // Глобальный копипаст ПКМ (2026-09-24): нативное контекстное меню
  // для ВСЕХ полей и логов. Ветвление по params.editFlags/selectionText:
  // input/textarea → Cut/Copy/Paste/SelectAll; выделенный текст в логах,
  // диаг-блоках, ошибках → Copy/SelectAll; пустое редактируемое → Paste.
  win.webContents.on("context-menu", (_evt, params) => {
    try {
      const { editFlags, selectionText, isEditable } = params as {
        editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
        selectionText: string;
        isEditable: boolean;
      };
      const hasSelection = Boolean(selectionText && selectionText.trim().length > 0);
      const template: Array<{ role?: "cut" | "copy" | "paste" | "selectAll"; type?: "separator" }> = [];
      if (isEditable) {
        if (editFlags.canCut) template.push({ role: "cut" });
        if (editFlags.canCopy) template.push({ role: "copy" });
        if (editFlags.canPaste) template.push({ role: "paste" });
        if (template.length > 0 && editFlags.canSelectAll) template.push({ type: "separator" });
        if (editFlags.canSelectAll) template.push({ role: "selectAll" });
      } else if (hasSelection) {
        // Не редактируемый текст (логи, диаг-блоки, ошибки, карточки).
        if (editFlags.canCopy) template.push({ role: "copy" });
        if (editFlags.canSelectAll) template.push({ role: "selectAll" });
      } else {
        return; // Пустое место страницы — меню не показываем.
      }
      if (template.length === 0) return;
      Menu.buildFromTemplate(template).popup({ window: win });
    } catch {
      /* ignore — отсутствие меню не должно ронять окно */
    }
  });

  // В dev: Vite HMR-сервер. Иначе — собранный renderer.
  if (process.env.FW_ELECTRON_DEV === "1") {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Путь СТРОГО как в упакованном приложении: renderer лежит в корне
    // (asar-корень в пакете, корень проекта в dev). __dirname = <root>/dist-electron/electron,
    // поэтому нужно ДВА уровня вверх — иначе ищем dist-electron/dist-renderer (не существует).
    // Регресс ловится гейтом scripts/smoke-release.sh (checks: renderer.loaded / renderer.dom).
    void win.loadFile(path.join(__dirname, "..", "..", "dist-renderer", "index.html"));
  }
  return win;
}

/**
 * IPC-диспетчер tauri-команд.
 * Команды mainline UI (desktop/src) приходят сюда по имени. Часть обслуживается
 * Electron API, часть — sidecar, остальное — честный NOT_IMPLEMENTED с указанием
 * рубежа (чтобы UI показал состояние, а не молчал).
 */
let chatTray:ChatTray | null=null;
let chatSettingsStore:ChatSettingsStore | null=null;
function chatSettings():ChatSettingsStore {
  return chatSettingsStore ??= new ChatSettingsStore(path.join(app.getPath("userData"),"chat-settings.json"));
}

async function bridgeHandle(cmd: string, args: Record<string, unknown>): Promise<BridgeResult> {
  const fail = (error: string): BridgeErr => ({ ok: false, error });
  const ok = <T>(value: T): BridgeOk<T> => ({ ok: true, value });
  try {
    if(cmd.startsWith("chat_alerts_") || cmd==="chat_reading_state" || cmd==="chat_window_state") {
      return chatTray ? ok(chatTray.command(cmd,args)) : fail("CHAT_MONITOR_UNAVAILABLE");
    }
    switch (cmd) {
      case "chat_settings_get": return ok(chatSettings().get());
      case "chat_settings_set": return ok(chatSettings().set(args));
      // ── sidecar (engine-core) ─────────────────────────────────────────
      case "engine.ping": {
        const res = (await sidecarManager().request("ping", {})) as Record<string, unknown>;
        return ok(res);
      }
      case "engine.hashFile": {
        const p = String(args?.path ?? "");
        if (!p) return fail("hashFile: path обязателен");
        const res = (await sidecarManager().request("hash_file", { path: p })) as Record<string, unknown>;
        return ok(res);
      }
      case "engine.version": {
        const res = (await sidecarManager().request("ping", {})) as Record<string, unknown>;
        return ok({ engineCoreVersion: res?.version ?? "unknown" });
      }
      case "engine.sidecarStatus": {
        // Говорящий релиз: UI может показать точную причину «sidecar not running»
        // (путь, exists/размер, код выхода, где лежат логи) вместо голой строки.
        return ok(sidecarDiagnostics());
      }

      // ── GEO_Unlock (вкладка «Інструменти»): headless-ядра в main ───────
      // Тариф решает СОДЕРЖИМОЕ дампа (см. electron/geo-unlock/service.ts):
      // grant нужен только для дампа раздела eMMC, причём владельцу сервер
      // выдаёт grant kind "owner" без списания. Дамп микросхемы NVM 24C512
      // (64 КиБ) и все сканы бесплатны.
      case "geo_samsung_scan":
        return ok(geoScanSamsung(args));
      case "geo_samsung_patch":
        return ok(geoPatchSamsung(args));
      case "geo_lg_scan":
        return ok(geoScanLg(args));
      case "geo_lg_patch":
        return ok(geoPatchLg(args));

      // ── download-RCA в файл (Linux-dev, e2e-prod32) ───────────────────
      // Зеркало лога вкладки «Передача» (стратегия/priority/ошибка дословно) —
      // без него RCA single-vs-multi читается только из терминала.
      case "engine.appendDownloadRca": {
        writeDownloadRcaLog(String(args?.line ?? ""));
        return ok({ status: "ok" });
      }

      // ── dialog (Electron) ──────────────────────────────────────────────
      case "window.showOpenDialog": {
        const props = (args?.properties as string[]) ?? ["openFile", "openDirectory"];
        const filters = (args?.filters as Array<{ name: string; extensions: string[] }>) ?? [];
        const r = await dialog.showOpenDialog({
          title: String(args?.title ?? ""),
          defaultPath: args?.defaultPath ? String(args?.defaultPath) : undefined,
          properties: props as Array<"openFile" | "openDirectory" | "multiSelections">,
          // Фильтр типов (SP-15: диалог выбора фото карточки) — если задан.
          filters: filters.length > 0 ? filters : undefined,
        });
        return ok({ canceled: r.canceled, filePaths: r.filePaths });
      }
      case "window.showSaveDialog": {
        const r = await dialog.showSaveDialog({
          title: String(args?.title ?? ""),
          defaultPath: args?.defaultPath ? String(args?.defaultPath) : undefined,
        });
        return ok({ canceled: r.canceled, filePath: r.filePath });
      }
      case "window.showMessageBox": {
        const buttons = (args?.buttons as string[]) ?? ["OK"];
        const r = await dialog.showMessageBox({
          message: String(args?.message ?? ""),
          title: String(args?.title ?? ""),
          buttons,
          defaultId: (args?.defaultId as number) ?? 0,
          cancelId: (args?.cancelId as number) ?? 0,
        });
        return ok({ response: r.response });
      }

      // ── auth-file (локальный userData/auth.json) ───────────────────────
      case "read_auth_file":
        return ok(readAuthFile());
      case "write_auth_file": {
        const p = authFilePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args?.content ?? ""), "utf8");
        return ok(null);
      }
      case "remove_auth_file": {
        const p = authFilePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return ok(null);
      }

      // ── config-file (userData/config.json: кеш адреса сервера, SP-07 S-2) ──
      // Отдельный от auth.json файл: адрес из маяка не часть сессии и не должен
      // теряться при logout/перезаписи токена.
      case "read_config_file": {
        const p = configFilePath();
        if (!fs.existsSync(p)) throw new Error("config.json not found");
        return ok(fs.readFileSync(p, "utf8"));
      }
      case "write_config_file": {
        const p = configFilePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(args?.content ?? ""), "utf8");
        return ok(null);
      }

      // ── принудительное обновление (VPS, команда из админки) ────────────
      // URL/путь установщика renderer НЕ передаёт: план хранится в main
      // (см. electron/updater.ts), поэтому подменить источник нельзя.
      case "updater.version":
        return ok(currentVersion());
      case "updater.check":
        return ok(await checkForUpdate());
      case "updater.download":
        return ok(
          await downloadPending((received, total) => {
            for (const win of BrowserWindow.getAllWindows()) {
              try {
                win.webContents.send("fw:event", "updater-progress", { received, total });
              } catch {
                /* окно закрывается */
              }
            }
          }),
        );
      case "updater.install":
        return ok(installPending());

      // ── open_url (Electron shell) ───────────────────────────────────────
      case "open_url": {
        const url = String(args?.url ?? "");
        if (!url) return fail("open_url: url обязателен");
        await shell.openExternal(url);
        return ok(null);
      }

      // ── fs / scan / hash / archive (mainline commands.rs) → sidecar M2 ──
      // Команды выполняются в engine-core (модуль m2). Tauri конвертирует
      // camelCase-аргументы JS → snake_case параметров Rust — здесь та же
      // нормализация перед отправкой в sidecar.
      //
      // BUG-M2-RPC-TIMEOUT-001: scan/hash/archive — ДОЛГИЕ операции (SHA256 и
      // ZIP-deflate папки с прошивками идут десятки секунд–минуты, в e2e-prod32
      // ещё и ia32-бинарь под wine). Дефолтный таймаут моста (30с) обрывал их
      // ошибкой «RPC timeout: create_archive» прямо на фазе «📦 Packing into the
      // archive...». Идём NO_TIMEOUT_MS — как для tdlib_wait_upload ниже.
      // Фаза 3 (BUG-SMART-SINGLE-UPLOAD-003): контейнерные команды
      // (pack_archive / unpack_archive) и tar.zst-фасады (create_tar_zst /
      // extract_tar_zst) — те же долгие операции (zstd/дефлейт дампов 4-10 ГБ).
      case "scan_and_hash":
      case "sha256_file":
      case "create_archive":
      case "extract_archive":
      case "pack_archive":
      case "unpack_archive":
      case "create_tar_zst":
      case "extract_tar_zst": {
        const norm = normalizeSnake(args);
        const res = (await sidecarManager().request(cmd, norm, NO_TIMEOUT_MS)) as Record<string, unknown>;
        return ok(res);
      }

      // Быстрые fs-команды (метаданные/чанки/удаление): остаются на дефолтном
      // таймауте — это страховка от зависшего sidecar, ослаблять её нельзя.
      case "get_path_info":
      case "read_file_bytes":
      case "write_file_bytes":
      case "write_file_chunk":
      case "remove_archive":
      case "cleanup_stale_archives":
      // SP-15 срез 5 (D-071): каталог медиа-кеша карточек для галереи (TDLib-путь).
      case "media_cache_dir":
      case "peek_file_header":
      case "rename_file":
      case "delete_file": {
        const norm = normalizeSnake(args);
        const res = (await sidecarManager().request(cmd, norm)) as Record<string, unknown>;
        return ok(res);
      }

      // ── OS Keyring → Electron safeStorage (рубеж M6; пока NOT_IMPLEMENTED) ──
      case "save_session_to_keyring":
      case "load_session_from_keyring":
      case "delete_session_from_keyring":
      case "list_keyring_sessions":
        return fail(`NOT_IMPLEMENTED: "${cmd}" — keyring → Electron safeStorage на рубеже M6`);

      // ── TDLib runtime (M4a1) + auth (M4a2) — реализовано в sidecar ────
      case "tdlib_start_runtime": {
        const res = (await sidecarManager().request(cmd, args)) as Record<string, unknown>;
        const apiId = Number(args.apiId);
        const apiHash = typeof args.apiHash === "string" ? args.apiHash : "";
        if (Number.isSafeInteger(apiId) && apiId > 0 && apiHash.length > 0 && apiHash.length <= 128) {
          telegramApiCredentials = { apiId, apiHash };
        }
        return ok(res);
      }
      case "tdlib_runtime_status":
      case "tdlib_is_ready":
      case "tdlib_shutdown":
      // M4a2 auth: fire-and-forget, результат событиями
      // BUG-AUTH-LOGOUT-NOTIMPLEMENTED-001 (2026-10-31): `tdlib_logout` и
      // email-ветка (`tdlib_set_email` / `tdlib_check_email_code`) реализованы в
      // engine-core, но НЕ были в этом switch → default отдавал
      // `NOT_IMPLEMENTED: "tdlib_logout" …`, «Выйти» не срабатывал, TDLib
      // оставался в Ready, а UI показывал форму входа (PHONE_AUTH_ALREADY_AUTHORIZED).
      //
      // ⚠️ FALL-THROUGH (BUG-AUTH-LOGOUT-QR-001 регресс 2026-11-11): ветку
      // `tdlib_logout` НЕЛЬЗЯ выделять отдельным case'ом ВНУТРИ этой цепочки —
      // case'ы выше (`tdlib_is_ready` / `tdlib_shutdown`, их дергает poll
      // каждые 0.5–2 с) провалились бы в блок логаута → цикл «логаут +
      // перезапуск sidecar каждые 2 с», QR не работает вовсе. Restart
      // sidecar делается условием ПОСЛЕ общего запроса (см. блок ниже).
      case "tdlib_logout":
      case "tdlib_reset_auth":
      case "tdlib_qr_login":
      case "tdlib_set_phone":
      case "tdlib_set_email":
      case "tdlib_check_code":
      case "tdlib_check_email_code":
      case "tdlib_check_password":
      case "tdlib_resend_code":
      case "tdlib_get_my_id":
      case "tdlib_check_auth": {
        // auth-команды принимают camelCase-параметры (phone/code/password) —
        // Rust-хендлеры читают те же имена (phone/code/password), так что
        // передаём args как есть (как mainline UI их шлёт).
        const res = (await sidecarManager().request(cmd, args)) as Record<string, unknown>;
        // BUG-AUTH-LOGOUT-QR-001: только РЕАЛЬНЫЙ logout пересоздаёт sidecar
        // (чистое состояние TDLib: после auth.logOut клиент в этом же процессе
        // сразу `authorizationStateClosed` и QR не генерится). Guard НЕОБХОДИМ:
        // блок общий на всю цепочку case'ов, включая `tdlib_is_ready`, который
        // poll дергает каждые 0.5–2 с.
        if (cmd === "tdlib_logout") {
          await restartSidecarAfterLogout();
        }
        return ok(res);
      }


      case "tdlib_get_remote_file":
      case "tdlib_get_message_file":
      case "tdlib_start_download":
      case "tdlib_cancel_download":
      case "tdlib_get_downloads":
      // M4a3-шаг2: сервисные команды (join/delete/send_bot_start)
      // Host-PM staging: resolve_private_chat — chat_id ЛС с Host-АККАУНТОМ
      // (createPrivateChat без нормализации user_id).
      case "tdlib_join_chat":
      case "tdlib_join_chat_by_invite_link":
      case "tdlib_delete_messages":
      case "tdlib_resolve_private_chat":
      case "tdlib_send_bot_start":
      case "tdlib_get_bot_description":
      case "tdlib_quiet_bot_chat": {
        const res = (await sidecarManager().request(cmd, args)) as Record<string, unknown>;
        return ok(res);
      }

      // ── TDLib upload (M4a4: single реализован в sidecar) ───────────────
      // ВАЖНО: wait/upload — ДОЛГИЕ операции (до 2ч) → NO_TIMEOUT_MS,
      // иначе дефолтные 30с обрывают их по таймауту.
      case "tdlib_wait_upload":
      case "tdlib_start_multi_upload": {
        const res = (await sidecarManager().request(cmd, args, NO_TIMEOUT_MS)) as Record<string, unknown>;
        return ok(res);
      }
      // M4a3-шаг2/M4a4: multi/composite/vault download идут в sidecar; команда
      // старта возвращается сразу, прогресс — событиями (таймаут обычный).
      // BUG-CANCEL-RESUME-002: отмена parts-загрузки — та же ветка (короткая).
      case "tdlib_start_multi_download":
      case "tdlib_cancel_multi_download":
      case "tdlib_start_composite_download":
      case "tdlib_start_vault_self_download": {
        const res = (await sidecarManager().request(cmd, args)) as Record<string, unknown>;
        return ok(res);
      }
      case "tdlib_start_upload":
      case "tdlib_cancel_upload":
      case "tdlib_clear_cache": {
        const res = (await sidecarManager().request(cmd, args)) as Record<string, unknown>;
        return ok(res);
      }

      // ── TDLib multi/composite/vault/owner download / multi-upload / worker ──
      default:
        if (cmd.startsWith("tdlib_") || cmd.startsWith("worker_")) {
          return fail(`NOT_IMPLEMENTED: "${cmd}" — multi/composite/vault download и multi-upload в sidecar на след. шаге M4a3-шаг2/M4a4`);
        }
        return fail(`Unknown bridge command: ${cmd}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Проброс события sidecar в renderer (auth-state, connection-state, …).
 *
 * ВАЖНО: подписка живёт в sidecar-manager (набор колбэков), поэтому после
 * пересоздания sidecar подписка остаётся активной — переподписывать не нужно.
 */
function forwardSidecarEvent(name: string, payload: unknown): void {
  if (name === "tdlib-auth-state" && hiddenLoginTokenWaiter) {
    const event = payload as { status?: unknown; link?: unknown };
    if (event?.status === "qr_link" && typeof event.link === "string") {
      const waiter = hiddenLoginTokenWaiter;
      hiddenLoginTokenWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(event.link);
      return;
    }
  }
  if (name === "tdlib-auth-error" && hiddenLoginTokenWaiter) {
    const event = payload as { extra?: unknown; code?: unknown };
    if (event?.extra === "qr_login") {
      const waiter = hiddenLoginTokenWaiter;
      hiddenLoginTokenWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(Number(event.code) === 401 ? "TDLIB_QR_UNAUTHORIZED" : "TDLIB_QR_FAILED"));
      return;
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("fw:event", name, payload);
  }
}

/** Момент последнего пересоздания sidecar по logout (защита от runaway-циклов). */
let lastLogoutSidecarRestartAt = 0;

/**
 * Пересоздать sidecar после выхода из аккаунта (BUG-AUTH-LOGOUT-QR-001).
 *
 * Симптом (живой репорт владельца 2026-11-10): после «Выйти» QR не
 * генерируется — клиент TDLib в ЭТОМ ЖЕ процессе держит состояние «closed»
 * (после `auth.logOut` общий TDLib-инстанс закрытого клиента остаётся в
 * памяти), поэтому новый клиент в том же процессе сразу отдаёт
 * `authorizationStateClosed`, и `requestQrCodeAuthentication` отклоняется
 * («нужен WaitPhoneNumber»). Обходной путь пользователя — закрыть клиент и
 * перезапустить: НОВЫЙ ПРОЦЕСС = чистое состояние TDLib.
 *
 * Поэтому после выхода мы пересоздаём sidecar (новый процесс) и поднимаем
 * TDLib runtime заново на ТОМ ЖЕ каталоге сессии: future-auth-token в БД
 * переживает выход → вход по номеру остаётся мгновенным, а QR работает.
 */
async function restartSidecarAfterLogout(): Promise<void> {
  // Runaway-защита: пересоздание чаще, чем раз в 5 с, — это сбой вызывающей
  // стороны (таким был fall-through регресс 2026-11-11), а не второй «Выйти».
  const now = Date.now();
  if (now - lastLogoutSidecarRestartAt < 5000) {
    writeSidecarLog("sidecar restart после выхода ПРОПУЩЕН: чаще 5с — runaway, некорректный вызов");
    return;
  }
  lastLogoutSidecarRestartAt = now;
  try {
    writeSidecarLog("sidecar restart после выхода из аккаунта (чистое состояние TDLib)");
    await sidecarManager().stop();
    await sidecarManager().start();
    const creds = telegramApiCredentials;
    if (creds && creds.apiId > 0 && creds.apiHash) {
      await sidecarManager().request("tdlib_start_runtime", {
        apiId: creds.apiId,
        apiHash: creds.apiHash,
      });
      writeSidecarLog("sidecar restart: TDLib runtime поднят заново (тот же каталог сессии)");
    } else {
      writeSidecarLog("sidecar restart: креды TDLib неизвестны — runtime поднимет renderer");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeSidecarLog(`sidecar restart FAILED: ${msg}`);
    console.error("[main] sidecar restart after logout failed:", e);
  }
}

async function initSidecar(): Promise<void> {
  // Говорящий релиз: фиксируем старт в файле ещё до любых попыток spawn.
  try {
    const bin = sidecarBin();
    let size: number | null = null;
    try {
      size = fs.statSync(bin).size;
    } catch {
      /* отсутствует — будет видно в записи ниже */
    }
    writeSidecarLog(`sidecar resolve → ${bin} (exists=${fs.existsSync(bin)}, size=${size ?? "?"})`);
  } catch (e) {
    writeSidecarLog(`sidecar resolve FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return; // резолв уже упал с process.exit(2) внутри resolveSidecarBinOrExit
  }
  try {
    await sidecarManager().start();
    writeSidecarLog("sidecar start OK (ping отвечает)");
    // Проброс потоковых событий sidecar (tdlib-auth-state и др.) в renderer:
    // main → webContents.send("fw:event", name, payload) → preload → fwCloud.listen.
    sidecarManager().onEvent(forwardSidecarEvent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[main] sidecar start failed:", e);
    writeSidecarLog(`sidecar start FAILED: ${msg}`);
    // Дубль в общий журнал: даже если WriteStream sidecar-лога не поднялся,
    // причина старта обязана где-то остаться.
    try {
      const d = sidecarDiagnostics();
      writeSidecarLog(`sidecar diagnostics: ${JSON.stringify(d)}`);
    } catch {
      /* ignore */
    }
  }
}

// Отключаем аппаратное ускорение GPU: Electron 22 (Chromium 108) на старых
// Win7/8 и в headless/VM окружениях может падать в gpu-процессе. Для
// файлового клиента (список/хэш) программный рендер не критичен по скорости.
// ВАЖНО: вызывать СИНХРОННО на верхнем уровне (до app.whenReady()) — Electron
// требует disableHardwareAcceleration() строго до ready. Top-level вызовы
// app.getPath()/new SidecarManager() при этом запрещены (app undefined в
// ELECTRON_RUN_AS_NODE и до ready) — они ленивые, см. ниже.
app.disableHardwareAcceleration();

/**
 * Headless-самотест prod-like сборки (`--smoke-run`). Проверяет то, что
 * реально ломается при переходе dev → инсталлятор: разрешение sidecar по
 * фиксированному пути, живой IPC до sidecar, наличие моста в renderer,
 * round-trip через мост и непустой DOM. Завершает процесс кодом 0/1.
 *
 * Отчёт: человекочитаемые строки + одна JSON-строка `[smoke] JSON {...}`
 * (машиночитаемо для scripts/smoke-release.sh / CI).
 */
async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const add = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
    console.log(`[smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  add("profile.prod_like", PROD_LIKE, PROD_LIKE ? "on" : "OFF (запускать с --prod-like)");
  add("sidecar.path", sidecarBin().length > 0, sidecarBin());

  try {
    const pong = (await sidecarManager().request("ping", {})) as Record<string, unknown>;
    add("sidecar.ping", pong?.status === "ok", JSON.stringify(pong));
  } catch (e) {
    add("sidecar.ping", false, e instanceof Error ? e.message : String(e));
  }

  try {
    // Детерминированное ожидание: НЕ полагаемся на isLoading() — он учитывает
    // подресурсы/сетевые запросы renderer'а и «мигает». Ждём did-finish-load
    // главного фрейма с таймаутом, а факт загрузки определяем по URL.
    await new Promise<void>((res) => {
      if (!win.webContents.isLoadingMainFrame()) return res();
      const t = setTimeout(res, 15000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(t);
        res();
      });
    });
    const url = win.webContents.getURL();
    add(
      "renderer.loaded",
      url.startsWith("file://") && url.endsWith("dist-renderer/index.html"),
      url.slice(0, 110),
    );
  } catch (e) {
    add("renderer.loaded", false, e instanceof Error ? e.message : String(e));
  }

  try {
    const kind = (await win.webContents.executeJavaScript("typeof window.fwCloud?.invoke")) as string;
    add("bridge.exposed", kind === "function", kind);
  } catch (e) {
    add("bridge.exposed", false, e instanceof Error ? e.message : String(e));
  }

  try {
    const rt = (await win.webContents.executeJavaScript(
      "window.fwCloud.invoke('engine.version', {})",
    )) as Record<string, unknown>;
    add("bridge.roundtrip", Boolean(rt?.engineCoreVersion), String(rt?.engineCoreVersion ?? ""));
  } catch (e) {
    add("bridge.roundtrip", false, e instanceof Error ? e.message : String(e));
  }

  try {
    const dom = (await win.webContents.executeJavaScript(
      "({children: document.body.children.length, title: document.title, text: (document.body.innerText||'').trim().length})",
    )) as { children: number; title: string; text: number };
    add("renderer.dom", dom.children > 0, `children=${dom.children} title="${dom.title}" text=${dom.text}`);
  } catch (e) {
    add("renderer.dom", false, e instanceof Error ? e.message : String(e));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`[smoke] RESULT ${failed.length === 0 ? "OK" : "FAILED"} (${checks.length - failed.length}/${checks.length})`);
  console.log(`[smoke] JSON ${JSON.stringify({ ok: failed.length === 0, checks })}`);

  const code = failed.length === 0 ? 0 : 1;
  await sidecarManager().stop();
  app.exit(code);
  // Страховка: app.exit() завершает процесс сам, но если выход задержался
  // (открытые handle'ы) — жёсткий exit, чтобы CI-гейт не «завис» до таймаута.
  setTimeout(() => process.exit(code), 3000);
}

/**
 * Миграция userData FW CLOUD → ARTEL (SP-01 K5).
 *
 * При старте, если существует старый каталог `%APPDATA%\FW CLOUD`
 * (или `~/.config/FW CLOUD`) и нет нового (`ARTEL`) — переименовать каталог
 * (не копировать: атомарно, без удвоения TDLib-состояния).
 * Если оба существуют — работать с новым, старый не трогать, залогировать
 * предупреждение. Маркер `.migrated-from-fwcloud` внутри нового каталога.
 */
function resolveUserDataDir(opts: {
  appDataDir: string;
  exists: (p: string) => boolean;
  rename: (oldP: string, newP: string) => void;
  writeMarker: (dir: string) => void;
  warn: (msg: string) => void;
}): string {
  const oldDir = path.join(opts.appDataDir, "FW CLOUD");
  const newDir = path.join(opts.appDataDir, "ARTEL");
  const oldExists = opts.exists(oldDir);
  const newExists = opts.exists(newDir);
  if (oldExists && !newExists) {
    opts.rename(oldDir, newDir);
    opts.writeMarker(newDir);
    return newDir;
  }
  if (oldExists && newExists) {
    opts.warn(`[main] оба каталога userData существуют — используется новый: ${newDir} (старый нетронут: ${oldDir})`);
    return newDir;
  }
  return newDir;
}

function migrateUserDataDir(): void {
  try {
    const userDir = resolveUserDataDir({
      appDataDir: app.getPath("appData"),
      exists: (p) => fs.existsSync(p),
      rename: (o, n) => fs.renameSync(o, n),
      writeMarker: (d) => {
        fs.writeFileSync(path.join(d, ".migrated-from-fwcloud"), "FW CLOUD\n", "utf8");
      },
      warn: (m) => console.warn(m),
    });
    app.setPath("userData", userDir);
  } catch (e) {
    console.warn("[main] миграция userData FW CLOUD → ARTEL не удалась, используется путь по умолчанию:", e);
  }
}

app.whenReady().then(async () => {
  migrateUserDataDir();
  setupTdlibLogPath();
  await initSidecar();
  ipcMain.handle(IPC_CHANNEL, async (_evt, req: BridgeRequest) => {
    const cmd = req?.cmd ?? "";
    const res = await bridgeHandle(cmd, req?.args ?? {});
    // BUG-M2-RPC-TIMEOUT-001 (CAPA): неуспешная команда обязана остаться в
    // файле — в релизе нет консоли, а разбор «ошибка RPC» без текста невозможен.
    if (!res.ok) writeBridgeLog(`bridge FAIL ${cmd}: ${res.error}`);
    return res;
  });

  const win = createWindow();
  if(!SMOKE_RUN) {
    const trayPath=app.isPackaged || PROD_LIKE
      ? path.join(__dirname,"../../dist-renderer",trayIconFile(process.platform))
      : path.join(__dirname,"../../public",trayIconFile(process.platform));
    try {
      const tray=new Tray(trayPath);
      chatTray=new ChatTray(win,tray,{
        settings:()=>chatSettings().get(),platform:process.platform,quit:()=>app.quit(),
        emit:(name,payload)=>{if(!win.isDestroyed()) win.webContents.send("fw:event",name,payload);},
        menu:(open,exit,labels)=>tray.setContextMenu(Menu.buildFromTemplate([
          {label:labels.open,click:open},{type:"separator"},{label:labels.exit,click:exit},
        ])),
      });
    } catch(e) {console.warn("[chat] Tray could not be created",e instanceof Error?e.message:String(e));}
  }

  // Headless-гейт: прогоняем проверки и выходим с кодом результата.
  if (SMOKE_RUN) {
    await runSmokeTest(win);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void sidecarManager().stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  chatTray?.dispose();chatTray=null;
  void sidecarManager().stop();
});
