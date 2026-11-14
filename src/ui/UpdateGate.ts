/**
 * Блокирующий экран принудительного обновления (решение владельца 2026-10-18).
 *
 * Пока в админке включён канал и в манифесте есть версия новее установленной,
 * мастер НЕ работает: экран перекрывает всё окно, кнопки «Позже» нет, скачивание
 * начинается само. После установки клиент закрывается, NSIS поднимает новую
 * версию (`/S --updated --force-run`).
 *
 * Инварианты:
 *  - fail-open на недоступный сервер/битый манифест: проверка ошиблась → мастер
 *    работает дальше (нельзя «кирпичить» клиент из-за сети);
 *  - ошибка скачивания/установки НЕ разблокирует окно: показываем «Повторить» и
 *    ссылку на ручное скачивание (иначе версия останется старой навсегда);
 *  - URL установщика renderer не передаёт — его знает только main;
 *  - проверка раз в 30 минут: включение канала в админке подхватывается и у
 *    уже запущенных клиентов, а не только при следующем старте.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { t } from "../i18n";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const OVERLAY_ID = "updateGateOverlay";

interface UpdateInfo {
  state: "update";
  version: string;
  notes: string;
  size: number;
  url: string;
}

type CheckResponse =
  | { state: "disabled" | "none" }
  | { state: "invalid" | "error"; reason: string }
  | UpdateInfo;

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
) => Promise<() => void>;

export class UpdateGate {
  private overlay: HTMLDivElement | null = null;
  private busy = false;
  private timer: number | null = null;
  private currentVersion = "";

  constructor(
    private readonly invokeFn: InvokeFn = invoke,
    private readonly listenFn: ListenFn = listen,
  ) {}

  /** Первая проверка сразу + периодическая (30 мин). */
  start(): void {
    void this.check();
    this.timer = window.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Проверить манифест; при наличии новой версии — заблокировать окно. */
  async check(): Promise<void> {
    if (this.busy || this.overlay) return;
    this.busy = true;
    try {
      const ver = await this.invokeFn<{ version: string; arch: string }>("updater.version");
      this.currentVersion = (ver && ver.version) || "";
      const res = await this.invokeFn<CheckResponse>("updater.check");
      if (res && res.state === "update") {
        this.renderBlocking(res);
        await this.runDownload();
      } else if (res && (res.state === "invalid" || res.state === "error")) {
        console.warn("[updater] check failed (fail-open):", res.reason);
      }
    } catch (e) {
      // Мост/сеть недоступны — работаем дальше, повторим через 30 минут.
      console.warn("[updater] check error (fail-open):", e);
    } finally {
      this.busy = false;
    }
  }

  private renderBlocking(info: UpdateInfo): void {
    if (this.overlay) return;
    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(8,10,16,.94);" +
      "display:flex;align-items:center;justify-content:center;padding:24px;" +
      "font-family:inherit;color:#f2f5ff;";
    el.innerHTML = `
      <div style="max-width:560px;width:100%;background:#171c27;border:1px solid #2b3448;
                  border-radius:14px;padding:24px;box-sizing:border-box;">
        <h2 data-title style="margin:0 0 12px;font-size:20px;"></h2>
        <p data-required style="margin:0 0 8px;line-height:1.45;"></p>
        <p data-current style="margin:0 0 8px;opacity:.75;"></p>
        <p data-notes style="margin:0 0 8px;opacity:.7;white-space:pre-wrap;"></p>
        <div style="height:8px;background:rgba(255,255,255,.12);border-radius:4px;
                    overflow:hidden;margin:16px 0 10px;">
          <div data-bar style="height:100%;width:0%;background:#4c8dff;transition:width .2s;"></div>
        </div>
        <p data-status style="margin:0 0 12px;line-height:1.4;"></p>
        <div data-actions style="display:none;gap:8px;flex-wrap:wrap;">
          <button data-retry style="cursor:pointer;padding:8px 14px;border-radius:8px;
                  border:0;background:#4c8dff;color:#fff;font:inherit;"></button>
          <button data-manual style="cursor:pointer;padding:8px 14px;border-radius:8px;
                  border:1px solid #3a465f;background:transparent;color:#f2f5ff;font:inherit;"></button>
        </div>
      </div>`;

    document.body.appendChild(el);
    this.overlay = el;

    this.setText("title", t("updater.title"));
    this.setText("required", t("updater.required", { version: info.version }));
    this.setText("current", t("updater.current", { version: this.currentVersion }));
    const notes = el.querySelector<HTMLElement>("[data-notes]");
    if (notes) notes.textContent = info.notes || "";

    const retry = el.querySelector<HTMLButtonElement>("[data-retry]");
    if (retry) {
      retry.textContent = t("updater.retry");
      retry.addEventListener("click", () => {
        this.hideActions();
        void this.runDownload();
      });
    }
    const manual = el.querySelector<HTMLButtonElement>("[data-manual]");
    if (manual) {
      manual.textContent = t("updater.manual");
      manual.addEventListener("click", () => {
        void this.invokeFn("open_url", { url: info.url }).catch((e) =>
          console.warn("[updater] open_url failed:", e),
        );
      });
    }
  }

  private async runDownload(): Promise<void> {
    if (!this.overlay) return;
    this.hideActions();
    this.setProgress(0, t("updater.preparing"));

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await this.listenFn<{ received: number; total: number }>(
        "updater-progress",
        (e) => {
          const received = Number(e?.payload?.received) || 0;
          const total = Number(e?.payload?.total) || 0;
          if (total > 0) {
            const percent = Math.min(100, Math.floor((received * 100) / total));
            this.setProgress(percent, t("updater.downloading", { percent }));
          }
        },
      );

      await this.invokeFn("updater.download");
      this.setProgress(100, t("updater.verifying"));
      await this.invokeFn("updater.install");
      this.setStatus(t("updater.installing"));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("[updater] download/install failed:", reason);
      this.setStatus(t("updater.failed", { reason }));
      this.showActions();
    } finally {
      if (unlisten) unlisten();
    }
  }

  private setText(attr: string, value: string): void {
    const el = this.overlay?.querySelector<HTMLElement>(`[data-${attr}]`);
    if (el) el.textContent = value;
  }

  private setStatus(value: string): void {
    this.setText("status", value);
  }

  private setProgress(percent: number, status: string): void {
    const bar = this.overlay?.querySelector<HTMLElement>("[data-bar]");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    this.setStatus(status);
  }

  private showActions(): void {
    const actions = this.overlay?.querySelector<HTMLElement>("[data-actions]");
    if (actions) actions.style.display = "flex";
  }

  private hideActions(): void {
    const actions = this.overlay?.querySelector<HTMLElement>("[data-actions]");
    if (actions) actions.style.display = "none";
  }
}

let singleton: UpdateGate | null = null;

/** Запустить сторож обновлений один раз (вызывается из main.ts). */
export function startUpdateWatch(): void {
  if (singleton) return;
  singleton = new UpdateGate();
  singleton.start();
}
