/**
 * Дворник temp-мусора: политика возраста
 * (BUG-CANCEL-FINAL-001, обновлено BUG-SINGLE-INSTANCE-001).
 *
 * RED (test-first, 2026-09-27): раньше порог зависел от момента вызова —
 * `startup` → 24ч («бережно: страница ещё не знает о параллельных сессиях»),
 * `op-end`/`cancel` → 0. Эта бережность была страховкой ровно от одного
 * сценария — **рядом работает вторая копия клиента со своими свежими
 * temp-файлами**. Второй экземпляр теперь запрещён на входе
 * (`app.requestSingleInstanceLock`, BUG-SINGLE-INSTANCE-001), поэтому беречь
 * нечего:
 *   – эксклюзивность подтверждена кодом запуска (замок берётся ДО окна/TDLib);
 *   – остатки в общих temp-каталогах от мёртвого процесса — всегда мусор:
 *     слайсы `{pid}_{i}.part` не переживают рестарт (новый процесс режет файл
 *     заново под своим pid), архив пересобирается, а скачанный файл лежит в
 *     каталоге пользователя и дворником не трогается.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JANITOR_MAX_AGE_SECS,
  buildJanitorRequest,
  resolveJanitorMaxAge,
  shouldPurgeTdlibCacheOnCancel,
} from "../src/ui/JanitorPolicy";
import type { JanitorTrigger } from "../src/ui/JanitorPolicy";

test("дворник сносит temp-мусор ЛЮБОГО возраста — на всех триггерах (0)", () => {
  const triggers: JanitorTrigger[] = ["startup", "op-end", "cancel"];
  for (const trigger of triggers) {
    assert.equal(
      resolveJanitorMaxAge(trigger),
      0,
      `${trigger}: второй экземпляр запрещён замком → свежий остаток тоже мусор (.part/архив)`,
    );
  }
});

test("константа политики: порог равен нулю (стартового исключения 24ч больше нет)", () => {
  assert.equal(JANITOR_MAX_AGE_SECS, 0);
});

test("пург кеша при отмене пропускается, если идёт ДРУГАЯ передача", () => {
  assert.equal(
    shouldPurgeTdlibCacheOnCancel(false),
    true,
    "никто больше не передаёт — кеш чистим (мусор отмены снимаем)",
  );
  assert.equal(
    shouldPurgeTdlibCacheOnCancel(true),
    false,
    "идёт upload → пург общий кеша убил бы его local→remote маппинг",
  );
});

/**
 * RED (test-first, BUG-JANITOR-WIN-001, 2026-09-27): запрос к Rust-дворнику
 * собирается в одном месте. Кеш TDLib чистится ТОЛЬКО на старте — он общий на
 * сессию и параллельный download в другой вкладке потерял бы свои части.
 */
test("кеш TDLib чистит только стартовый вызов, операционные — нет", () => {
  const startup = buildJanitorRequest("startup", false);
  assert.equal(startup.maxAgeSecs, 0);
  assert.equal(
    startup.includeTdlibCache,
    true,
    "startup: передач нет вовсе → кеш обязан подчищаться (иначе растёт бесконечно)",
  );

  for (const trigger of ["op-end", "cancel"] as JanitorTrigger[]) {
    const req = buildJanitorRequest(trigger, false);
    assert.equal(req.maxAgeSecs, 0);
    assert.equal(
      req.includeTdlibCache,
      false,
      `${trigger}: кеш общий с download → не трогаем`,
    );
  }

  assert.equal(
    buildJanitorRequest("startup", true).includeTdlibCache,
    false,
    "даже на старте при активной передаче кеш не трогаем (защита от гонки)",
  );
});
