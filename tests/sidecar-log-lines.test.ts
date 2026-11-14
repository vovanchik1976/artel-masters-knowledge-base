/**
 * SidecarManager.writeLogLine — целостность строк `engine-core.log`
 * (BUG-RCA-LOG-FRAG-001, live 2026-09-28, e2e-prod32).
 *
 * Симптом (реальный файл `logs/e2e-prod32/engine-core.log`): строка
 * `[dl-rca] {…}` пришла изуродованной — внутри JSON оказалось до 19
 * timestamp-префиксов:
 *   [2026-09-28T07:02:14.699Z] [dl-rca] {"[2026-09-28T07:02:14.699Z] chat_id":…
 * → JSON не парсится, RCA-лог как инструмент бесполезен.
 *
 * Root cause: Rust `stderr` небуферизован, `eprintln!`/`write_fmt` делает
 * отдельный `write` на КАЖДЫЙ фрагмент форматирования (serde_json Display —
 * десятки мелких write). Каждый write приходит в Node отдельным chunk'ом, а
 * `writeLogLine` навешивал timestamp на каждый chunk → метка попадала в
 * середину логической строки.
 *
 * Инвариант: chunk'и склеиваются в логические строки, timestamp ровно один на
 * строку, тело строки (JSON) не искажается.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SidecarManager } from "../electron/sidecar-manager";

/** Доступ к приватным членам менеджера (тест инварианта лога). */
interface LoggingSidecar {
  writeLogLine(text: string): void;
  logStream: { end(cb: () => void): void } | null;
}

function newManager(): { mgr: SidecarManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-sidecar-log-"));
  // binPath не используется в этом тесте (spawn не вызываем) — только logDir.
  const mgr = new SidecarManager(path.join(dir, "engine-core"), dir);
  return { mgr, dir };
}

/** Дождаться, пока WriteStream отдаст накопленное в ОС (fs-запись асинхронна). */
function settle(mgr: SidecarManager): Promise<void> {
  return new Promise((resolve) => {
    const stream = (mgr as unknown as LoggingSidecar).logStream as unknown as
      | { writableLength: number }
      | null;
    const check = (): void => {
      if (!stream || stream.writableLength === 0) {
        setTimeout(resolve, 5);
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/** Закрыть лог-стрим: открытый fd держал бы тест-процесс (node --test) живым. */
function closeLog(mgr: SidecarManager): Promise<void> {
  return new Promise((resolve) => {
    const stream = (mgr as unknown as LoggingSidecar).logStream;
    if (!stream) return resolve();
    stream.end(() => resolve());
  });
}

function logFile(dir: string): string {
  return fs.readFileSync(path.join(dir, "engine-core.log"), "utf8");
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

test("writeLogLine: фрагментированные chunk'и → ОДНА строка с ОДНИМ timestamp", async () => {
  const { mgr, dir } = newManager();
  const write = (t: string) => (mgr as unknown as LoggingSidecar).writeLogLine.call(mgr, t);

  // Ровно то, что даёт небуферизованный stderr Rust: одна логическая строка
  // приходит несколькими chunk'ами (фрагментация на границах write()).
  write('[dl-rca] {"chat_id":8898752180,');
  write('"file_id":1253,"op":"single",');
  write('"phase":"download_file_sent","priority":32}\n');

  await settle(mgr);
  const lines = nonEmptyLines(logFile(dir));
  await closeLog(mgr);

  assert.equal(
    lines.length,
    1,
    `ожидалась ОДНА строка лога (фрагменты — части одной), получено ${lines.length}:\n${logFile(dir)}`,
  );

  const m = /^\[([^\]]+)\] (.*)$/.exec(lines[0]);
  assert.ok(m, `строка обязана начинаться с timestamp-префикса: ${lines[0]}`);
  const body = m![2];
  assert.equal(
    body,
    '[dl-rca] {"chat_id":8898752180,"file_id":1253,"op":"single","phase":"download_file_sent","priority":32}',
    "тело строки не должно содержать вклеенных timestamp'ов",
  );
  assert.doesNotThrow(
    () => JSON.parse(body.replace(/^\[dl-rca\] /, "")),
    "JSON внутри [dl-rca] обязан остаться целым",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeLogLine: многострочный chunk → timestamp на каждую строку, хвост не теряется", async () => {
  const { mgr, dir } = newManager();
  const write = (t: string) => (mgr as unknown as LoggingSidecar).writeLogLine.call(mgr, t);

  write("engine-core[tdlib]: первая\nвторая без завершения");
  await settle(mgr);
  // Хвост без `\n` ещё не строка — он не должен попасть в файл как отдельная
  // строка с меткой (иначе снова «метка в середине»).
  let lines = nonEmptyLines(logFile(dir));
  assert.equal(lines.length, 1, `незавершённый хвост не пишем как строку: ${logFile(dir)}`);
  assert.match(lines[0], /\] engine-core\[tdlib\]: первая$/);

  // Завершение хвоста — вот теперь строка дописывается.
  write(" — хвост дописан\n");
  await settle(mgr);
  lines = nonEmptyLines(logFile(dir));
  assert.equal(lines.length, 2, `после завершения хвост обязан появиться: ${logFile(dir)}`);
  assert.match(lines[1], /\] вторая без завершения — хвост дописан$/);
  await closeLog(mgr);

  fs.rmSync(dir, { recursive: true, force: true });
});
