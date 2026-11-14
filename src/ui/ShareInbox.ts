/**
 * Компактные входящие передачи личных файлов (SP-33, D-180).
 *
 * Раньше блок входящих занимал всю ширину под шапкой и при нескольких файлах
 * «съедал» пол-экрана. Теперь в шапке живёт маленькая кнопка со счётчиком и
 * пульсирующей точкой (видна сразу, даже когда панель закрыта), а список
 * раскрывается поповером:
 *
 *   [📨 2•]  ← клик
 *   ┌──────────────────────────────┐
 *   │ Вхідні файли            ✕    │
 *   │ • file.bin     Іван  ⏳ 71г  │
 *   │   [Зберегти] [✕]             │
 *   │ • dump.zip     Петро ⏳ 12г  │
 *   │   [Зберегти] [✕]             │
 *   │ Файл стане карткою у сховищі…│
 *   └──────────────────────────────┘
 *
 * Инварианты:
 *   * панель закрывается по Escape, клику вне и кнопке «✕»; фокус
 *     возвращается на кнопку (доступность);
 *   * обновление приходит push-событием `share_received` и одним GET при
 *     `onopen` billing WebSocket (D-181); таймеров-опросов нет;
 *   * обновление НЕ сбрасывает открытую панель и не пересобирает строки,
 *     если данные не изменились (иначе фокус «прыгает»);
 *   * «Зберегти» = файл становится карточкой в личном хранилище получателя
 *     (навигацию выполняет App), кнопка блокируется на время запроса;
 *   * анимация пульса отключается при `prefers-reduced-motion`.
 */
import { t } from "../i18n";
import { isShareExpired, remainingHours, type IncomingShare } from "./vaultShare";

export interface ShareInboxDeps {
  /** Загрузить список входящих (ошибка = пустой список, без шума в логах). */
  load: () => Promise<IncomingShare[]>;
  /** «Зберегти»: сервер зачисляет файл, App уводит в личный кабинет. */
  accept: (shareId: number) => Promise<void>;
  /** «Відхилити»: передача закрывается. */
  decline: (shareId: number) => Promise<void>;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Отпечаток списка: обновляем DOM только когда данные реально изменились. */
function inboxSignature(items: IncomingShare[]): string {
  return items
    .map((item) =>
      [
        item.share_id,
        item.file_name,
        item.sender_name,
        item.expires_at,
        item.parts_count,
      ].join("|"),
    )
    .join("::");
}

export class ShareInbox {
  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly panelTitle: HTMLElement;
  private readonly hint: HTMLElement;

  private items: IncomingShare[] = [];
  private open = false;
  private busy = new Set<number>();
  private signature = "";

  constructor(private readonly deps: ShareInboxDeps) {
    this.root = document.getElementById("shareInbox") as HTMLElement;
    this.toggle = document.getElementById("shareInboxToggle") as HTMLButtonElement;
    this.count = document.getElementById("shareInboxCount") as HTMLElement;
    this.panel = document.getElementById("shareInboxPanel") as HTMLElement;
    this.list = document.getElementById("shareInboxList") as HTMLElement;
    this.closeBtn = document.getElementById("shareInboxClose") as HTMLButtonElement;
    this.panelTitle = document.getElementById("shareInboxPanelTitle") as HTMLElement;
    this.hint = document.getElementById("shareInboxHint") as HTMLElement;

    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.closeBtn.addEventListener("click", () => this.setOpen(false, true));
    document.addEventListener("click", (event) => {
      if (!this.open) return;
      // composedPath(), а не contains(target): клик по «Зберегти» перерисовывает
      // список, кнопка отсоединяется от DOM, и contains() ложно решил бы, что
      // клик был «снаружи» — панель закрывалась бы после каждого действия.
      if (!event.composedPath().includes(this.root)) this.setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (!this.open || event.key !== "Escape") return;
      event.preventDefault();
      this.setOpen(false, true);
    });

    this.render();
  }

  /** Обновить кнопку/список по push-событию (ошибка = оставить прежнее). */
  async refresh(): Promise<void> {
    let items: IncomingShare[];
    try {
      items = (await this.deps.load()) ?? [];
    } catch {
      // Сеть/401 — не прячем уже показанные входящие: следующее событие или
      // переподключение WS обновит. Сброс делает только reset() (выход).
      return;
    }
    this.applyItems(items);
  }

  /** Сброс при выходе из аккаунта — не показывать чужие строки следующему юзеру. */
  reset(): void {
    this.busy.clear();
    this.signature = "";
    this.applyItems([], true);
  }

  /** Перерисовать подписи после смены языка (данные те же). */
  applyLang(): void {
    this.render();
  }

  /** Закрыть панель без возврата фокуса (после навигации на карточку). */
  dismiss(): void {
    this.setOpen(false);
  }

  private applyItems(items: IncomingShare[], force = false): void {
    this.items = items;
    const next = inboxSignature(items);
    if (!force && next === this.signature) return;
    this.signature = next;
    // Принятый/отклонённый файл мог исчезнуть — чистим «занятые» id.
    for (const id of Array.from(this.busy)) {
      if (!items.some((item) => item.share_id === id)) this.busy.delete(id);
    }
    this.render();
  }

  private setOpen(open: boolean, restoreFocus = false): void {
    if (open && this.items.length === 0) return;
    this.open = open;
    this.panel.hidden = !open;
    this.root.classList.toggle("is-open", open);
    this.toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      // Первый Tab поведёт по кнопкам строк — «✕» это лишь выход.
      this.closeBtn.focus();
    } else if (restoreFocus) {
      this.toggle.focus();
    }
  }

  private render(): void {
    const count = this.items.length;
    const label = t("vault.share_inbox_open", { n: count });

    this.root.hidden = count === 0;
    this.count.textContent = String(count);
    this.toggle.setAttribute("aria-label", label);
    this.toggle.setAttribute("title", label);
    this.toggle.setAttribute("aria-expanded", this.open ? "true" : "false");
    this.panelTitle.textContent = t("vault.share_inbox_panel_title");
    this.hint.textContent = t("vault.share_inbox_hint");
    this.closeBtn.setAttribute("aria-label", t("common.close"));
    this.closeBtn.title = t("common.close");

    if (count === 0) {
      this.list.replaceChildren();
      if (this.open) this.setOpen(false);
      return;
    }

    this.list.innerHTML = this.items.map((item) => this.rowHtml(item)).join("");
    this.list.querySelectorAll<HTMLButtonElement>(".share-accept-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        void this.run(Number(btn.dataset.shareId || 0), "accept");
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>(".share-decline-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        void this.run(Number(btn.dataset.shareId || 0), "decline");
      });
    });

    if (this.open) this.panel.hidden = false;
  }

  private rowHtml(item: IncomingShare): string {
    const now = Date.now();
    const expired = isShareExpired(item.expires_at, now);
    const hours = remainingHours(item.expires_at, now);
    const from = t("vault.share_inbox_from", { name: item.sender_name || "—" });
    const ttl = expired
      ? t("vault.share_expired")
      : t("vault.share_inbox_ttl", { hours });
    const busy = this.busy.has(item.share_id);
    const fileName = item.file_name || "—";

    return `
      <div class="share-inbox-item${busy ? " is-busy" : ""}" data-share-id="${item.share_id}">
        <span class="share-inbox-dot" aria-hidden="true"
          title="${escapeHtml(t("vault.share_inbox_new"))}"></span>
        <div class="share-inbox-text">
          <div class="share-inbox-file" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
          <div class="share-inbox-meta">${escapeHtml(from)} · ${escapeHtml(ttl)}</div>
        </div>
        <div class="share-inbox-actions">
          <button type="button" class="btn btn-primary share-accept-btn"
            data-share-id="${item.share_id}" ${expired || busy ? "disabled" : ""}>
            ${busy ? "…" : escapeHtml(t("vault.share_inbox_save"))}
          </button>
          <button type="button" class="btn btn-secondary share-decline-btn"
            data-share-id="${item.share_id}" ${expired || busy ? "disabled" : ""}
            aria-label="${escapeHtml(t("vault.share_decline"))}"
            title="${escapeHtml(t("vault.share_decline"))}">✕</button>
        </div>
      </div>`;
  }

  private async run(shareId: number, kind: "accept" | "decline"): Promise<void> {
    if (!shareId || this.busy.has(shareId)) return;
    this.busy.add(shareId);
    this.render();
    try {
      await (kind === "accept" ? this.deps.accept(shareId) : this.deps.decline(shareId));
    } finally {
      this.busy.delete(shareId);
      this.render();
      // Панель осталась открытой (отказ или ошибка) — вернуть фокус в список,
      // иначе после перерисовки он уходит на body.
      if (this.open) {
        this.list
          .querySelector<HTMLButtonElement>(".share-accept-btn:not([disabled])")
          ?.focus();
      }
    }
  }
}
