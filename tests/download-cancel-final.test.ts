/**
 * Отмена = финал (Download, вариант B «финал файлов + retry жив»).
 *
 * RED-тест (test-first, правило репозитория): воспроизводит дыры отмены
 * до фикса:
 *   1) частичный файл (savePath/output) не удалялся — на диске оставался
 *      мусор размером с часть/весь файл;
 *   2) retry-панель «Повторити безкоштовно» показывалась и после явной
 *      отмены юзером (отмена — финал, панель не показывается);
 *   3) lease-контекст не сбрасывался → watchdog/stall-тик могли стартовать
 *      повторный download поверх отменённой операции;
 *   4) TDLib-кеш не чистился (post_download_purge только на успехе).
 *
 * Серверная половина «retry жив» БЕЗ серверных правок: complete(false) на
 * started-сессии оставляет lease (24ч) → следующий init того же файла
 * возвращает `reused_active_lease` (бесплатно, без повторного списания);
 * после истечения lease — expired + write-off с логом + PM-чистка.
 * Поэтому план ОБЯЗАН содержать freeRestartHint при hostStarted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalCancelPlan,
  type FinalCancelPlan,
} from "../src/ui/DownloadCancelFinal";

test("отмена удаляет частичный файл: savePath попадает в removePaths", () => {
  const plan = buildFinalCancelPlan({
    savePath: "/home/u/fw.zip",
    outputPath: null,
    downloadId: "dl1",
    hostStarted: true,
  });
  assert.ok(
    plan.removePaths.includes("/home/u/fw.zip"),
    "частичный файл ОБЯЗАН удаляться при отмене",
  );
});

test("multi/vault: outputPath не дублирует savePath (дедуп)", () => {
  const plan = buildFinalCancelPlan({
    savePath: "/tmp/out.bin",
    outputPath: "/tmp/out.bin",
    downloadId: "dl1",
    hostStarted: false,
  });
  assert.deepEqual(plan.removePaths, ["/tmp/out.bin"]);
});

test("оба пути разные — удаляются оба", () => {
  const plan = buildFinalCancelPlan({
    savePath: "/tmp/a.zip",
    outputPath: "/tmp/partial.bin",
    downloadId: null,
    hostStarted: false,
  });
  assert.deepEqual(
    [...plan.removePaths].sort(),
    ["/tmp/a.zip", "/tmp/partial.bin"].sort(),
  );
});

test("null-пути не попадают в removePaths", () => {
  const plan = buildFinalCancelPlan({
    savePath: null,
    outputPath: null,
    downloadId: null,
    hostStarted: false,
  });
  assert.deepEqual(plan.removePaths, []);
});

test("отмена ВСЕГДА чистит TDLib-кеш и прячет retry-панель", () => {
  const plan = buildFinalCancelPlan({
    savePath: null,
    outputPath: null,
    downloadId: null,
    hostStarted: false,
  });
  assert.equal(plan.purgeTdlibCache, true, "кеш-пург обязателен при отмене");
  assert.equal(plan.hideRetryPanel, true, "retry-панель при отмене не нужна");
  assert.equal(plan.resetLeaseContext, true, "lease-контекст сбрасывается");
});

test("серверная сессия закрывается только при известном downloadId", () => {
  assert.equal(
    buildFinalCancelPlan({
      savePath: null, outputPath: null, downloadId: "dl1", hostStarted: true,
    }).closeSession,
    true,
  );
  assert.equal(
    buildFinalCancelPlan({
      savePath: null, outputPath: null, downloadId: null, hostStarted: true,
    }).closeSession,
    false,
    "без downloadId закрывать нечего — complete(false) не шлём",
  );
});

test("оплаченная сессия (hostStarted) — подсказка о бесплатном рестарте", () => {
  assert.equal(
    buildFinalCancelPlan({
      savePath: null, outputPath: null, downloadId: "dl", hostStarted: true,
    }).freeRestartHint,
    true,
    "баллы списаны → юзеру нужен видимый лог «повтор того же файла бесплатен»",
  );
  assert.equal(
    buildFinalCancelPlan({
      savePath: null, outputPath: null, downloadId: "dl", hostStarted: false,
    }).freeRestartHint,
    false,
    "до start баллов не было — hint не показываем",
  );
});

test("тип FinalCancelPlan экспортится (компиляционный контракт)", () => {
  const plan: FinalCancelPlan = buildFinalCancelPlan({
    savePath: null, outputPath: null, downloadId: null, hostStarted: false,
  });
  assert.equal(typeof plan.purgeTdlibCache, "boolean");
});
