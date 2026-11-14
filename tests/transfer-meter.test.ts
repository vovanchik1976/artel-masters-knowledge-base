/**
 * Тесты TransferMeter — «взрослый» ETA (Task 1 плана переделки ETA).
 *
 * Что проверяем (сценарии = спецификация):
 *   T1  Регрессия по скользящему wall-clock окну глушит burst'ы (vs медиана мгновенных).
 *   T2  Межчастевая пауза (cooldown) входит в оценку скорости/ETA честно.
 *   T2b Долгая пауза → состояние stalled + ETA = null (вместо замороженной цифры).
 *   T3  Рестарт (bytes уменьшились) → история сброшена, ETA по новому offset.
 *   T4  Неизвестный total → eta=null, но скорость считается.
 *   T5  Stall → resume: состояние возвращается в running, оценка восстанавливается.
 *   T6  Ранняя фаза (до набора окна) — сид по EWMA, ETA уже конечен.
 *   T7  Очень медленная передача — ETA большой, но ЧЕСТНЫЙ (не прячется).
 *   T8  Нулевой прогресс / повторные отчёты — нет NaN, скорость >= 0.
 *   T9  finish()/reset() — корректные терминальные состояния.
 *   T10 Отчёт bytes == total → percent 100, eta 0.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 *   (= tsc -p tsconfig.tests.json && node tmp-tests/tests/transfer-meter.test.js)
 *
 * Часы инъекцируются — тесты полностью детерминированы.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TransferMeter } from "../src/ui/TransferMeter";

const MB = 1024 * 1024;

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

test("T1: регрессия по окну даёт среднюю скорость при burst-доставке (20MB каждые 4с → 5MB/s)", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(1000 * MB);
  for (let i = 1; i <= 10; i++) {
    c.tick(4000);
    meter.report(i * 20 * MB);
  }
  const s = meter.snapshot();
  // Мгновенная скорость внутри интервала = 20MB/0.2s = 100MB/s (burst),
  // честная средняя = 5MB/s. Окно 20с содержит ~5-6 равных интервалов.
  assert.ok(
    Math.abs(s.speedBps - 5 * MB) / (5 * MB) < 0.1,
    `speed=${s.speedBps.toFixed(0)}, ожидалось ~${5 * MB}`,
  );
  assert.ok(s.etaSec !== null && s.etaSec > 0, `eta=${s.etaSec}`);
  // ETA: осталось 800MB при 5MB/s ≈ 160с
  assert.ok(
    Math.abs((s.etaSec as number) - 160) / 160 < 0.25,
    `eta=${s.etaSec}, ожидалось ~160с`,
  );
});

test("T2: межчастевая пауза входит в скорость — ETA честный, не по мгновенной скорости", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(300 * MB);
  // Часть 1: 100MB за 5с (мгновенно 20MB/s)
  for (let i = 1; i <= 10; i++) {
    c.tick(500);
    meter.report(i * 10 * MB);
  }
  // Cooldown 1.5с: байт не прибавилось, но событие (тот же offset) пришло
  c.tick(1500);
  meter.report(100 * MB);
  const s = meter.snapshot();
  assert.ok(s.etaSec !== null, "eta должен существовать");
  // Мгновенная оценка дала бы 200MB/20MB/s = 10с. Окно с паузой честно медленнее.
  assert.ok(
    (s.etaSec as number) > 10,
    `eta=${s.etaSec} должен быть > 10с (пауза удлиняет оценку)`,
  );
  assert.ok(s.speedBps < 20 * MB, `speed=${s.speedBps} должен быть < 20MB/s`);
});

test("T2b: долгая пауза (без событий) → stalled, ETA скрыт, а не заморожен", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(300 * MB);
  for (let i = 1; i <= 10; i++) {
    c.tick(500);
    meter.report(i * 10 * MB);
  }
  // События прекратились (cooldown части). UI продолжает опрашивать snapshot.
  c.tick(15000); // пауза 15с > stallSec=8с
  const s = meter.snapshot();
  assert.equal(s.state, "stalled");
  assert.equal(s.etaSec, null);
  assert.equal(s.bytesDone, 100 * MB);
});

test("T3: рестарт (bytes уменьшились) → история сброшена, оценка заново с offset", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(1000 * MB);
  for (let i = 1; i <= 10; i++) {
    c.tick(1000);
    meter.report(i * 10 * MB);
  }
  // Новая попытка начинается с частичного offset 2MB
  c.tick(2000);
  meter.report(2 * MB);
  const s0 = meter.snapshot();
  assert.equal(s0.bytesDone, 2 * MB, "bytesDone = новый offset");
  // Разгон с 2MB: +30MB каждую секунду
  c.tick(1000);
  meter.report(2 * MB + 30 * MB);
  c.tick(1000);
  meter.report(2 * MB + 60 * MB);
  const s = meter.snapshot();
  // Старая история (10MB/s) не должна смешиваться с новой (30MB/s)
  assert.ok(
    Math.abs(s.speedBps - 30 * MB) / (30 * MB) < 0.25,
    `speed=${s.speedBps}, ожидалось ~30MB/s`,
  );
  assert.ok(s.etaSec !== null && s.etaSec > 0);
});
test("T4: неизвестный total → eta=null, скорость считается", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(0); // total неизвестен
  for (let i = 1; i <= 5; i++) {
    c.tick(1000);
    meter.report(i * 5 * MB);
  }
  const s = meter.snapshot();
  assert.equal(s.etaSec, null);
  assert.ok(s.speedBps > 0, `speed=${s.speedBps}`);
  assert.equal(s.state, "running");
});

test("T5: stall → resume: состояние и скорость восстанавливаются", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(300 * MB);
  for (let i = 1; i <= 10; i++) {
    c.tick(500);
    meter.report(i * 10 * MB);
  }
  c.tick(15000); // stall
  assert.equal(meter.snapshot().state, "stalled");
  // Байты пошли снова
  c.tick(1000);
  meter.report(150 * MB);
  c.tick(1000);
  meter.report(200 * MB);
  const s = meter.snapshot();
  assert.equal(s.state, "running");
  assert.ok(s.speedBps > 0, `speed=${s.speedBps}`);
  assert.ok(s.etaSec !== null && s.etaSec > 0);
});

test("T6: ранняя фаза (окно ещё не набрано) — сид по EWMA, ETA конечен", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(1000 * MB);
  c.tick(300);
  meter.report(3 * MB);
  c.tick(300);
  meter.report(6 * MB);
  const s = meter.snapshot();
  assert.ok(s.speedBps > 0, `speed=${s.speedBps}`);
  // мгновенная = 10MB/s; допускаем широкий коридор
  assert.ok(
    s.speedBps > 2 * MB && s.speedBps < 40 * MB,
    `speed=${s.speedBps} вне коридора`,
  );
  assert.ok(s.etaSec !== null && Number.isFinite(s.etaSec));
});

test("T7: очень медленная передача — ETA большой, но честный (не прячется)", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(1000 * MB);
  for (let i = 1; i <= 25; i++) {
    c.tick(1000);
    meter.report(i * MB);
  }
  const s = meter.snapshot();
  assert.ok(s.speedBps > 0 && s.speedBps <= 2 * MB, `speed=${s.speedBps}`);
  assert.ok(
    s.etaSec !== null && (s.etaSec as number) > 900,
    `eta=${s.etaSec} — должен остаться (не null, не скрыт)`,
  );
});

test("T8: нулевой прогресс/повторные отчёты — нет NaN, скорость >= 0", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(100 * MB);
  meter.report(0);
  c.tick(1000);
  meter.report(0);
  c.tick(1000);
  meter.report(0);
  const s = meter.snapshot();
  assert.ok(Number.isFinite(s.speedBps), `speed=${s.speedBps} NaN/Inf`);
  assert.ok(s.speedBps >= 0);
  assert.ok(Number.isFinite(s.elapsedSec));
  // Строго до stall-порога (2с < 8с)
  assert.equal(s.state, "running");
});

test("T9: finish() и reset() — корректные терминальные состояния", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(100 * MB);
  c.tick(1000);
  meter.report(50 * MB);
  meter.finish();
  const s = meter.snapshot();
  assert.equal(s.state, "idle");
  assert.equal(s.etaSec, null);
  meter.reset(300 * MB);
  const s2 = meter.snapshot();
  assert.equal(s2.bytesDone, 0);
  assert.equal(s2.bytesTotal, 300 * MB);
  assert.equal(s2.state, "running");
});

test("T10: отчёт с байтами = total → percent 100, eta 0", () => {
  const c = fakeClock();
  const meter = new TransferMeter({ now: c.now });
  meter.begin(100 * MB);
  c.tick(2000);
  meter.report(50 * MB);
  c.tick(2000);
  meter.report(100 * MB);
  const s = meter.snapshot();
  assert.equal(s.percent, 100);
  assert.equal(s.etaSec, 0);
});

