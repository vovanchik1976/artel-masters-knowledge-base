/**
 * Форма вложений карточки (SP-20, D-094) — гейты клиентской части.
 *
 * Проверяем то, что видит мастер и что легко сломать незаметно:
 *   A1  разметка списка: тип, имя файла, размер, описание (экранировано);
 *   A2  пустой список — «станьте первым», а не пустота;
 *   A3  кнопка снятия только там, где сервер разрешит (автор/владелец);
 *   A4  предел вложений гасит кнопку «Добавить файл» (сервер всё равно проверит);
 *   A5  выбранный тип и введённое описание живут в состоянии, а не в DOM
 *       (перерисовка/смена языка не сбрасывает ввод — правило i18n-дока);
 *   A6  анти-дрейф лимитов с сервером (`card_attachment_service.py`);
 *   A7  D-094: в форме нет ни баллов, ни цены — вложение не биллингуется;
 *   A8  страница монтирует форму и для публичной, и для личной карточки.
 *
 * Раннер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  ATTACHMENT_PICK_TIMEOUT_MS,
  attachmentKindLabel,
  attachmentLabel,
  attachmentLimitReached,
  defaultAttachmentState,
  pickOutcomeHint,
  renderAttachmentFormHtml,
  resolvePickedFile,
  type AttachmentFormState,
  type CardAttachmentItem,
} from "../src/ui/AttachmentForm";
import {
  ATTACHMENT_KINDS,
  MAX_ATTACHMENTS_FALLBACK,
  MAX_ATTACHMENT_NOTE_CHARS,
} from "../src/ui/AttachmentUploader";

/** Корень проекта (тесты компилируются в `tmp-tests/`, ищем вверх по дереву). */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("project root not found");
    dir = parent;
  }
}

function item(over: Partial<CardAttachmentItem> = {}): CardAttachmentItem {
  return {
    id: 12,
    att_kind: "isp_emmc",
    note: "",
    mime: "image/jpeg",
    size_bytes: 1024 * 1024,
    original_name: "isp.jpg",
    author_tg_id: 42,
    created_at: "2026-10-17T10:00:00+00:00",
    has_anchor: true,
    ...over,
  };
}

function state(over: Partial<AttachmentFormState> = {}): AttachmentFormState {
  return { ...defaultAttachmentState(), ...over };
}

// ─── A1: разметка списка вложений ──────────────────────────────────────────

test("A1: вложение — вид-кнопка просмотра + превью в реальном времени, без имени файла", () => {
  const html = renderAttachmentFormHtml(
    [
      item({
        id: 7,
        original_name: "board.jpg",
        mime: "image/jpeg",
        thumb_url: "https://example.com/thumbs/xyz.png",
        note: "<b>разъём</b> сбоку",
      }),
      item({ id: 8, att_kind: "service_manual", original_name: "sm.pdf", size_bytes: 0 }),
    ],
    state(),
  );
  assert.match(html, /data-att-id="7"/);
  // Имя файла не пишем — только вид вложения.
  assert.doesNotMatch(html, /board\.jpg/);
  // Имя файла и его размер не рисуются в строке — только вид + кнопка просмотра + превью.
  assert.doesNotMatch(html, /attachment-name/);
  assert.doesNotMatch(html, /attachment-size/);
  // Описание экранируется: сырого HTML из сервера/чужого мастера в DOM не пускаем.
  assert.match(html, /&lt;b&gt;разъём&lt;\/b&gt; сбоку/);
  assert.doesNotMatch(html, /<b>разъём<\/b>/);
  // Вид вложения — человеческой подписью из i18n, а не сырым `service_manual`.
  assert.match(html, /Service Manual/);
  assert.match(html, /ISP connection eMMC/);
  // Тактическая кнопка-просмотр с названием вида — у каждой строки.
  assert.match(html, /class="attachment-kind-btn"/);
  assert.equal((html.match(/attachment-kind-btn/g) || []).length, 2);
  // Превью в реальном времени — только для изображений (board.jpg, не sm.pdf),
  // с реальным адресом превью.
  assert.equal((html.match(/attachment-preview/g) || []).length, 1);
  assert.match(html, /src="https:\/\/example.com\/thumbs\/xyz\.png"/);
  assert.match(html, /alt="ISP connection eMMC"/);
  // Кнопка скачивания остаётся у каждой строки.
  assert.equal((html.match(/attachment-open/g) || []).length, 2);
});

test("A2: пустой список — подсказка «станьте первым», а не пустота", () => {
  const html = renderAttachmentFormHtml([], state());
  assert.match(html, /attachment-empty/);
  assert.match(html, /class="attachment-list"/);
  assert.doesNotMatch(html, /attachment-open/);
});

test("A3: кнопка снятия — только там, где сервер разрешит (автор/владелец)", () => {
  const items = [item({ id: 1 }), item({ id: 2 })];
  const html = renderAttachmentFormHtml(items, state(), (it) => it.id === 2);
  assert.equal((html.match(/attachment-remove/g) || []).length, 1);
  assert.match(html, /attachment-remove" data-att-id="2"/);
});

test("A4: предел вложений гасит кнопку «Добавить файл»", () => {
  const many = Array.from({ length: 20 }, (_, i) => item({ id: i + 1 }));
  assert.equal(attachmentLimitReached(19, state()), false);
  assert.equal(attachmentLimitReached(20, state()), true);
  const html = renderAttachmentFormHtml(many, state({ maxAttachments: 20 }));
  assert.match(html, /attachment-add-btn" disabled/);
  assert.match(html, /уже приложено 20|already has 20|вже додано 20/);
});

test("A5: тип и описание живут в состоянии — перерисовка не сбрасывает ввод", () => {
  const html = renderAttachmentFormHtml(
    [],
    state({ attKind: "bulletin", note: "бюллетень по подсветке" }),
  );
  assert.match(html, /value="bulletin" selected/);
  assert.match(html, /value="бюллетень по подсветке"/);
  // Тип по умолчанию — фото ISP/eMMC (самый частый случай у мастера).
  assert.equal(defaultAttachmentState().attKind, "isp_emmc");
});

test("A6: лимиты клиента совпадают с серверными (анти-дрейф)", () => {
  const service = path.join(projectRoot(), "..", "bot", "services", "card_attachment_service.py");
  if (!fs.existsSync(service)) {
    // client-only checkout: сверять не с чем, но значения обязаны быть sane.
    assert.ok(MAX_ATTACHMENTS_FALLBACK > 0);
    return;
  }
  const src = fs.readFileSync(service, "utf8");
  const limit = /^MAX_PER_CARD_ATTACHMENTS\s*=\s*(\d+)\s*$/m.exec(src);
  const note = /^MAX_NOTE_CHARS\s*=\s*(\d+)\s*$/m.exec(src);
  assert.ok(limit, "в card_attachment_service.py не найден MAX_PER_CARD_ATTACHMENTS");
  assert.ok(note, "в card_attachment_service.py не найден MAX_NOTE_CHARS");
  assert.equal(Number(limit[1]), MAX_ATTACHMENTS_FALLBACK);
  assert.equal(Number(note[1]), MAX_ATTACHMENT_NOTE_CHARS);
  // Типы вложений — единый перечень (иначе сервер ответит 400 на новый тип).
  for (const kind of ATTACHMENT_KINDS) {
    assert.match(src, new RegExp(`"${kind}"`), `сервер не знает тип ${kind}`);
  }
});

test("A7: D-094 — вложение не биллингуется (в форме нет баллов/цены)", () => {
  const src = fs.readFileSync(
    path.join(projectRoot(), "src", "ui", "AttachmentForm.ts"),
    "utf8",
  );
  for (const forbidden of ["chargePoints", "creditPoints", "balance", "checkAccess"]) {
    assert.equal(
      src.includes(forbidden),
      false,
      `форма вложений не имеет права трогать баллы (найдено ${forbidden})`,
    );
  }
});

test("A8: страница монтирует форму для публичной и личной карточки", () => {
  const src = fs.readFileSync(path.join(projectRoot(), "src", "ui", "SearchPage.ts"), "utf8");
  assert.match(src, /_mountAttachments\(\s*summaryHost,\s*"file"/);
  assert.match(src, /_mountAttachments\(attHost, "personal"/);
  // Формы снимаются вместе с DOM (иначе висящие ссылки/утечки).
  assert.match(src, /for \(const form of this\.attachmentForms\.values\(\)\) form\.unmount\(\)/);
  // Смена языка перерисовывает подписи, не сбрасывая ввод.
  assert.match(src, /for \(const form of this\.attachmentForms\.values\(\)\) form\.applyLang\(\)/);
});

test("A9: подписи типов переводятся, неизвестный тип не прячется", () => {
  assert.notEqual(attachmentKindLabel("isp_emmc"), "isp_emmc");
  assert.equal(attachmentKindLabel("legacy_kind"), "legacy_kind");
  assert.match(attachmentLabel(item({ att_kind: "bulletin" })), /isp\.jpg|bulletin/i);
});

// ─── A10–A16: тихий отказ выбора файла (BUG-ATTACH-SILENT-001) ─────────────
//
// Живой случай 2026-10-17 (x32/wine): нажатие «Добавить файл» не дало НИ
// подсказки, НИ лога, НИ запроса к движку. Причина класса: ожидание диалога
// выбора файла было бесконечным, а `null`/пустой `path` выходили из формы
// молча. Здесь фиксируем КАЖДЫЙ исход выбора — тишины быть не может.

test("A10: отмена выбора файла — отдельный исход и подсказка мастеру", async () => {
  const outcome = await resolvePickedFile(async () => null, 50);
  assert.equal(outcome.status, "cancelled");
  assert.ok(
    pickOutcomeHint(outcome).length > 0,
    "отмена выбора не имеет права быть тихой — мастер должен видеть, что клик сработал",
  );
});

test("A11: файл выбран, но путь пуст — исход no_path, а не тишина", async () => {
  // Electron до 32 отдаёт путь через `File.path`; пусто = диалог не дал путь.
  const outcome = await resolvePickedFile(async () => ({ path: "", name: "isp.jpg" }), 50);
  assert.equal(outcome.status, "no_path");
  assert.match(pickOutcomeHint(outcome), /путь|path|шлях/i);
});

test("A12: окно выбора не ответило — таймаут, а не вечное ожидание", async () => {
  const started = Date.now();
  const outcome = await resolvePickedFile(() => new Promise<never>(() => {}), 25);
  assert.equal(outcome.status, "timeout");
  assert.ok(Date.now() - started < 1000, "таймаут обязан срабатывать быстро, а не висеть");
  assert.ok(pickOutcomeHint(outcome).length > 0);
  assert.ok(
    ATTACHMENT_PICK_TIMEOUT_MS >= 30_000,
    "боевой таймаут не должен быть секундным — мастер выбирает файл не мгновенно",
  );
});

test("A13: нормальный выбор пути проходит без подсказки", async () => {
  const outcome = await resolvePickedFile(
    async () => ({ path: "/tmp/isp.jpg", name: "isp.jpg" }),
    50,
  );
  assert.deepEqual(outcome, { status: "picked", path: "/tmp/isp.jpg", name: "isp.jpg" });
  assert.equal(pickOutcomeHint(outcome), "");
});

test("A14: ошибка открытия диалога не теряется — уходит в подсказку", async () => {
  const outcome = await resolvePickedFile(async () => {
    throw new Error("dialog is not available");
  }, 50);
  assert.equal(outcome.status, "error");
  assert.match(pickOutcomeHint(outcome), /dialog is not available/);
});

test("A15: диалог выбора файла закрывается по cancel и снимается из DOM", () => {
  const src = fs.readFileSync(path.join(projectRoot(), "src", "ui", "SearchPage.ts"), "utf8");
  const start = src.indexOf("private _pickAttachmentFile");
  assert.ok(start > 0, "в SearchPage.ts не найден _pickAttachmentFile");
  const end = src.indexOf("private async _uploadAttachment", start);
  assert.ok(end > start, "не найден конец _pickAttachmentFile");
  const block = src.slice(start, end);
  // Без слушателя `cancel` закрытие диалога без выбора оставляет промис висеть.
  assert.match(block, /addEventListener\("cancel"/);
  // Скрытый input обязан жить в DOM: часть сборок Electron иначе не шлёт события.
  assert.match(block, /document\.body\.appendChild\(input\)/);
  // Обработчики и сам input снимаются — иначе утечка на каждый клик.
  assert.match(block, /removeEventListener\("change"/);
  assert.match(block, /input\.remove\(\)/);
});

test("A16: пока диалог открыт, кнопка не открывает второй диалог", () => {
  const html = renderAttachmentFormHtml([], state({ picking: true }));
  assert.match(html, /attachment-add-btn" disabled/);
});

