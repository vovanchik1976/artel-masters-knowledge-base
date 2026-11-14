/**
 * Smoke-тесты ProgressUI v3 (Task 3/4 «взрослого» ETA) со стаб-DOM.
 *
 * Проверяем РЕНДЕР-слой поверх TransferMeter:
 *  P1  report → %, байты, ETA; displayRange маппит процент (upload 15..90).
 *  P2  stall (пауза без событий) → в ETA-строке прогресс.stalled.
 *  P3  setDone → «✅ 100%», ETA очищен, тикер остановлен.
 *  P4  Смена total → новая сессия метра (скорость не смешивается).
 *
 * Метр подменяется на инъекцию часов через приватное поле — это smoke UI-слоя,
 * вся математика покрыта transfer-meter.test.ts.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ProgressUI } from "../src/ui/Progress";
import { TransferMeter } from "../src/ui/TransferMeter";
import { t } from "../src/i18n";

const MB = 1024 * 1024;

interface StubEl {
  style: Record<string, string>;
  textContent: string;
}

function stubDom(): Record<string, StubEl> {
  const els: Record<string, StubEl> = {};
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string): StubEl => {
      if (!els[id]) els[id] = { style: {}, textContent: "" };
      return els[id];
    },
  };
  return els;
}

function makeUI(clock: () => number): {
  ui: ProgressUI;
  els: Record<string, StubEl>;
} {
  const els = stubDom();
  const ui = new ProgressUI("p", "f", "t", "e");
  (ui as unknown as { meter: TransferMeter }).meter = new TransferMeter({
    now: clock,
  });
  return { ui, els };
}

test("P1: report рендерит %, байты и ETA; displayRange маппит процент", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.report(0, 1000 * MB, { displayRange: [15, 90] });
  now += 5000;
  ui.report(500 * MB, 1000 * MB, { displayRange: [15, 90] });
  // 50% сырое → 15 + 50*0.75 = 52.5 → 53%
  assert.equal(els["f"].style.width, "53%");
  assert.ok(els["t"].textContent.includes("500"), els["t"].textContent);
  assert.ok(els["e"].textContent.includes("⏱"), els["e"].textContent);
  (ui as unknown as { stopTicker: () => void }).stopTicker();
});

test("P2: stall (пауза без событий) → progress.stalled в ETA-строке", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.report(0, 300 * MB);
  now += 5000;
  ui.report(100 * MB, 300 * MB);
  now += 15000; // события прекратились; рендерит UI-тик
  (ui as unknown as { renderNow: (o: null) => void }).renderNow(null);
  assert.equal(els["e"].textContent, t("progress.stalled"));
  (ui as unknown as { stopTicker: () => void }).stopTicker();
});

test("P3: setDone → «✅ 100%», ETA очищен", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.report(0, 100 * MB);
  now += 2000;
  ui.report(100 * MB, 100 * MB);
  ui.setDone();
  assert.equal(els["t"].textContent, "✅ 100%");
  assert.equal(els["e"].textContent, "");
});

test("P4: смена total начинает новую сессию метра (скорость не смешивается)", () => {
  let now = 0;
  const { ui } = makeUI(() => now);
  ui.report(0, 100 * MB);
  now += 4000;
  ui.report(80 * MB, 100 * MB); // 20MB/s
  now += 1000;
  ui.report(10 * MB, 500 * MB); // смена total → begin(500MB, 10MB)
  now += 1000;
  ui.report(40 * MB, 500 * MB); // 30MB/s
  const snap = (
    ui as unknown as { meter: TransferMeter }
  ).meter.snapshot();
  assert.ok(
    Math.abs(snap.speedBps - 30 * MB) / (30 * MB) < 0.3,
    `speed=${snap.speedBps}, ожидалось ~30MB/s`,
  );
  (ui as unknown as { stopTicker: () => void }).stopTicker();
});
test("P5: partLabel рендерится ВМЕСТЕ с процентом и байтами (composite/multi)", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.report(0, 100 * MB, { partLabel: "Parts 1/3" });
  now += 5000;
  ui.report(50 * MB, 100 * MB, { partLabel: "Parts 1/3" });
  const txt = els["t"].textContent;
  // Регресс BUG-DOWNLOAD-048: composite-ветка вызывала setMessage() после
  // report() и затирала строку процента. Метка обязана стоять рядом с «50%».
  assert.ok(txt.includes("Parts 1/3"), txt);
  assert.ok(txt.includes("50%"), txt);
  assert.ok(txt.includes("·"), txt);
  (ui as unknown as { stopTicker: () => void }).stopTicker();
});

// ── П.3: busy-индикация фоновых фаз (scan/pack/unpack) ───────────────────────

test("P6: startBusy → сообщение в прогрессе + счётчик ⏳ в ETA-строке", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.startBusy("Packing…");
  assert.equal(els["t"].textContent, "Packing…");
  assert.ok(els["e"].textContent.includes("⏳"), els["e"].textContent);
  // Пульс: ширина полосы живёт (не 0% и не 100%).
  const w = parseInt(els["f"].style.width, 10);
  assert.ok(w > 0 && w < 100, `width=${els["f"].style.width}`);
  ui.stopBusy();
});

test("P7: stopBusy гасит счётчик — ETA не остаётся «⏳ N с» после фазы", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.startBusy("Scanning…");
  ui.stopBusy();
  assert.ok(!els["e"].textContent.includes("⏳"), els["e"].textContent);
});

test("P8: report() после stopBusy рендерит обычный прогресс (busy не залипает)", () => {
  let now = 0;
  const { ui, els } = makeUI(() => now);
  ui.startBusy("Extracting…");
  ui.stopBusy();
  ui.report(50 * MB, 100 * MB);
  assert.ok(els["t"].textContent.includes("50%"), els["t"].textContent);
  (ui as unknown as { stopTicker: () => void }).stopTicker();
});

