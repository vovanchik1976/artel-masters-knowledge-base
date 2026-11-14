/**
 * Медиа карточки на СТРАНИЦЕ ЗАГРУЗКИ (SP-15 v3, D-069).
 *
 * Приказ владельца: «Пользователю даётся отдельный инструмент в описании к файлу —
 * загрузить медиафайл…». Форма загрузки И ЕСТЬ описание файла, поэтому после
 * успешного `/complete` на вкладке «Загрузка» обязан появиться инструмент
 * («📎 Добавить медиа» + галерея превью). Раньше кнопка жила ТОЛЬКО в карточке
 * «Поиска»/«Личных файлов» — сразу после загрузки пользователь её не видел
 * (дефект владельца, живой прогон 2026-10-13).
 *
 *   P1 публичный путь: карточка = `file_id` ответа `/complete`;
 *   P2 личный путь: карточка = `personal_file_id` (флаг `personal`);
 *   P3 дедуп/перепривязка (`duplicate`/`reanchored`) — карточка уже в каталоге;
 *   P4 нет карточки (пустой ответ / `file_id=0`) → панель НЕ показываем (fail-open);
 *   P5 `personal_file_id` без флага `personal` — всё равно личная карточка;
 *   G1 панель тянет байты с токеном и ОСВОБОЖДАЕТ blob-URL (иначе утечка на окно);
 *   G2 `UploadPage` подключает панель именно в success-ветке (через `uploadedCardRef`);
 *   G3 хост панели есть в разметке (`#uploadMediaPanel`);
 *   G4 ключ `media.panel_title` есть во ВСЕХ трёх локалях (RU/UK/EN);
 *   G5 смена языка обновляет панель (`applyLang` → `mediaPanel?.applyLang()`);
 *   ── срез 3b (D-069 v4): фото выбираются ДО карточки ───────────────────────
 *   G6 панель поднимается на `bindEvents()` (инструмент виден ДО загрузки);
 *   G7 старт загрузки ОТВЯЗЫВАЕТ панель, но НЕ стирает выбор (`detachCard`, не `dispose`);
 *   G8 диалог выбора фото реально фильтрует изображения (UI → полифилл → main);
 *   G9 разметка и CSS очереди на месте (панель не «сырой» markup);
 *   G10 все ключи `media.*` среза 3b есть во ВСЕХ трёх локалях;
 *   G11 кольцо прогресса матчится по rust-идентификатору передачи, а не по индексу.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { uploadedCardRef } from "../src/ui/CardMediaPanel";

/** Корень проекта (там `index.html`, `src/`, `tests/`) — независимо от outDir. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`корень проекта не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

function readSource(relative: string): string {
  return fs.readFileSync(path.join(projectRoot(), relative), "utf8");
}

// ─── P1..P5: карточка по ответу /complete ───────────────────────────────────

test("P1: публичная загрузка → карточка каталога из file_id", () => {
  assert.deepEqual(
    uploadedCardRef({ upload_id: "u1", status: "completed", file_id: 42 }),
    { kind: "file", cardId: 42 },
  );
});

test("P2: личная (Vault) загрузка → личная карточка из personal_file_id", () => {
  assert.deepEqual(
    uploadedCardRef({ upload_id: "u2", status: "completed", personal: true, personal_file_id: 7 }),
    { kind: "personal", cardId: 7 },
  );
});

test("P3: дедуп/перепривязка — медиа цепляем к существующей карточке каталога", () => {
  assert.deepEqual(
    uploadedCardRef({ action: "duplicate", file_id: 12, dedup_mode: "sha256" }),
    { kind: "file", cardId: 12 },
  );
  assert.deepEqual(
    uploadedCardRef({ action: "reanchored", file_id: 13 }),
    { kind: "file", cardId: 13 },
  );
});

test("P4: карточки нет → null (панель не показываем, загрузка не страдает)", () => {
  assert.equal(uploadedCardRef({ id: 1 }), null);
  assert.equal(uploadedCardRef({ id: 1, file_id: 0 }), null);
  assert.equal(uploadedCardRef({ personal: true }), null);
  assert.equal(uploadedCardRef({ file_id: "abc" }), null);
  assert.equal(uploadedCardRef(null), null);
  assert.equal(uploadedCardRef(undefined), null);
  assert.equal(uploadedCardRef("completed"), null);
});

test("P5: personal_file_id без флага personal — личная карточка (fail-safe)", () => {
  assert.deepEqual(uploadedCardRef({ personal_file_id: 9 }), { kind: "personal", cardId: 9 });
});

// ─── G1..G5: гейты по исходникам ───────────────────────────────────────────

test("G1: панель качает байты с токеном и освобождает blob-URL", () => {
  const src = readSource(path.join("src", "ui", "CardMediaPanel.ts"));
  assert.match(
    src,
    /loadProtectedThumbs\(/,
    "превью защищённой карточки обязан тянуть JS с токеном (тег <img> не шлёт Authorization)",
  );
  assert.match(
    src,
    /revokeObjectUrls\(/,
    "blob-URL обязаны освобождаться (иначе утечка до перезапуска окна)",
  );
  assert.match(
    src,
    /openMediaLightbox\(/,
    "увеличение — общий лайтбокс (показ ОРИГИНАЛА, а не превью)",
  );
  assert.match(
    src,
    /card-add-media-btn/,
    "кнопка владельца — та же разметка, что в карточке поиска",
  );
});

test("G2: UploadPage подключает панель в success-ветке", () => {
  const src = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(
    src,
    /uploadedCardRef\(/,
    "карточка из ответа /complete определяется через uploadedCardRef()",
  );
  assert.match(src, /mediaPanel\.show\(/, "панель обязана ПОКАЗЫВАТЬСЯ после успешной загрузки");
  const done = src.indexOf("this.progress.setDone()");
  const showCall = src.indexOf("this._showCardMedia(completeResult)");
  assert.ok(done >= 0, "нет точки завершения передачи (progress.setDone)");
  assert.ok(showCall >= 0, "нет вызова _showCardMedia(completeResult) в success-ветке");
  assert.ok(
    showCall > done,
    "панель показываем ПОСЛЕ завершения передачи (иначе цепляемся к несуществующей карточке)",
  );
});

test("G3: хост панели есть в разметке вкладки «Загрузка»", () => {
  const html = readSource("index.html");
  assert.match(html, /id="uploadMediaPanel"/, "нет хоста #uploadMediaPanel — панели некуда рисоваться");
  const uploadTab = html.indexOf('id="tab-upload"');
  const host = html.indexOf('id="uploadMediaPanel"');
  assert.ok(host > uploadTab, "панель обязана быть ВНУТРИ вкладки загрузки");
});

test("G4: ключ media.panel_title есть во всех трёх локалях", () => {
  for (const locale of ["ru", "uk", "en"]) {
    const src = readSource(path.join("src", "i18n", "locales", `${locale}.ts`));
    assert.match(
      src,
      /panel_title:/,
      `в локали ${locale} нет media.panel_title — панель осталась бы без подписи`,
    );
  }
});

test("G5: смена языка обновляет панель (i18n-правило «без залипания»)", () => {
  const src = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(
    src,
    /mediaPanel\?\.applyLang\(\)/,
    "applyLang() обязан переводить панель — иначе после смены языка она «залипает»",
  );
});

// ─── G6..G11: срез 3b — фото выбираются ДО карточки (D-069 v4) ─────────────

test("G6: панель видна СРАЗУ — поднимается на bindEvents()", () => {
  const page = readSource(path.join("src", "ui", "UploadPage.ts"));
  const bindEvents = page.indexOf("bindEvents(): void");
  assert.ok(bindEvents >= 0, "не найден bindEvents() страницы загрузки");
  const created = page.indexOf("new CardMediaPanel(this.mediaPanelHost");
  assert.ok(created > bindEvents, "панель обязана подниматься в bindEvents() — иначе фото нельзя выбрать заранее");
  assert.match(
    page,
    /this\.mediaPanel\.bind\(\)/,
    "панель обязана связываться с разметкой на старте страницы",
  );
  const panel = readSource(path.join("src", "ui", "CardMediaPanel.ts"));
  assert.match(
    panel,
    /this\.root\.style\.display = "block"/,
    "bind() обязан показывать панель: без карточки она тоже нужна (выбор фото)",
  );
});

test("G7: старт загрузки отвязывает панель, но НЕ стирает выбранное", () => {
  const page = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(
    page,
    /mediaPanel\?\.detachCard\(\)/,
    "старт новой загрузки обязан отвязывать панель от прошлой карточки (detachCard)",
  );
  const panel = readSource(path.join("src", "ui", "CardMediaPanel.ts"));
  const start = panel.indexOf("detachCard(): void {");
  assert.ok(start >= 0, "в панели нет detachCard() — выбор фото будет теряться при старте загрузки");
  const body = panel.slice(start, panel.indexOf("\n  }", start));
  assert.match(body, /dropSettled\(\)/, "detachCard обязан снимать только «хвосты» (dropSettled)");
  assert.ok(
    !/queue\.clear\(\)/.test(body),
    "detachCard НЕ имеет права стирать очередь: пользователь выбрал фото ДО карточки",
  );
});

test("G8: диалог выбора фото фильтрует изображения (UI → полифилл → main)", () => {
  const page = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(page, /pickPhotos: \(\) => this\._pickPhotos\(\)/, "панели не отдан диалог выбора фото");
  assert.match(page, /filters: \[/, "диалог без filters: пользователь видит в LS любые файлы");
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    assert.ok(page.includes(`"${ext}"`), `в фильтре изображений нет расширения ${ext}`);
  }
  const polyfill = readSource(path.join("tauri-polyfill", "dialog.ts"));
  assert.match(polyfill, /filters: options\?\.filters/, "полифилл dialog теряет filters");
  const main = readSource(path.join("electron", "main.ts"));
  assert.match(
    main,
    /filters: filters\.length > 0 \? filters : undefined/,
    "showOpenDialog в main не пробрасывает filters — фильтр молча не применится",
  );
});

test("G9: разметка и CSS очереди на месте (панель не «сырой» markup)", () => {
  const html = readSource("index.html");
  assert.match(html, /class="upload-media-panel"/, "нет класса хоста панели для CSS/тестов");
  for (const cls of [
    ".card-add-media-btn",
    ".card-media-list",
    ".card-media-item",
    ".card-media-preview",
    ".card-media-ring",
    ".card-media-counter",
    ".fw-ring--spin",
  ]) {
    assert.ok(html.includes(cls), `в index.html нет CSS для ${cls} — панель выглядит «сырой»`);
  }
});

test("G10: ключи media.* среза 3b есть во ВСЕХ трёх локалях", () => {
  const keys = [
    "panel_title_new",
    "wait_card",
    "card_bound",
    "sending_now",
    "pick_btn",
    "counter",
    "st_waiting",
    "st_sending",
    "st_sent",
    "st_error",
    "retry_btn",
    "remove_hint",
    "size_warn",
    "duplicate",
    "limit_reached",
    "pick_title",
  ];
  for (const locale of ["ru", "uk", "en"]) {
    const src = readSource(path.join("src", "i18n", "locales", `${locale}.ts`));
    for (const key of keys) {
      assert.ok(
        new RegExp(`\\b${key}:`).test(src),
        `в локали ${locale} нет media.${key} — панель осталась бы с ключом вместо текста`,
      );
    }
  }
});

test("G11: кольцо прогресса матчится по rust-id передачи, а не по индексу", () => {
  const page = readSource(path.join("src", "ui", "UploadPage.ts"));
  assert.match(
    page,
    /listenProgress: \(cb: \(e: MediaProgressEvent\) => void\) => this\._listenMediaProgress\(cb\)/,
    "панели не отдана подписка на прогресс — кольцо не оживёт",
  );
  assert.match(page, /tdlib-upload-progress/, "подписка обязана слушать родное событие TDLib");
  const panel = readSource(path.join("src", "ui", "CardMediaPanel.ts"));
  assert.match(
    panel,
    /event\?\.upload_id !== current\.rustUploadId/,
    "прогресс обязан адресоваться конкретной передаче (rust upload_id), иначе кольцо «прыгает»",
  );
  assert.match(
    panel,
    /onUploadStarted: \(rustUploadId\)/,
    "кольцу нужен идентификатор передачи от загрузчика (onUploadStarted)",
  );
});
