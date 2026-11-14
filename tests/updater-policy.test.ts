/**
 * Гейты политики принудительного обновления Desktop (Electron, Win7/8).
 *
 * Проверяется ЧИСТАЯ логика без сети/Electron: версии, выбор архитектуры,
 * разбор манифеста `/updater/latest.json`, защита от мусора в манифесте и
 * резолв относительного URL установщика.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideUpdate,
  isNewer,
  parseManifest,
  parseSemver,
  platformKey,
  resolveUpdateUrl,
  type UpdateManifest,
} from "../shared/updaterPolicy";

const BASE = "https://tv-firmware.duckdns.org";
const SHA = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.5.2",
    notes: "fix",
    pub_date: "2026-10-18T00:00:00+00:00",
    platforms: { "windows-x86_64": { signature: "sig", url: `${BASE}/old.exe` } },
    electron: {
      version: "0.5.2",
      notes: "fix",
      pub_date: "2026-10-18T00:00:00+00:00",
      platforms: {
        "win32-ia32": {
          url: "/updater/files/v0.5.2/ARTEL-Electron-0.5.2-ia32-setup.exe",
          sha256: SHA,
          size: 100,
        },
        "win32-x64": {
          url: "/updater/files/v0.5.2/ARTEL-Electron-0.5.2-x64-setup.exe",
          sha256: "b".repeat(64),
          size: 200,
        },
      },
    },
    ...overrides,
  };
}

test("U1: semver только строгий X.Y.Z", () => {
  assert.deepEqual(parseSemver("0.5.2"), [0, 5, 2]);
  assert.deepEqual(parseSemver("10.0.31"), [10, 0, 31]);
  assert.equal(parseSemver("v0.5.2"), null);
  assert.equal(parseSemver("0.5"), null);
  assert.equal(parseSemver("0.5.2.1"), null);
  assert.equal(parseSemver("latest"), null);
  assert.equal(parseSemver(42), null);
});

test("U2: сравнение версий (числовое, не строковое)", () => {
  assert.equal(isNewer("0.5.1", "0.5.2"), true);
  assert.equal(isNewer("0.5.2", "0.5.2"), false);
  assert.equal(isNewer("0.5.3", "0.5.2"), false);
  assert.equal(isNewer("0.9.9", "0.10.0"), true); // 10 > 9, не строковое сравнение
  assert.equal(isNewer("bad", "0.5.2"), false);
});

test("U3: архитектура → ключ платформы; неизвестная арка — null", () => {
  assert.equal(platformKey("ia32"), "win32-ia32");
  assert.equal(platformKey("x64"), "win32-x64");
  assert.equal(platformKey("arm64"), null);
  assert.equal(platformKey(""), null);
});

test("U4: манифест с electron-блоком разбирается, Tauri-поля не мешают", () => {
  const parsed = parseManifest(manifest());
  assert.ok(parsed);
  assert.equal(parsed!.version, "0.5.2");
  assert.equal(parsed!.targets["win32-ia32"].size, 100);
  assert.equal(parsed!.targets["win32-x64"].sha256, "b".repeat(64));
});

test("U4b: манифест без electron — валиден, но целей нет", () => {
  const raw = manifest();
  delete (raw as any).electron;
  const parsed = parseManifest(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed!.targets, {});
});

test("U5: нет electron-блока → обновления нет (Tauri-only релиз)", () => {
  const raw = manifest();
  delete (raw as any).electron;
  assert.deepEqual(decideUpdate(raw, "0.5.1", "ia32"), { kind: "none" });
});

test("U6: мусор в манифесте → invalid (клиент fail-open, не блокируется)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["sha256 короткий", { electron: { version: "0.5.2", platforms: { "win32-ia32": { url: "/u", sha256: "abc", size: 1 } } } }],
    ["size=0", { electron: { version: "0.5.2", platforms: { "win32-ia32": { url: "/u", sha256: SHA, size: 0 } } } }],
    ["http-URL", { electron: { version: "0.5.2", platforms: { "win32-ia32": { url: "http://x/u.exe", sha256: SHA, size: 1 } } } }],
    ["protocol-relative", { electron: { version: "0.5.2", platforms: { "win32-ia32": { url: "//evil/u.exe", sha256: SHA, size: 1 } } } }],
    ["версия мусор", { electron: { version: "latest", platforms: {} } }],
  ];
  for (const [name, override] of cases) {
    const decision = decideUpdate(manifest(override), "0.5.1", "ia32");
    assert.equal(decision.kind, "invalid", name);
  }
});

test("U7: арки нет в манифесте → обновления нет (эта арка не публиковалась)", () => {
  const raw = manifest({
    electron: {
      version: "0.5.2",
      platforms: {
        "win32-x64": { url: "/u/x64.exe", sha256: SHA, size: 5 },
      },
    },
  });
  assert.deepEqual(decideUpdate(raw, "0.5.1", "ia32"), { kind: "none" });
});

test("U8: версия не новее установленной → обновления нет (downgrade запрещён)", () => {
  assert.deepEqual(decideUpdate(manifest(), "0.5.2", "ia32"), { kind: "none" });
  assert.deepEqual(decideUpdate(manifest(), "0.6.0", "ia32"), { kind: "none" });
});

test("U9: новая версия → решение с URL/sha256/size и нижним регистром хеша", () => {
  const raw = manifest({
    electron: {
      version: "0.5.2",
      notes: "fix",
      platforms: {
        "win32-ia32": {
          url: "/updater/files/v0.5.2/ARTEL-Electron-0.5.2-ia32-setup.exe",
          sha256: SHA.toUpperCase(),
          size: 123,
        },
      },
    },
  });
  const d = decideUpdate(raw, "0.5.1", "ia32");
  assert.equal(d.kind, "update");
  if (d.kind !== "update") return;
  assert.equal(d.version, "0.5.2");
  assert.equal(d.notes, "fix");
  assert.equal(d.size, 123);
  assert.equal(d.sha256, SHA);
  assert.equal(d.url, "/updater/files/v0.5.2/ARTEL-Electron-0.5.2-ia32-setup.exe");
});

test("U10: относительный URL резолвится от базы; чужие схемы/host запрещены", () => {
  assert.equal(
    resolveUpdateUrl(BASE, "/updater/files/v0.5.2/a.exe"),
    `${BASE}/updater/files/v0.5.2/a.exe`,
  );
  assert.equal(resolveUpdateUrl(`${BASE}/`, "/u/a.exe"), `${BASE}/u/a.exe`);
  assert.equal(resolveUpdateUrl(BASE, "http://evil/a.exe"), null);
  assert.equal(resolveUpdateUrl(BASE, "//evil/a.exe"), null);
  assert.equal(resolveUpdateUrl(BASE, "file:///c:/a.exe"), null);
  assert.equal(resolveUpdateUrl(BASE, "https://evil/a.exe"), null); // чужой host
  assert.equal(resolveUpdateUrl("not-a-url", "/u/a.exe"), null);
});

test("U11: parseManifest терпит лишние поля и не падает на null", () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest("x"), null);
  const parsed: UpdateManifest | null = parseManifest({ ...manifest(), extra: 1 });
  assert.ok(parsed);
  assert.equal(parsed!.targets["win32-ia32"].sha256, SHA);
});
