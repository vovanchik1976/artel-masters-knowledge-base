/**
 * D-136: ссылка на карточку из чата открывает ПОЛНУЮ карточку поисковика.
 *
 * Поручение владельца 2026-10-30: «ссылка на карточку в чате должна отображать
 * полную информацию о карточке как в полноценном поисковике».
 *
 * Дефект (до фикса): если карточки не было в текущей выдаче, `SearchPage.focusCard`
 * рисовал «полукарточку» (`CardJump.renderFocusCardHtml`) — бренд/модель, размер,
 * кнопка «Скачать». Ни полей формы, ни медиа, ни сводки/вложений/отзывов.
 *
 * Инвариант, который держит этот гейт: полноценная карточка живёт в ОДНОМ
 * рендерере `_buildResultCard` (им же пользуется выдача поиска), а переход из
 * чата идёт через него же. Компактный рендерер запрещён — иначе копий карточки
 * снова станет две и они разъедутся.
 *
 * Гейт по ИСХОДНИКУ (как `part-cache-release.test.ts`): проверяемое behaviour
 * живёт в DOM-классе без тестового стенда, а рассинхронизация тут — именно
 * «вторая копия разметки».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Корень `desktop-electron` (от `outDir` → `tmp-tests/tests` вверх). */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + src/)");
    dir = parent;
  }
}

function readUi(name: string): string {
  return fs.readFileSync(path.join(projectRoot(), "src", "ui", name), "utf8");
}

function readRoot(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Тело метода класса: от сигнатуры до закрывающей скобки на отступе класса (2 пробела). */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `не найден метод \`${signature}\``);
  const end = src.indexOf("\n  }\n", start);
  assert.ok(end > start, `не найден конец метода \`${signature}\``);
  return src.slice(start, end);
}

test("D-136 F1: полноценная карточка — все блоки выдачи в одном рендерере", () => {
  const body = methodBody(readUi("SearchPage.ts"), "private _buildResultCard(");
  for (const marker of [
    "search-result-fields", // поля формы (шасси, чипсет, память, программатор…)
    "search-result-media", // превью медиа
    "file-reviews-host", // отзывы мастеров
    "community-discuss", // чип «обсудить в чате»
    "search-summary-host", // сводка + «где ещё используется» + вложения
    "search-dl-btn", // скачивание
  ]) {
    assert.ok(body.includes(marker), `в _buildResultCard нет блока \`${marker}\` — это уже не полная карточка`);
  }
});

test("D-136 F2: выдача поиска и переход из чата рисуют одну и ту же карточку", () => {
  const src = readUi("SearchPage.ts");
  assert.ok(
    methodBody(src, "private renderResultCard(").includes("_buildResultCard"),
    "renderResultCard не делегирует в _buildResultCard — карточки снова разъедутся",
  );
  const focus = methodBody(src, "async focusCard(");
  assert.ok(focus.includes("_buildResultCard"), "focusCard не строит полную карточку");
});

test("D-136 F3: компактной «полукарточки» больше нет", () => {
  const src = readUi("SearchPage.ts");
  assert.ok(
    !src.includes("renderFocusCardHtml"),
    "renderFocusCardHtml вернулся: ссылка из чата снова покажет бренд/модель вместо полной карточки",
  );
  const jump = readUi("CardJump.ts");
  assert.ok(
    !jump.includes("renderFocusCardHtml"),
    "в CardJump остался компактный рендерер карточки (мёртвая ветка) — удали его",
  );
});

test("D-136 F4: длинное имя файла не выталкивает «Загрузил» за края карточки (BUG-CARD-OVERFLOW-001)", () => {
  // Поручение владельца 2026-11-04: имя файла #113 (~120 символов одним
  // токеном, без пробелов) вылезало за края карточки и вытесняло «👤 Загрузил».
  // Выбранный способ — вертикальный перенос: скролл и бегущая строка отпадают,
  // потому что обрезают текст и ломают копирование выделением; перенос ничего
  // не обрезает и оставляет выделение/копипаст как на обычном тексте.
  const html = readRoot("index.html");
  // Карточка целиком переносит длинные токены (титул, поля, описания).
  assert.match(
    html,
    /\.search-result-card\s*\{[^}]*overflow-wrap:\s*anywhere/,
    ".search-result-card обязан переносить длинные токены (overflow-wrap: anywhere)",
  );
  // Строка метаданных умеет переноситься на новую строку целиком.
  assert.match(
    html,
    /\.search-result-meta\s*\{[^}]*flex-wrap:\s*wrap/,
    ".search-result-meta обязан уметь переносить «Загрузил» на свою строку",
  );
  // Имя файла (первый span) переносится по символам и может сжиматься.
  assert.match(
    html,
    /\.search-result-meta > span\s*\{[^}]*min-width:\s*0/,
    "span-ы метаданных обязаны уметь сжиматься (min-width: 0)",
  );
  assert.match(
    html,
    /\.search-result-meta > span:first-child\s*\{[^}]*word-break:\s*break-all/,
    "имя файла обязано переноситься по символам (word-break: break-all)",
  );
});
