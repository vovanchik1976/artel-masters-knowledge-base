/**
 * Тесты DownloadStallWatchdog — страховка от «вечного ⏳ Соединение…»
 * (BUG-DOWNLOAD-049): multi/part-download не должен висеть молча, если движок
 * перестал слать прогресс (обрыв сети / зависший `downloadFile{synchronous}`).
 *
 * Check W8 — тик-инвариант DownloadPage (BUG-DOWNLOAD-050): передача уже не
 * идёт (успех/ошибка/отмена — `_transferActive === false`) — запоздалый тик
 * watchdog'а не должен стартовать повторный download после окончания.
 *
 * Сценарии (= спецификация класса):
 *   W1  Обрыва нет (progress моложе stallMs) → «wait», попыток 0.
 *   W2  Нет прогресса дольше stallMs → «retry», счётчик попыток растёт,
 *       окно пере-взводится (следующий retry — только после нового окна).
 *   W3  Исчерпание maxAttempts → «give-up»; повторные check() → «wait» (латч,
 *       панель «Повторити безкоштовно» показывается ровно один раз).
 *   W4  progress() сбрасывает ТОЛЬКО окно; счётчик попыток не обнуляется
 *       (защита от бесконечного auto-retry).
 *   W5  reset() — новая операция: окно и счётчик обнулены.
 *   W6  TDLib без сети (`connectionStateWaitingForNetwork`) → retry не делаем
 *       даже после обрыва окна; возврат в `connectionStateReady` → «retry».
 *   W7  Состояние соединения ещё не приходило (пусто) → считаем «онлайн»
 *       (страховка не должна зависеть от наличия события).
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 * Часы инъекцируются — тесты детерминированы.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DownloadStallWatchdog } from "../src/ui/DownloadStallWatchdog";

/** Фейковые часы: продвигаются вручную (ms). */
function fakeClock() {
  let now = 0;
  return {
    now: (): number => now,
    tick: (ms: number): void => {
      now += ms;
    },
  };
}

test("W1: без обрыва (progress < stallMs) — «wait», попыток 0", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000 });
  wd.progress();
  c.tick(999);
  assert.equal(wd.check(), "wait");
  assert.equal(wd.attempts, 0);
});

test("W2: обрыв дольше stallMs → «retry», окно пере-взводится", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000, maxAttempts: 3 });
  wd.progress();

  c.tick(1001);
  assert.equal(wd.check(), "retry", "первый обрыв → авто-retry");
  assert.equal(wd.attempts, 1);

  // Окно пере-взведено: сразу после retry ждать ещё нельзя.
  assert.equal(wd.check(), "wait");
  c.tick(1001);
  assert.equal(wd.check(), "retry", "второй обрыв → второй retry");
  assert.equal(wd.attempts, 2);
});

test("W3: после maxAttempts → «give-up», затем латч в «wait»", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000, maxAttempts: 2 });
  wd.progress();

  c.tick(1001);
  assert.equal(wd.check(), "retry");
  c.tick(1001);
  assert.equal(wd.check(), "retry");
  assert.equal(wd.attempts, 2);

  c.tick(1001);
  assert.equal(wd.check(), "give-up", "попытки исчерпаны → отдаём панель retry пользователю");
  c.tick(1001);
  assert.equal(wd.check(), "wait", "give-up латчится: панель показывается один раз");
  assert.equal(wd.attempts, 2, "счётчик не растёт после give-up");
});

test("W4: progress() сбрасывает окно, но не счётчик попыток", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000, maxAttempts: 3 });
  wd.progress();

  c.tick(1001);
  assert.equal(wd.check(), "retry");
  assert.equal(wd.attempts, 1);

  // Передача ожила: часть данных пришла → окно обнулено.
  wd.progress();
  c.tick(999);
  assert.equal(wd.check(), "wait", "после прогресса обрыва нет");
  assert.equal(wd.attempts, 1, "счётчик попыток progress() не обнуляет");

  c.tick(2);
  assert.equal(wd.check(), "retry", "новый обрыв → новая попытка (лимит общий)");
  assert.equal(wd.attempts, 2);
});

test("W5: reset() обнуляет окно, счётчик и латч give-up", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000, maxAttempts: 1 });
  wd.progress();
  c.tick(1001);
  assert.equal(wd.check(), "retry");
  c.tick(1001);
  assert.equal(wd.check(), "give-up");

  wd.reset();
  assert.equal(wd.attempts, 0);
  assert.equal(wd.check(), "wait", "после reset латч снят, окно начато заново");
  c.tick(1001);
  assert.equal(wd.check(), "retry", "новая операция снова получает auto-retry");
});

test("W6: без сети (waitingForNetwork) retry не делаем; ready → «retry»", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000, maxAttempts: 3 });
  wd.progress();

  // Сеть упала ДО того, как окно истекло.
  wd.connectionState("connectionStateWaitingForNetwork");
  c.tick(5000);
  assert.equal(
    wd.check(),
    "wait",
    "пока TDLib без сети — retry бессмыслен (пере-качка части всё равно ждёт сеть)",
  );
  assert.equal(wd.attempts, 0);
  assert.equal(wd.online, false);

  // Сеть вернулась (событие из receive-loop) — теперь обрыв уже «виден».
  wd.connectionState("connectionStateReady");
  assert.equal(wd.online, true);
  assert.equal(wd.check(), "retry", "после восстановления сети висящую часть пере-качиваем");
  assert.equal(wd.attempts, 1);
});

test("W7: состояние соединения неизвестно → считаем «онлайн»", () => {
  const c = fakeClock();
  const wd = new DownloadStallWatchdog({ now: c.now, stallMs: 1000 });
  assert.equal(wd.online, true, "без события connection-state страховка обязана работать");
  wd.progress();
  c.tick(1001);
  assert.equal(wd.check(), "retry");
});

test("W8 (BUG-DOWNLOAD-050): инвариант тика — по коду тик заперт флагом _transferActive", () => {
  // Проверяем сам инвариант на уровне исходника DownloadPage: `_tickStallWatchdog`
  // обязан выйти, если передача уже не идёт (`!this._transferActive`), и при
  // успехе обнулять lease/retry-контекст (`_leaseFileId = null` рядом с
  // `downloadComplete(..., true)`). Иначе watchdog (stall-окно 90с после
  // последнего прогресса) стартует `_retryDownload()` поверх завершённой
  // операции — клиент запускает повторный download после окончания.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("node:path") as typeof import("node:path");
  // Тесты выполняются из скомпилированного tmp-tests/, поэтому читаем
  // исходник от корня пакета (cwd = desktop-electron при npm run test:ui).
  const src = fs.readFileSync(path.join(process.cwd(), "src/ui/DownloadPage.ts"), "utf8");

  const tickIdx = src.indexOf("private _tickStallWatchdog");
  assert.ok(tickIdx >= 0, "метод _tickStallWatchdog найден");
  const tickBody = src.slice(tickIdx, tickIdx + 800);
  assert.ok(
    tickBody.includes("!this._transferActive"),
    "тик watchdog'а заперт: без активной передачи retry не стартует",
  );

  const completeIdx = src.indexOf("await api.downloadComplete(downloadId, true)");
  assert.ok(completeIdx >= 0, "точка успеха найдена");
  const successTail = src.slice(completeIdx, completeIdx + 1200);
  assert.ok(
    successTail.includes("this._leaseFileId = null") &&
      successTail.includes("this._retrySavePath = null"),
    "успех инвалидирует lease/retry-контекст — запоздалому тику не на чем retry'иться",
  );
});
