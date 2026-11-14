/**
 * Тесты общих форматтеров ETA/скорости/байт (Task 2 «взрослого» ETA).
 *
 * Проверяем:
 *  F1  quantizeEta — корзины 1с/5с/30с/60с (анти-дрожание текста ETA).
 *  F2  formatDuration — единая логика округления (без скачков ceil/floor).
 *  F3  formatEta — null/0 → null; >24ч → честный ключ over_24h (не скрытие);
 *      конечные значения → квантованная длительность.
 *  F4  formatBytes/formatSpeed — B..TB, поддержка GB/s (ранее обрезалась на MB/s).
 *
 * Ранер: встроенный node:test. Запуск: npm run test:ui
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  quantizeEta,
  formatDuration,
  formatEta,
  formatBytes,
  formatSpeed,
} from "../src/ui/format";
import { t } from "../src/i18n";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;

test("F1: quantizeEta — корзины <10с шаг 1с", () => {
  assert.equal(quantizeEta(3.4), 3);
  assert.equal(quantizeEta(8.6), 9);
  assert.equal(quantizeEta(0.2), 1); // минимум 1с
});

test("F1: quantizeEta — корзины <60с шаг 5с", () => {
  assert.equal(quantizeEta(12.3), 10);
  assert.equal(quantizeEta(37), 35);
  assert.equal(quantizeEta(58.9), 60);
});

test("F1: quantizeEta — корзины <10мин шаг 30с, дальше шаг 60с", () => {
  assert.equal(quantizeEta(74), 60);
  assert.equal(quantizeEta(615), 600);
  assert.equal(quantizeEta(3700), 3720);
});

test("F2: formatDuration — единое округление, юниты из i18n", () => {
  const uSec = t("progress.unit_sec");
  const uMin = t("progress.unit_min");
  const uHour = t("progress.unit_hour");
  assert.equal(formatDuration(45), `45${uSec}`);
  assert.equal(formatDuration(95), `1${uMin} 35${uSec}`);
  assert.equal(formatDuration(150), `2${uMin} 30${uSec}`);
  assert.equal(formatDuration(3900), `1${uHour} 05${uMin}`);
});

test("F3: formatEta — null/0 → null (терминальные состояния рисует UI)", () => {
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(0), null);
  assert.equal(formatEta(-5), null);
});

test("F3: formatEta — >24ч → честный over_24h вместо скрытия", () => {
  assert.equal(formatEta(93600), t("progress.over_24h"));
  assert.equal(formatEta(86401), t("progress.over_24h"));
});

test("F3: formatEta — конечное значение = квантованная длительность", () => {
  assert.equal(formatEta(160), formatDuration(quantizeEta(160)));
  assert.equal(formatEta(37), formatDuration(quantizeEta(37)));
});

test("F4: formatBytes — 0/KB/MB/GB/TB", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * MB), "5.0 MB");
  assert.equal(formatBytes(4.61 * GB), "4.6 GB");
  assert.equal(formatBytes(1.2 * 1024 * GB), "1.2 TB");
});

test("F4: formatSpeed — поддержка GB/s (ранее обрезалась на MB/s)", () => {
  assert.equal(formatSpeed(0), "0 B/s");
  assert.equal(formatSpeed(500 * KB), "500 KB/s");
  assert.equal(formatSpeed(5 * MB), "5.0 MB/s");
  assert.equal(formatSpeed(1.5 * GB), "1.5 GB/s");
});
