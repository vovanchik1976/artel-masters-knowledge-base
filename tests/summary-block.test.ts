/**
 * SummaryBlock — сводка по файлу + блок «что ещё скачать» (SP-19 S1b, §5.2 T-ST7).
 *
 * Проверяем чистые функции разметки: текст сводки экранирован (в ИИ-тексте нет
 * сырых ссылок — они приходят отдельным списком `sources[]`, §4 п.9), статусы
 * сервера дают понятную подпись вместо пустоты, а соседние файлы выводятся
 * кнопками с `data-file-id` (клик ведёт в ветку скачивания).
 *
 * Раннер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getLang, setLang } from "../src/i18n";

import {
  formEntryLabel,
  renderDownloadersHtml,
  renderFormHtml,
  renderSummaryHtml,
  storageLabel,
  summaryHintKey,
  summaryView,
  type CardFormEntry,
  type CardPayload,
  type CardStorageItem,
} from "../src/ui/SummaryBlock";

function storage(): CardStorageItem[] {
  return [
    {
      id: 22,
      brand: "LG",
      model: "42LB730V",
      version: "2.0",
      size_bytes: 1024,
      content_kind: "firmware",
      download_strategy: "single",
      tier: 1,
    },
  ];
}

function payload(over: Partial<CardPayload> = {}): CardPayload {
  return {
    file_id: 11,
    rag_summary: null,
    summary_status: "pending",
    summary_sources: [],
    storage: [],
    form: [],
    ...over,
  };
}

function entry(over: Partial<CardFormEntry> = {}): CardFormEntry {
  return { dm_id: 5, text: "Помогла замена шим LEPM21.", votes: 1, verified: false, mine: false, ...over };
}

// ── T-ST7: сводка + источники + блок скачивания ────────────────────────────

test("T-ST7: готовая сводка выводится, ссылка-источник — текстом, а не href из ИИ", () => {
  const html = renderSummaryHtml(
    payload({
      rag_summary: "LG 42LB730V — дамп eMMC, проверьте подсветку.",
      summary_status: "ready",
      summary_sources: [
        { path: "kb_v4/case-0001:1-1", url: "https://forum/x#p1" },
      ],
      storage: [
        {
          id: 12,
          brand: "LG",
          model: "42LB730V",
          version: "05.00.55",
          size_bytes: 1024,
          content_kind: "firmware",
          download_strategy: "single",
          tier: 1,
        },
      ],
    }),
  );
  assert.match(html, /дамп eMMC/, "текст сводки обязан попасть в блок");
  assert.match(
    html,
    /https:\/\/forum\/x#p1/,
    "источник отдаётся отдельной строкой (клиент рисует его из sources[])",
  );
  assert.match(html, /data-file-id="12"/, "соседний файл — кнопка с id");
  assert.match(html, /1\.0 (КБ|KB|кБ)/i, "в подписи файла есть размер");
});

test("T-ST7b: сырой HTML в тексте сводки экранируется", () => {
  const html = renderSummaryHtml(
    payload({
      rag_summary: '<a href="http://evil/x">клик</a>',
      summary_status: "ready",
    }),
  );
  assert.ok(!html.includes("<a href="), "в ИИ-тексте не бывает сырых тегов");
  assert.match(html, /&lt;a href=/, "текст экранирован, а не исполнен");
});

// ── Статусы: пустота объясняется словами (Fail-open) ───────────────────────

test("summaryHintKey: ready — текста нет, остальные статусы дают подпись", () => {
  assert.equal(summaryHintKey("ready"), null);
  assert.equal(summaryHintKey("empty"), "summary.empty");
  assert.equal(summaryHintKey("failed"), "summary.failed");
  assert.equal(summaryHintKey("pending"), "summary.pending");
  assert.equal(summaryHintKey(""), "summary.pending", "незнакомый статус — «готовится»");
  assert.equal(summaryHintKey(null), "summary.pending");
});

test("summaryView: пустая/пробельная сводка не показывается как готовый текст", () => {
  assert.deepEqual(summaryView(payload({ rag_summary: "   " })).text, "");
  const view = summaryView(payload({ rag_summary: "текст", summary_status: "ready" }));
  assert.equal(view.text, "текст");
  assert.equal(view.hintKey, null);
});

test("renderSummaryHtml без сводки: подпись статуса, а пустой блок скачивания не рисуется", () => {
  const html = renderSummaryHtml(payload({ summary_status: "pending" }));
  assert.ok(!html.includes("summary.pending"), "ключ i18n не должен утечь в разметку");
  assert.match(html, /summary-status/, "подпись статуса на месте");
  // Пустое сообщение «Рядом ничего нет…» убрано (приказ владельца): лишний шум
  // в блоке сводки не нужен, соседей просто нет.
  assert.ok(
    !html.includes("summary-storage-empty"),
    "пустое сообщение о соседях не рисуется",
  );
  assert.ok(!html.includes("summary-storage"), "пустой блок скачивания не рисуется");
});

test("renderSummaryHtml: битые записи storage (id<=0) не рисуются", () => {
  const html = renderSummaryHtml(
    payload({
      storage: [
        {
          id: 0,
          brand: "LG",
          model: "X",
          version: "",
          size_bytes: 0,
          content_kind: "",
          download_strategy: "single",
          tier: 1,
        },
      ],
    }),
  );
  assert.ok(!html.includes("data-file-id"), "запись без id — не кнопка");
});

// ── Подписи блока ─────────────────────────────────────────────────────────

test("storageLabel: бренд/модель/версия/размер, пустые части не дают лишних разделителей", () => {
  const base = {
    id: 1,
    brand: "LG",
    model: "42LB730V",
    version: "05.00.55",
    size_bytes: 2 * 1024 * 1024,
    content_kind: "firmware",
    download_strategy: "single",
    tier: 1,
  };
  assert.match(storageLabel(base), /^LG 42LB730V · 05\.00\.55 · /);
  assert.match(storageLabel({ ...base, version: "" }), /^LG 42LB730V · /);
  assert.ok(!storageLabel({ ...base, version: "" }).includes("·  ·"));
});

// ── S4: «что помогло» — опыт мастера под сводкой ──────────────────────────

test("renderFormHtml: записи мастеров, «Проверено» только от сервера, поле ввода на месте", () => {
  const html = renderFormHtml(
    payload({
      form: [
        entry({ dm_id: 1, text: "Заменил шим LEPM21.", votes: 2, verified: true }),
        entry({ dm_id: 2, text: "Помогла перепрошивка.", votes: 1, verified: false, mine: true }),
      ],
    }),
  );
  assert.match(html, /Заменил шим LEPM21/, "опыт других мастеров виден");
  assert.match(html, /summary-form-item verified/, "отметка «Проверено» есть у подтверждённой записи");
  assert.equal(
    (html.match(/summary-form-item verified/g) || []).length,
    1,
    "порог «Проверено» не рисуем сами — только там, где сервер сказал verified",
  );
  assert.match(html, /summary-form-input/, "мастер может написать, что помогло");
  assert.match(html, /summary-form-helped/);
  assert.match(html, /summary-form-not-helped/);
});

test("renderFormHtml: пусто → приглашение, а не пустая дыра", () => {
  const html = renderFormHtml(payload({ form: [] }));
  assert.match(html, /summary-form-empty/);
  assert.ok(!html.includes("summary-form-item"), "записей нет — списка нет");
});

test("renderFormHtml: битые записи (dm_id<=0) не рисуются", () => {
  const html = renderFormHtml(payload({ form: [entry({ dm_id: 0 })] }));
  assert.ok(!html.includes("summary-form-item"), "запись без id — не запись");
});

test("formEntryLabel: текст мастера + число подтверждений", () => {
  assert.match(formEntryLabel(entry({ votes: 3 })), /Помогла замена шим LEPM21\. — 👍 3/);
});

test("ИИ-текст формы экранируется как и остальной блок", () => {
  const html = renderFormHtml(
    payload({ form: [entry({ text: '<script>alert(1)</script>' })] }),
  );
  assert.ok(!html.includes("<script>"), "текст мастера не исполняется");
  assert.match(html, /&lt;script&gt;/);
});

// ─── D-134: спойлер «Кто скачал» под карточкой ─────────────────────────────

test("D-134: вертикальный спойлер со списком имён; имя моё помечено", () => {
  const html = renderDownloadersHtml(
    payload({
      downloaders: {
        total: 3,
        users: [{ name: "<Igor" }, { name: "Владелец", mine: true }],
      },
    }),
  );
  assert.match(html, /<details class="card-downloaders">/);
  assert.match(html, /<summary>/);
  assert.match(html, /<ul class="card-downloaders-list">/);
  assert.ok(html.includes("&lt;Igor"), "имя экранировано");
  assert.ok(!html.includes("<Igor"), "сырое имя не исполняется");
  assert.match(html, /mine/, "свой маркер есть");
});

test("D-134: пустой блок не рисуется вовсе (total 0 или список пуст)", () => {
  assert.equal(renderDownloadersHtml(payload({ downloaders: { total: 0, users: [] } })), "");
  assert.equal(renderDownloadersHtml(payload()), "", "старый сервер без ключа — тоже пусто");
});

test("D-134: скрытый за воротами остаток подсказывается счётчиком", () => {
  const users = Array.from({ length: 50 }, (_, i) => ({ name: `m${i}` }));
  const previous = getLang();
  try {
    for (const [lang, five, six] of [
      ["ru", "ещё 5", "ещё 6"], ["uk", "ще 5", "ще 6"], ["en", "5 more", "6 more"],
    ] as const) {
      setLang(lang);
      const html = renderDownloadersHtml(payload({ downloaders: { total: 55, users } }));
      assert.match(html, /card-downloaders-more/);
      assert.ok(html.includes(five), `${lang}: осталось за воротами — 5`);
      assert.ok(!html.includes(six));
    }
  } finally { setLang(previous); }
});

test("D-134: спойлер независим от ИИ — виден и при выключенной сводке (D-093)", () => {
  const html = renderSummaryHtml(
    payload({
      summary_status: "disabled",
      rag_summary: null,
      storage: storage(),
      downloaders: { total: 1, users: [{ name: "Igor", mine: false }] },
    }),
  );
  assert.match(html, /card-downloaders/, "спойлер «кто скачал» живёт без ИИ");
});
