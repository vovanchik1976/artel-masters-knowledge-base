/**
 * Принудительное обновление Desktop из VPS (server-driven, команда — админка).
 *
 * Почему свой модуль, а не electron-updater:
 *  - канал уже есть (`GET /updater/latest.json` + `/updater/files/...`), менять
 *    серверный контракт и тянуть новую зависимость не нужно;
 *  - NSIS-установщик electron-builder умеет тихую установку
 *    `/S --updated --force-run` (страницы пропускаются, приложение поднимается
 *    само после установки) — проверено по шаблонам app-builder-lib;
 *  - вся логика решения (версия/арка/sha256) — в `shared/updaterPolicy.ts`,
 *    покрыта чистыми тестами без Electron.
 *
 * Инварианты:
 *  - renderer НЕ передаёт URL/путь: план обновления живёт только здесь (pending),
 *    поэтому XSS в renderer не может подсунуть свой установщик;
 *  - скачиваем только https и только с текущего адреса сервера (или его же
 *    host для абсолютного URL), редиректы — не больше 3 и только same-origin;
 *  - целостность: размер + sha256 из манифеста; при несовпадении файл удаляется
 *    и установка не запускается;
 *  - вне упакованного приложения (dev/e2e) обновление выключено, чтобы
 *    `e2e-prod*.sh` не перезапускал тестовый стенд; включается явно
 *    `FW_UPDATER_ALLOW_DEV=1`;
 *  - любая сетевая ошибка проверки — fail-open (`error`), клиент работает
 *    дальше: недоступный сервер не должен «кирпичить» мастера.
 */

import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { pipeline } from "node:stream";

import { decideUpdate, resolveUpdateUrl } from "../shared/updaterPolicy";

const DEFAULT_SERVER_URL = "https://tv-firmware.duckdns.org";
const MANIFEST_PATH = "/updater/latest.json";
const CHECK_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 120_000; // простой без данных
const MAX_REDIRECTS = 3;
const PROGRESS_MIN_INTERVAL_MS = 200;

export type UpdateCheck =
  | { state: "disabled" }
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "error"; reason: string }
  | { state: "update"; version: string; notes: string; size: number; url: string };

interface PendingUpdate {
  version: string;
  url: string;
  sha256: string;
  size: number;
  fileName: string;
  dir: string;
}

let pending: PendingUpdate | null = null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emit(event: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("fw:event", event, payload);
    } catch {
      /* окно уже закрывается — событие не критично */
    }
  }
}

/** Обновление разрешено только в упакованном приложении (см. шапку файла). */
export function updaterEnabled(): boolean {
  if (process.env.FW_UPDATER_DISABLED === "1") return false;
  if (!app.isPackaged && process.env.FW_UPDATER_ALLOW_DEV !== "1") return false;
  return true;
}

/** Текущий адрес сервера: кеш маяка (`config.json`) либо канонический домен. */
export function serverBaseUrl(): string {
  try {
    const raw = fs.readFileSync(
      path.join(app.getPath("userData"), "config.json"),
      "utf8",
    );
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const url = typeof obj.server_url === "string" ? obj.server_url.trim() : "";
    if (url) return url.replace(/\/+$/, "");
  } catch {
    /* нет кеша/битый JSON — канонический адрес */
  }
  return DEFAULT_SERVER_URL;
}

/** GET текста с таймаутом и безопасными (same-origin) редиректами. */
function httpsGetText(
  url: string,
  timeoutMs: number,
  redirectsLeft = MAX_REDIRECTS,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const origin = new URL(url).origin;
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": `ARTEL-Desktop/${app.getVersion()}`,
          Accept: "application/json",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("too many redirects"));
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            reject(new Error("bad redirect location"));
            return;
          }
          if (next.protocol !== "https:" || next.origin !== origin) {
            reject(new Error("unsafe redirect"));
            return;
          }
          resolve(httpsGetText(next.toString(), timeoutMs, redirectsLeft - 1));
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 1_000_000) body += chunk;
        });
        res.on("end", () => resolve({ status, body }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Удалить старые скачанные установщики (оставляем только текущую версию). */
function sweepDownloads(keepVersion: string): void {
  const root = path.join(app.getPath("userData"), "updates");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === keepVersion) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      /* занят/нет прав — не критично */
    }
  }
}

/** Проверить манифест и запомнить план обновления (renderer URL не передаёт). */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!updaterEnabled()) return { state: "disabled" };

  const base = serverBaseUrl();
  let res: { status: number; body: string };
  try {
    res = await httpsGetText(base + MANIFEST_PATH, CHECK_TIMEOUT_MS);
  } catch (err) {
    return { state: "error", reason: errorText(err) };
  }

  // 204 — канал выключен в админке; 404 — сервер старой версии.
  if (res.status === 204 || res.status === 404) return { state: "none" };
  if (res.status !== 200) return { state: "error", reason: `HTTP ${res.status}` };

  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch {
    return { state: "invalid", reason: "manifest is not valid JSON" };
  }

  const decision = decideUpdate(raw, app.getVersion(), process.arch);
  if (decision.kind === "none") return { state: "none" };
  if (decision.kind === "invalid") return { state: "invalid", reason: decision.reason };

  const absoluteUrl = resolveUpdateUrl(base, decision.url);
  if (!absoluteUrl) return { state: "invalid", reason: "unsafe update url" };

  let fileName: string;
  try {
    fileName = path.basename(new URL(absoluteUrl).pathname);
  } catch {
    return { state: "invalid", reason: "bad installer file name" };
  }
  // Windows: `\` в имени — разделитель пути, `..` — выход из каталога.
  // Разрешаем только безопасный whitelist (наши имена — ASCII).
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.includes("..")) {
    return { state: "invalid", reason: "bad installer file name" };
  }

  pending = {
    version: decision.version,
    url: absoluteUrl,
    sha256: decision.sha256,
    size: decision.size,
    fileName,
    dir: path.join(app.getPath("userData"), "updates", decision.version),
  };
  sweepDownloads(decision.version);

  return {
    state: "update",
    version: decision.version,
    notes: decision.notes,
    size: decision.size,
    url: absoluteUrl,
  };
}

/**
 * Скачать установщик по ранее сохранённому плану, проверить размер и sha256.
 * Прогресс отдаётся событием `updater-progress` (троттлинг 200 мс).
 */
export async function downloadPending(
  onProgress?: (received: number, total: number) => void,
): Promise<{ path: string; version: string }> {
  const plan = pending;
  if (!plan) throw new Error("no pending update — сначала updater.check");

  fs.mkdirSync(plan.dir, { recursive: true });
  const partPath = path.join(plan.dir, `${plan.fileName}.part`);
  const finalPath = path.join(plan.dir, plan.fileName);
  try {
    fs.rmSync(partPath, { force: true });
  } catch {
    /* нет файла — ок */
  }

  let lastEmit = 0;
  const origin = new URL(plan.url).origin;

  try {
    await new Promise<void>((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      let received = 0;
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const request = (url: string, redirectsLeft: number): void => {
        const req = https.get(
          url,
          {
            headers: {
              "User-Agent": `ARTEL-Desktop/${app.getVersion()}`,
              Accept: "application/octet-stream",
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;

            if (status >= 300 && status < 400 && location) {
              res.resume();
              if (redirectsLeft <= 0) {
                fail(new Error("too many redirects"));
                return;
              }
              let next: URL;
              try {
                next = new URL(location, url);
              } catch {
                fail(new Error("bad redirect location"));
                return;
              }
              if (next.protocol !== "https:" || next.origin !== origin) {
                fail(new Error("unsafe redirect"));
                return;
              }
              request(next.toString(), redirectsLeft - 1);
              return;
            }

            if (status !== 200) {
              res.resume();
              fail(new Error(`HTTP ${status}`));
              return;
            }

            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              hash.update(chunk);
              if (received > plan.size) {
                req.destroy(new Error("installer is larger than manifest size"));
                return;
              }
              const now = Date.now();
              if (onProgress && now - lastEmit >= PROGRESS_MIN_INTERVAL_MS) {
                lastEmit = now;
                onProgress(received, plan.size);
              }
            });

            const out = fs.createWriteStream(partPath);
            pipeline(res, out, (err) => {
              if (err) {
                fail(err instanceof Error ? err : new Error(String(err)));
                return;
              }
              if (received !== plan.size) {
                fail(new Error(`size mismatch: ${received} != ${plan.size}`));
                return;
              }
              if (hash.digest("hex") !== plan.sha256) {
                fail(new Error("sha256 mismatch"));
                return;
              }
              settled = true;
              resolve();
            });
          },
        );
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () =>
          req.destroy(new Error("download timeout")),
        );
        req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      };

      request(plan.url, MAX_REDIRECTS);
    });
  } catch (err) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  try {
    fs.rmSync(finalPath, { force: true });
  } catch {
    /* ignore */
  }
  fs.renameSync(partPath, finalPath);
  if (onProgress) onProgress(plan.size, plan.size);
  return { path: finalPath, version: plan.version };
}

/**
 * Запустить скачанный NSIS-установщик в тихом режиме и выйти из приложения.
 *
 * Аргументы electron-builder NSIS:
 *   /S          — silent (без страниц);
 *   --updated   — «это обновление»: разрешает приложению выйти самому и не
 *                 трогает пользовательские данные;
 *   --force-run — после установки поднять новую версию (для assisted-installer
 *                 авто-запуск включается только этим флагом).
 */
export function installPending(): { status: "installing"; version: string } {
  const plan = pending;
  if (!plan) throw new Error("no pending update — сначала updater.check");

  const installer = path.join(plan.dir, plan.fileName);
  if (!fs.existsSync(installer)) {
    throw new Error("installer is not downloaded");
  }

  const child = spawn(installer, ["/S", "--updated", "--force-run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  // Даём IPC-ответу дойти до renderer, затем штатно закрываемся: NSIS ждёт
  // выхода приложения (для --updated) и ставит файлы поверх.
  setTimeout(() => app.quit(), 500);
  return { status: "installing", version: plan.version };
}

/** Версия и архитектура текущего клиента (для окна и диагностики). */
export function currentVersion(): { version: string; arch: string } {
  return { version: app.getVersion(), arch: process.arch };
}
