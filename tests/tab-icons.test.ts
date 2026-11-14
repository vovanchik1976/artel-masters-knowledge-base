/**
 * Гейт «иконки вкладок единым стилем» (запрос владельца 2026-10-31).
 *
 * ПРЕЖДЕ (RED): четыре главные вкладки (Загрузить/Поиск/Передача/Магазин) рисовали
 * 3D-иконки PNG (`public/tab-*-3d.png`), а Настройки/Чаты/FAQ/Архиватор — плоские
 * текстовые глифы (⚙ 💬 ❓ 🗜️) — панель выглядит неоднородно.
 * ПОСЛЕ: ВСЕ вкладки используют одинаковый `img.tab-icon-3d` со своим PNG
 * `public/tab-<имя>-3d.png`.
 *
 * Гейт по ИСХОДНИКАМ (index.html + public/) — DOM в node:test нет.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

/** data-tab → имя ассета иконки (у «Магазина» ассет — shop). */
const PRIMARY_TABS: ReadonlyArray<readonly [string, string]> = [
  ["upload", "upload"], ["search", "search"], ["download", "download"], ["billing", "shop"],
];
const UNIFIED_TABS: ReadonlyArray<string> = ["settings", "community", "faq", "archiver", "owner"];

function tabsHtml(): string {
  const html = fs.readFileSync(path.join(projectRoot(), "index.html"), "utf8");
  const from = html.indexOf('<div class="tabs">');
  const to = html.indexOf("<!-- Upload Tab -->");
  assert.ok(from !== -1 && to > from, "не нашли блок .tabs в index.html");
  return html.slice(from, to);
}

test("R1: каждая вкладка рисуется 3D-иконкой img.tab-icon-3d со своим PNG", () => {
  const html = tabsHtml();
  for (const [tab, asset] of PRIMARY_TABS) {
    const pattern = new RegExp(`<img[^>]*src="\\/tab-${asset}-3d\\.png"[^>]*`);
    assert.match(html, pattern, `вкладка ${tab} без img/tab-${asset}-3d.png`);
  }
  for (const tab of UNIFIED_TABS) {
    const pattern = new RegExp(`<img[^>]*src="\\/tab-${tab}-3d\\.png"[^>]*`);
    assert.match(html, pattern, `вкладка ${tab} без img/tab-${tab}-3d.png`);
  }
});

test("R2: у новых вкладок класс tab-icon-3d (масштаб/тень как у главных)", () => {
  const html = tabsHtml();
  for (const tab of UNIFIED_TABS) {
    const pattern = new RegExp(`<img[^>]*src="\\/tab-${tab}-3d\\.png"[^>]*class="[^"]*tab-icon-3d`);
    assert.match(html, pattern, `img вкладки ${tab} без класса tab-icon-3d`);
  }
});

test("R3: PNG иконки реально лежат в public/ (сборка Vite их заберёт)", () => {
  for (const tab of UNIFIED_TABS) {
    const file = path.join(projectRoot(), "public", `tab-${tab}-3d.png`);
    const ok = fs.existsSync(file) && fs.statSync(file).size > 10_000;
    assert.ok(ok, `нет файла public/tab-${tab}-3d.png (или файл подозрительно мал)`);
  }
});

test("R4: плоские текстовые глифы вкладок убраны (⚙💬❓🗜️)", () => {
  const html = tabsHtml();
  for (const glyph of ["⚙", "💬", "❓", "🗜️"]) {
    assert.ok(!html.includes(glyph), "в блоке .tabs остался текстовый глиф " + glyph);
  }
});

test("R4b: вкладка «Владелец» — не inline-SVG data-URI, а тот же PNG-материал", () => {
  const html = tabsHtml();
  // ПРЕЖДЕ (RED): у владельца стоял data:image/svg+xml (плоский замок-линия на
  // прозрачном фоне) — единственная вкладка «не из стекла», выпадала из ряда.
  assert.ok(!/data:image\/svg\+xml/.test(html), "в блоке .tabs остался inline-SVG data-URI (плоская иконка)");
  const owner = /<img[^>]*src="\/tab-owner-3d\.png"[^>]*>/.exec(html);
  assert.ok(owner, "вкладка owner обязана рисоваться img/tab-owner-3d.png");
});

test("R5: покачивание иконки «Чаты» (chat-wiggle) не сломано — класс chat-tab-icon сохранён", () => {
  const html = tabsHtml();
  const mImg = /<img[^>]*src="\/tab-community-3d\.png"[^>]*class="([^"]*)"/.exec(html);
  assert.ok(mImg, "нет img иконки вкладки Чаты");
  assert.ok(mImg![1].includes("chat-tab-icon"), "класс chat-tab-icon должен остаться на img (анимация has-unread)");
  assert.match(html, /chat-tab-unread/, "счётчик непрочитанных обязан остаться на вкладке Чаты");
});

test("R6: самопроверка — гейт распознал реальную разметку (не мёртвый тест)", () => {
  const html = tabsHtml();
  assert.ok(/data-tab="upload"/.test(html) && /tab-upload-3d\.png/.test(html), "блок .tabs не распарсился");
});
