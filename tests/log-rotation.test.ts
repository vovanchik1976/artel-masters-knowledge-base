import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  rotateLogFile,
  pruneOldLogs,
  CLIENT_LOG_NAME_RE,
  LOG_MAX_BYTES,
} from "../electron/log-rotation";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "logrot-"));
}

test("rotateLogFile: >порога ротируется в .1.log, максимум 2 файла", () => {
  const dir = tmpDir();
  const file = path.join(dir, "engine-core.log");
  fs.writeFileSync(file, "x".repeat(LOG_MAX_BYTES + 1));
  rotateLogFile(dir, "engine-core.log");
  assert.ok(fs.existsSync(path.join(dir, "engine-core.1.log")), "копия создана");
  assert.ok(!fs.existsSync(file), "активный переименован");

  // Вторая ротация: новая копия перезаписывает старую (максимум 2 файла).
  fs.writeFileSync(file, "y".repeat(LOG_MAX_BYTES + 1));
  rotateLogFile(dir, "engine-core.log");
  const entries = fs.readdirSync(dir).filter((n) => n.startsWith("engine-core")).sort();
  assert.deepStrictEqual(entries, ["engine-core.1.log"], "осталась ровно 1 копия");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateLogFile: файл меньше порога не ротируется", () => {
  const dir = tmpDir();
  const file = path.join(dir, "bridge.log");
  fs.writeFileSync(file, "small");
  rotateLogFile(dir, "bridge.log");
  assert.ok(fs.existsSync(file), "активный на месте");
  assert.ok(!fs.existsSync(path.join(dir, "bridge.1.log")), "копии нет");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruneOldLogs: удаляет старше 7 дней, свежие и чужие оставляет", () => {
  const dir = tmpDir();
  const old = path.join(dir, "engine-core.1.log");
  const fresh = path.join(dir, "download-rca.log");
  const other = path.join(dir, "notes.txt");
  fs.writeFileSync(old, "old");
  fs.writeFileSync(fresh, "fresh");
  fs.writeFileSync(other, "other");
  const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(old, oldTime, oldTime);
  pruneOldLogs(dir, CLIENT_LOG_NAME_RE);
  assert.ok(!fs.existsSync(old), "старый лог удалён");
  assert.ok(fs.existsSync(fresh), "свежий остался");
  assert.ok(fs.existsSync(other), "чужой файл не тронут");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLIENT_LOG_NAME_RE: покрывает логи клиента и ротационные копии", () => {
  for (const name of [
    "engine-core.log", "engine-core.1.log", "download-rca.log", "download-rca.1.log",
    "bridge.log", "bridge.1.log", "auth-flow.log", "auth-flow.1.log", "main-sidecar.log", "tdlib.log", "tdlib.log.old",
  ]) {
    assert.ok(CLIENT_LOG_NAME_RE.test(name), `${name} должен матчиться`);
  }
  for (const name of ["notes.txt", "auth.json", "engine-core.log.bak"]) {
    assert.ok(!CLIENT_LOG_NAME_RE.test(name), `${name} НЕ должен матчиться`);
  }
});
