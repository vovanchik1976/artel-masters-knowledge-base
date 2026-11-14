/**
 * Гейты по ИСХОДНИКАМ принудительного обновления (Electron, Win7/8).
 *
 * Живой NSIS-прогон возможен только на Windows, поэтому ключевые инварианты
 * (тихие аргументы установщика, отсутствие кнопки «Позже», запрет URL из
 * renderer, проверка sha256) фиксируются чтением исходников.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const DESKTOP = path.resolve(__dirname, "..", "..");
const UPDATER_MAIN = path.join(DESKTOP, "electron", "updater.ts");
const MAIN = path.join(DESKTOP, "electron", "main.ts");
const GATE = path.join(DESKTOP, "src", "ui", "UpdateGate.ts");
const ENTRY = path.join(DESKTOP, "src", "main.ts");
const PKG = path.join(DESKTOP, "package.json");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Исходник без комментариев: гейты проверяют КОД, а не пояснения в шапке. */
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("S1: main регистрирует все четыре IPC-команды обновления", () => {
  const src = read(MAIN);
  for (const cmd of ["updater.version", "updater.check", "updater.download", "updater.install"]) {
    assert.ok(src.includes(`case "${cmd}"`), `нет обработчика ${cmd}`);
  }
});

test("S2: установщик запускается ТИХО и перезапускает приложение", () => {
  const src = read(UPDATER_MAIN);
  assert.ok(
    src.includes('["/S", "--updated", "--force-run"]'),
    "аргументы NSIS обязаны быть /S --updated --force-run",
  );
  assert.ok(src.includes("detached: true"), "установщик обязан пережить выход приложения");
});

test("S3: целостность проверяется (размер + sha256), иначе установка запрещена", () => {
  const src = read(UPDATER_MAIN);
  assert.ok(src.includes('hash.digest("hex") !== plan.sha256'), "нет сверки sha256");
  assert.ok(src.includes("received !== plan.size"), "нет сверки размера");
  assert.ok(
    /catch \(err\) \{[\s\S]*rmSync\(partPath/.test(src),
    "битый .part обязан удаляться",
  );
});

test("S4: renderer не может подсунуть URL — download/install без аргументов", () => {
  const src = read(MAIN);
  const block = src.slice(
    src.indexOf('case "updater.download"'),
    src.indexOf('case "updater.install"'),
  );
  assert.ok(block.length > 0, "блок updater.download не найден");
  assert.ok(!block.includes("args"), "updater.download не должен читать args (URL приходит только из манифеста)");
});

test("S5: у блокирующего экрана НЕТ кнопки «Позже»/пропуска", () => {
  const src = code(GATE);
  const lower = src.toLowerCase();
  for (const bad of ["later", "позже", "пізніше", "skip", "dismiss"]) {
    assert.ok(!lower.includes(bad), `в блокирующем экране не должно быть «${bad}»`);
  }
  assert.ok(src.includes("position:fixed"), "экран обязан перекрывать всё окно");
  assert.ok(src.includes("2147483647"), "z-index обязан быть выше любого UI");
});

test("S6: экран обновления не снимается — нет удаления overlay", () => {
  const src = read(GATE);
  assert.ok(!src.includes("overlay.remove"), "overlay нельзя удалять (блокировка до установки)");
  assert.ok(!src.includes("removeChild"), "overlay нельзя удалять (блокировка до установки)");
});

test("S7: вне упакованного приложения обновление выключено (e2e не перезапускается)", () => {
  const src = read(UPDATER_MAIN);
  assert.ok(src.includes("!app.isPackaged"), "нет проверки app.isPackaged");
  assert.ok(src.includes("FW_UPDATER_ALLOW_DEV"), "нет явного рубильника для dev-проверки");
  assert.ok(src.includes("FW_UPDATER_DISABLED"), "нет общего рубильника выключения");
});

test("S8: точка входа запускает сторож обновлений", () => {
  const src = read(ENTRY);
  assert.ok(src.includes("startUpdateWatch()"), "src/main.ts обязан вызвать startUpdateWatch()");
});

test("S9: прогресс скачивания доставляется событием updater-progress", () => {
  const src = read(MAIN);
  assert.ok(src.includes('"updater-progress"'), "нет события прогресса");
  const gate = read(GATE);
  assert.ok(gate.includes('"updater-progress"'), "экран не слушает прогресс");
});

test("S10a: имя установщика проходит только безопасный whitelist (Windows-пути)", () => {
  const src = read(UPDATER_MAIN);
  assert.ok(
    src.includes("/^[A-Za-z0-9._-]+$/"),
    "имя файла обязано проверяться whitelist'ом (без \\ / .. и спецсимволов Windows)",
  );
  assert.ok(src.includes('fileName.includes("..")'), "запрет .. в имени файла");
});

test("S10: зависимость electron-updater не добавлена (свой канал)", () => {
  const pkg = JSON.parse(read(PKG)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.ok(!("electron-updater" in all), "electron-updater не нужен: канал и манифест свои");
});
