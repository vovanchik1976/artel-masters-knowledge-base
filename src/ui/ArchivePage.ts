/**
 * ArchivePage — вкладка «Архиватор» (Фаза 3, BUG-SMART-SINGLE-UPLOAD-003).
 *
 * Ручные операции с локальными архивами — БЕЗ облака и баллов:
 *  1. **Упаковать**: файл/папка → `pack_archive` (контейнер tar.zst | zip,
 *     уровень zstd 1/3/19) → результат сразу по выбранному пути;
 *  2. **Распаковать**: локальный `.zip`/`.tar.zst`/`.tzst` → `unpack_archive`
 *     (контейнер определяется по magic в Rust) → каталог пользователя.
 *
 * Почему `outputPath` передаётся в Rust, а не «temp + rename»: temp-каталог
 * может лежать на другом диске, и `rename_file` к цели упал бы с EXDEV.
 *
 * UI-правила проекта: i18n только через textContent/значения полей (форму
 * НЕ пересоздаём), логи — всегда EN, никаких секретов/путей в облако.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import { ProgressUI } from "./Progress";

/** Контейнер упаковки в этой вкладке (совпадает с Rust `ArchiveContainer`). */
type LocalContainer = "tar_zst" | "zip";

/**
 * Кадр прогресса из движка (M2 `archive-progress`).
 *
 * `total === 0` — размер неизвестен: полоса остаётся в неопределённом режиме
 * (пульс «⏳»), ложных 100 % не рисуем.
 */
interface ArchiveProgressPayload {
  op?: string;
  processed?: number;
  total?: number;
}

export class ArchivePage {
  private readonly root: HTMLElement;

  private logEl!: HTMLElement;
  private pickFileBtn!: HTMLButtonElement;
  private pickFolderBtn!: HTMLButtonElement;
  private packBtn!: HTMLButtonElement;
  private sourcePathEl!: HTMLElement;
  private sourceInfoEl!: HTMLElement;
  private levelSelect!: HTMLSelectElement;
  private levelLabel!: HTMLElement;
  private containerLabel!: HTMLElement;
  private packTitleEl!: HTMLElement;

  private pickArchiveBtn!: HTMLButtonElement;
  private unpackBtn!: HTMLButtonElement;
  private pickDestBtn!: HTMLButtonElement;
  private archivePathEl!: HTMLElement;
  private destPathEl!: HTMLElement;
  private unpackTitleEl!: HTMLElement;

  private tarZstRadio!: HTMLInputElement;
  private zipRadio!: HTMLInputElement;

  /** Детерминированная полоса прогресса упаковки/распаковки. */
  private progress: ProgressUI;
  /** Контейнер полосы — показываем только на время операции. */
  private progressContainer!: HTMLElement;
  /**
   * Поколение операции: поздние кадры/колбэки прошлой операции игнорируются
   * (иначе после отмены или второй операции полоса «дёргается» назад).
   */
  private _opToken = 0;
  /** Текущая операция — фильтр по `payload.op` (pack и unpack не смешиваются). */
  private _activeOp: "pack" | "unpack" | null = null;

  /** Выбранный источник для упаковки (файл или папка). */
  private sourcePath: string | null = null;
  private sourceIsDir: boolean = false;
  /** Выбранный архив для распаковки. */
  private archivePath: string | null = null;
  /** Каталог распаковки; `null` → рядом с архивом (имя без расширения). */
  private destDir: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    // id-ы совпадают с index.html (#archiveProgress*): ProgressUI кеширует
    // элементы сам, контейнер скрыт/показан через `_beginProgress/_endProgress`.
    this.progress = new ProgressUI(
      "archiveProgress",
      "archiveProgressFill",
      "archiveProgressText",
      "archiveProgressEta",
    );
  }

  bindEvents(): void {
    this.logEl = this.root.querySelector("#archiveLog") as HTMLElement;
    this.progressContainer = this.root.querySelector("#archiveProgress") as HTMLElement;
    this.pickFileBtn = this.root.querySelector("#archivePickFileBtn") as HTMLButtonElement;
    this.pickFolderBtn = this.root.querySelector("#archivePickFolderBtn") as HTMLButtonElement;
    this.packBtn = this.root.querySelector("#archivePackBtn") as HTMLButtonElement;
    this.sourcePathEl = this.root.querySelector("#archiveSourcePath") as HTMLElement;
    this.sourceInfoEl = this.root.querySelector("#archiveSourceInfo") as HTMLElement;
    this.levelSelect = this.root.querySelector("#archiveLevelSelect") as HTMLSelectElement;
    this.levelLabel = this.root.querySelector("#archiveLevelLabel") as HTMLElement;
    this.containerLabel = this.root.querySelector("#archiveContainerLabel") as HTMLElement;
    this.packTitleEl = this.root.querySelector("#archivePackTitle") as HTMLElement;

    this.pickArchiveBtn = this.root.querySelector("#archivePickArchiveBtn") as HTMLButtonElement;
    this.unpackBtn = this.root.querySelector("#archiveUnpackBtn") as HTMLButtonElement;
    this.pickDestBtn = this.root.querySelector("#archivePickDestBtn") as HTMLButtonElement;
    this.archivePathEl = this.root.querySelector("#archiveArchivePath") as HTMLElement;
    this.destPathEl = this.root.querySelector("#archiveDestPath") as HTMLElement;
    this.unpackTitleEl = this.root.querySelector("#archiveUnpackTitle") as HTMLElement;

    this.tarZstRadio = this.root.querySelector("#archiveContainerTarZst") as HTMLInputElement;
    this.zipRadio = this.root.querySelector("#archiveContainerZip") as HTMLInputElement;

    this.pickFileBtn.addEventListener("click", () => {
      void this._pickSource(false);
    });
    this.pickFolderBtn.addEventListener("click", () => {
      void this._pickSource(true);
    });
    this.packBtn.addEventListener("click", () => {
      void this.pack();
    });
    this.pickArchiveBtn.addEventListener("click", () => {
      void this._pickArchive();
    });
    this.pickDestBtn.addEventListener("click", () => {
      void this._pickDest();
    });
    this.unpackBtn.addEventListener("click", () => {
      void this.unpack();
    });

    // Выбор контейнера переживает перезапуск (как в Upload) — мелочь, но
    // пользователь, у которого «не открывается .tar.zst», вернётся к ZIP.
    try {
      if (localStorage.getItem("fw_archive_container") === "zip") {
        this.zipRadio.checked = true;
        this.tarZstRadio.checked = false;
      }
    } catch { /* ignore */ }
    for (const radio of [this.tarZstRadio, this.zipRadio]) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        try {
          localStorage.setItem("fw_archive_container", this.container());
        } catch { /* ignore */ }
      });
    }

    this.applyLang();
    this._renderSource();
    this._renderArchive();
  }

  /** Активный контейнер упаковки (radio; default tar.zst). */
  private container(): LocalContainer {
    return this.zipRadio?.checked ? "zip" : "tar_zst";
  }

  /** Уровень сжатия по контейнеру (zstd 1/3/19; deflate принимает 1/3/9). */
  private level(): number {
    const raw = Number(this.levelSelect?.value ?? "3");
    if (!Number.isFinite(raw)) return 3;
    if (this.container() === "tar_zst") {
      // zstd: 1 (швидко) / 3 (баланс) / 19 (максимум).
      if (raw <= 1) return 1;
      if (raw >= 19) return 19;
      return 3;
    }
    // deflate 0-9: тот же «смысловой» выбор 1/3/9 (максимум — 9).
    if (raw <= 1) return 1;
    if (raw >= 19) return 9;
    return 3;
  }

  /** Выбрать источник упаковки (файл или папку). */
  private async _pickSource(directory: boolean): Promise<void> {
    try {
      const picked = await open({
        multiple: false,
        directory,
        title: directory ? t("archive.pick_folder") : t("archive.pick_file"),
      });
      const path = (picked as string) ?? "";
      if (!path) return;
      this.sourcePath = path;
      this.sourceIsDir = directory;
      this._renderSource();
      this.log(`Source selected: ${path} (${directory ? "folder" : "file"})`, "info");
    } catch (e: any) {
      this.log(`❌ Source pick error: ${e?.message ?? String(e)}`, "error");
    }
  }

  /** Отрисовать состояние блока упаковки (пути + доступность кнопок). */
  private _renderSource(): void {
    const has = !!this.sourcePath;
    this.sourcePathEl.textContent = this.sourcePath ?? t("archive.not_selected");
    this.packBtn.disabled = !has;
    this.sourceInfoEl.textContent = has
      ? this.sourceIsDir
        ? t("archive.kind_folder")
        : t("archive.kind_file")
      : "";
  }

  // ── Прогресс операции (детерминированная полоса) ──────────────────────────

  /**
   * Начать операцию: показать полосу в неопределённом режиме («⏳ Пакування…»)
   * и подписаться на кадры движка.
   *
   * Троттлинг кадров — в Rust (M2), здесь НИКАКОЙ фильтрации по времени: UI
   * только рисует то, что пришло. Возвращает поколение операции и unlisten.
   */
  private async _beginProgress(
    op: "pack" | "unpack",
  ): Promise<{ token: number; unlisten: UnlistenFn }> {
    const token = ++this._opToken;
    this._activeOp = op;
    if (this.progressContainer) this.progressContainer.style.display = "";
    this.progress.startBusy(op === "pack" ? t("archive.packing") : t("archive.unpacking"));

    let unlisten: UnlistenFn = () => {};
    try {
      unlisten = await listen<ArchiveProgressPayload>("archive-progress", (e) => {
        this._onArchiveProgress(token, op, e.payload);
      });
    } catch (e: any) {
      this.log(`⚠️ Progress subscribe failed: ${e?.message ?? String(e)}`, "warn");
    }
    return { token, unlisten };
  }

  /** Кадр движка → полоса. Поздние кадры прошлой операции — мимо. */
  private _onArchiveProgress(
    token: number,
    op: "pack" | "unpack",
    payload: ArchiveProgressPayload | undefined,
  ): void {
    if (token !== this._opToken || this._activeOp !== op) return;
    if (payload?.op !== op) return;
    const processed = Number(payload?.processed ?? 0);
    const total = Number(payload?.total ?? 0);
    // total<=0 — размер неизвестен: остаёмся в пульсе, ложных 100 % не рисуем.
    if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) return;
    this.progress.report(processed, total);
  }

  /**
   * Завершить операцию: снять подписку и погасить полосу.
   *
   * Успех → «✅ 100 %» остаётся видимым как подтверждение (как в Download);
   * ошибка → «❌ …» и контейнер сразу прячется (детали — в логе вкладки).
   */
  private _endProgress(
    token: number,
    unlisten: UnlistenFn,
    ok: boolean,
    errorText: string,
  ): void {
    unlisten();
    if (token !== this._opToken) return; // операцию перебили — чужую полосу не трогаем
    this._activeOp = null;
    if (ok) {
      this.progress.setDone();
    } else {
      this.progress.setError(errorText);
      if (this.progressContainer) this.progressContainer.style.display = "none";
    }
  }

  /**
   * Упаковать выбранный источник в выбранный контейнер.
   *
   * `save()`-диалог даёт путь результата → Rust пишет архив ПРЯМО туда
   * (`output_path`): temp-каталог может быть на другом диске, и перенос
   * `rename_file` упал бы с EXDEV.
   */
  async pack(): Promise<void> {
    if (!this.sourcePath) return;
    const container = this.container();
    const src = this.sourcePath;
    const baseName = src.split(/[/\\]/).pop() || "archive";
    const ext = container === "zip" ? "zip" : "tar.zst";

    let dest = "";
    try {
      dest = (await save({
        title: t("archive.pack_btn"),
        defaultPath: `${baseName}.${ext}`,
      })) as string;
    } catch (e: any) {
      this.log(`❌ Save dialog error: ${e?.message ?? String(e)}`, "error");
      return;
    }
    if (!dest) {
      this.log("Cancelled by the user", "warn");
      return;
    }

    this.packBtn.disabled = true;
    this.pickFileBtn.disabled = true;
    this.pickFolderBtn.disabled = true;
    // Одна операция за раз: полоса одна, кадры pack/unpack не должны смешиваться.
    this.unpackBtn.disabled = true;
    const started = Date.now();
    this.log(`📦 Packing (${container}, level=${this.level()}) → ${dest}`, "info");
    const bar = await this._beginProgress("pack");
    let ok = false;
    try {
      // `bundleHash` — только суффикс имени внутри Rust; при явном output_path
      // имя не используется вовсе (передаём короткий уникализатор для лога).
      const suffix = Date.now().toString(16).slice(-12);
      const created = await invoke<string>("pack_archive", {
        path: src,
        isDirectory: this.sourceIsDir,
        bundleHash: suffix,
        container,
        compressionLevel: this.level(),
        outputPath: dest,
      });
      const size = await invoke<{ size: number }>("get_path_info", { path: created })
        .then((i) => Number(i?.size ?? 0))
        .catch(() => 0);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log(`✅ Archive created: ${created} (${this._fmt(size)}, ${secs}s)`, "success");
      ok = true;
    } catch (e: any) {
      this.log(`❌ Pack error: ${e?.message ?? String(e)}`, "error");
    } finally {
      this._endProgress(bar.token, bar.unlisten, ok, "pack failed");
      this.packBtn.disabled = !this.sourcePath;
      this.pickFileBtn.disabled = false;
      this.pickFolderBtn.disabled = false;
      this._renderArchive();
    }
  }

  /** Выбрать локальный архив для распаковки. */
  private async _pickArchive(): Promise<void> {
    try {
      const picked = await open({
        multiple: false,
        title: t("archive.pick_archive"),
      });
      const path = (picked as string) ?? "";
      if (!path) return;
      this.archivePath = path;
      this.destDir = this._autoDest(path);
      this._renderArchive();
      this.log(`Archive selected: ${path}`, "info");
    } catch (e: any) {
      this.log(`❌ Archive pick error: ${e?.message ?? String(e)}`, "error");
    }
  }

  /** Каталог рядом с архивом: имя файла без расширения контейнера. */
  private _autoDest(archivePath: string): string {
    const sep = archivePath.includes("\\") ? "\\" : "/";
    const idx = archivePath.lastIndexOf(sep);
    const dir = idx >= 0 ? archivePath.slice(0, idx) : "";
    const name = idx >= 0 ? archivePath.slice(idx + 1) : archivePath;
    const lower = name.toLowerCase();
    let stem = name;
    for (const ext of [".tar.zst", ".tzst", ".zip"]) {
      if (lower.endsWith(ext)) {
        stem = name.slice(0, -ext.length);
        break;
      }
    }
    return dir ? `${dir}${sep}${stem}` : stem;
  }


  /** Выбрать каталог распаковки вручную (иначе — рядом с архивом). */
  private async _pickDest(): Promise<void> {
    try {
      const picked = await open({
        multiple: false,
        directory: true,
        title: t("archive.pick_dest"),
      });
      const path = (picked as string) ?? "";
      if (!path) return;
      this.destDir = path;
      this._renderArchive();
    } catch (e: any) {
      this.log(`❌ Destination pick error: ${e?.message ?? String(e)}`, "error");
    }
  }

  /** Отрисовать состояние блока распаковки. */
  private _renderArchive(): void {
    const has = !!this.archivePath;
    this.archivePathEl.textContent = this.archivePath ?? t("archive.not_selected");
    this.destPathEl.textContent = this.destDir ?? t("archive.not_selected");
    this.unpackBtn.disabled = !has;
  }

  /**
   * Распаковать выбранный архив.
   *
   * Контейнер определяет Rust по magic (zip / tar.zst), клиент лишь логирует
   * распознанный формат — «угадывать по расширению» здесь не нужно.
   */
  async unpack(): Promise<void> {
    if (!this.archivePath) return;
    const archive = this.archivePath;
    const out = this.destDir ?? this._autoDest(archive);

    this.unpackBtn.disabled = true;
    this.pickArchiveBtn.disabled = true;
    this.pickDestBtn.disabled = true;
    // Одна операция за раз (полоса одна): упаковка ждёт распаковку.
    this.packBtn.disabled = true;
    const started = Date.now();
    this.log(`🗜️ Unpacking ${archive} → ${out}`, "info");
    const bar = await this._beginProgress("unpack");
    let ok = false;
    try {
      const res = await invoke<{ container?: string }>("unpack_archive", {
        archivePath: archive,
        outputDir: out,
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.log(
        `✅ Unpacked (container=${res?.container ?? "?"}) → ${out} (${secs}s)`,
        "success",
      );
      ok = true;
    } catch (e: any) {
      this.log(`❌ Unpack error: ${e?.message ?? String(e)}`, "error");
    } finally {
      this._endProgress(bar.token, bar.unlisten, ok, "unpack failed");
      this.unpackBtn.disabled = !this.archivePath;
      this.pickArchiveBtn.disabled = false;
      this.pickDestBtn.disabled = false;
      this._renderSource();
    }
  }

  /**
   * Обновить подписи на текущем языке (i18n-правило: только textContent /
   * значения, форму НЕ пересоздаём — иначе сбрасывается выбор пользователя).
   */
  applyLang(): void {
    if (this.packTitleEl) this.packTitleEl.textContent = t("archive.pack_title");
    if (this.unpackTitleEl) this.unpackTitleEl.textContent = t("archive.unpack_title");
    if (this.containerLabel) this.containerLabel.textContent = t("archive.container_label");
    if (this.levelLabel) this.levelLabel.textContent = t("archive.level_label");
    if (this.pickFileBtn) this.pickFileBtn.textContent = t("archive.pick_file");
    if (this.pickFolderBtn) this.pickFolderBtn.textContent = t("archive.pick_folder");
    if (this.pickArchiveBtn) this.pickArchiveBtn.textContent = t("archive.pick_archive");
    if (this.pickDestBtn) this.pickDestBtn.textContent = t("archive.pick_dest");
    if (this.packBtn) this.packBtn.textContent = t("archive.pack_btn");
    if (this.unpackBtn) this.unpackBtn.textContent = t("archive.unpack_btn");
    if (this.levelSelect) {
      const optFast = this.levelSelect.querySelector('option[value="1"]');
      const optBal = this.levelSelect.querySelector('option[value="3"]');
      const optMax = this.levelSelect.querySelector('option[value="19"]');
      if (optFast) optFast.textContent = t("archive.level_fast");
      if (optBal) optBal.textContent = t("archive.level_balanced");
      if (optMax) optMax.textContent = t("archive.level_max");
    }
    if (!this.sourcePath && this.sourcePathEl) {
      this.sourcePathEl.textContent = t("archive.not_selected");
    }
    if (!this.archivePath && this.archivePathEl) {
      this.archivePathEl.textContent = t("archive.not_selected");
    }
    if (!this.destDir && this.destPathEl) {
      this.destPathEl.textContent = t("archive.not_selected");
    }
  }

  /** Человекочитаемый размер (как в остальных страницах — без i18n). */
  private _fmt(bytes: number): string {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** Лог вкладки (EN — правило проекта; лимит строк, чтобы не течь в DOM). */
  private log(message: string, kind: "info" | "success" | "warn" | "error" = "info"): void {
    if (!this.logEl) return;
    const line = document.createElement("div");
    line.className = `log-line log-${kind}`;
    line.textContent = message;
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 400) {
      this.logEl.removeChild(this.logEl.firstChild as Node);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}

