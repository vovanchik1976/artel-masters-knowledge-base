/**
 * Удаление из личного: гонка с поисковым индексом + карточки-призраки
 * (BUG-PERSONAL-DELETE-001, прод 2026-11-10) — гейт по ИСХОДНИКУ.
 *
 * Что показал прод (тест владельца 22:46 UTC, доступ-лог + БД):
 *   1. Ответ 200 на удаление приходит ДО того, как Meili применит свою
 *      (асинхронную) задачу удаления → клиент сразу перечитывает
 *      /api/v1/search/personal и получает «только что удалённый» файл →
 *      юзер жал второй клик (404) — «не с первого раза»;
 *   2. файл #26 был снят из БД жёстко, но остался в индексе: каждый клик →
 *      404 «not found», а по пути 404 сервер индекс не чистил → призрака
 *      нельзя было убрать никаким количеством кликов — «не работает вовсе».
 *
 * Серверная часть (идемпотентность + синхронная чистка индекса) гейтится
 * python-тестами (tests_search/test_personal_delete_idempotent.py,
 * tests_desktop/test_vault_delete_idempotent_api.py). Здесь — клиентский
 * контракт: 404/already_deleted = успех, карточка прячется СРАЗУ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "tests"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron");
    dir = parent;
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), "src", rel), "utf8");
}

/** Тело метода/функции по маркеру с балансировкой скобок. */
function bodyByMarker(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `маркер не найден: ${marker}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error("незакрытый блок");
}

test("T1: 404 на удаление трактуется как «уже удалено», а не как ошибка", () => {
  const body = bodyByMarker(readSrc("ui/SearchPage.ts"), '.querySelector(".vault-delete-btn")');
  assert.match(
    body,
    /e\?\.status === 404/,
    "клик по призраку/уже удалённому даёт 404 — это успех (обновляем список), а не Delete error",
  );
  // Красный «Delete error» — только для прочих сбоев (иначе владелец видит
  // «не работает вовсе» там, где сервер честно сказал «уже удалено»).
  const catchIdx = body.indexOf("catch (e: any)");
  assert.ok(catchIdx >= 0, "не найден catch удаления");
  const afterCatch = body.slice(catchIdx, catchIdx + 1200);
  const errIdx = afterCatch.indexOf("Delete error");
  const status404Idx = afterCatch.indexOf("e?.status === 404");
  assert.ok(errIdx > 0 && status404Idx > 0 && status404Idx < errIdx,
    "проверка 404 должна идти ДО ветки Delete error");
});

test("T2: already_deleted из ответа сервера трактуется как успех", () => {
  const body = bodyByMarker(readSrc("ui/SearchPage.ts"), '.querySelector(".vault-delete-btn")');
  assert.match(body, /already_deleted/, "ответ 200 already_deleted должен распознаваться");
});

test("T3: карточка прячется сразу — скрытые id не доверяют лагу индекса", () => {
  const src = readSrc("ui/SearchPage.ts");
  assert.match(src, /_hiddenPersonalIds/, "нужен набор скрытых id удалённых файлов");
  const catalog = bodyByMarker(src, "_doPersonalCatalog(query: string)");
  assert.match(
    catalog,
    /_hiddenPersonalIds\.has\(/,
    "перечитанный личный список обязан фильтровать только что удалённые id",
  );
});

test("T4: типы ответа удаления несут already_deleted (оба роута)", () => {
  const api = readSrc("api.ts");
  const vaultDelete = bodyByMarker(api, "VaultDeleteResponse {");
  assert.match(vaultDelete, /already_deleted\??:\s*boolean/);
  const ownerDelete = bodyByMarker(api, "VaultOwnerDeleteResponse {");
  assert.match(ownerDelete, /already_deleted\??:\s*boolean/);
});

test("T5: vaultCleanup — 404 при «убрать копию» тоже успех, не сбой", () => {
  const src = readSrc("ui/vaultCleanup.ts");
  const body = bodyByMarker(src, "export async function removePersonalChatCopy");
  assert.match(
    body,
    /404/,
    "запись уже удалена → копию убирать нечего, это успех (removed: true)",
  );
});

test("T6: OwnerPage — 404/already_deleted не показывает красный тост сбоя", () => {
  const src = readSrc("ui/OwnerPage.ts");
  const from = src.indexOf("api.vaultOwnerDelete");
  assert.ok(from > 0, "не найден вызов owner-удаления");
  const to = src.indexOf("owner.err_delete", from);
  assert.ok(to > from, "не найден ветвь ошибки owner-удаления");
  const slice = src.slice(from, to);
  assert.match(
    slice,
    /status === 404/,
    "owner-удаление по призраку — «уже удалено» (успех + перечитать), а не тост сбоя",
  );
});
