#!/usr/bin/env node
/**
 * make-notification-sounds — генератор стандартных звуков уведомлений.
 *
 * ПОЧЕМУ СИНТЕЗ, А НЕ ГОТОВЫЕ ФАЙЛЫ: в проекте нет внешних медиа-ассетов
 * (лицензии, «чужие» звуки, вес в репозитории, LFS). Звуки ниже синтезируются
 * детерминированно (один и тот же байт-в-байт файл при повторном запуске),
 * это чистый PCM WAV 16-bit mono 44.1 кГц — его понимает Chromium в Electron 22
 * на Windows 7/8 без кодеков.
 *
 * Файл `water-drop.wav` (звук по умолчанию, «капля воды») НЕ пересоздаётся:
 * он уже принят владельцем 31.10.2026, скрипт его не трогает.
 *
 * Использование: node scripts/make-notification-sounds.mjs
 * Результат: public/audio/{chime,ping,knock,triple,alert}.wav
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const RATE = 44100;
const PEAK = 0.9;           // потолок после выравнивания громкости (запас от клиппинга)
const TARGET_RMS_DB = -20;  // громкость как у принятой «капли воды» (-22 dBFS), без «резких» звуков
const ATTACK = 0.004;       // 4 мс: без щелчка в начале
const TAIL_FADE = 0.02;     // 20 мс: без щелчка в конце

/** Детерминированный «шум» (LCG) — Math.random() запрещён: файл должен быть воспроизводим. */
function noiseFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

const sine = (freq, t) => Math.sin(2 * Math.PI * freq * t);

/** Колокольчик: сумма негармонических призвуков + экспоненциальное затухание. */
function strike(buffer, start, base, gain, partials) {
  for (let i = 0; i < buffer.length; i++) {
    const t = i / RATE - start;
    if (t < 0) continue;
    let value = 0;
    for (const [ratio, amp, tau] of partials) value += amp * sine(base * ratio, t) * Math.exp(-t / tau);
    buffer[i] += gain * value;
  }
}

/** Короткий тон с мягкой атакой и экспоненциальным спадом. */
function tone(buffer, start, freq, duration, tau, gain) {
  for (let i = 0; i < buffer.length; i++) {
    const t = i / RATE - start;
    if (t < 0 || t > duration) continue;
    const attack = Math.min(1, t / ATTACK);
    buffer[i] += gain * attack * sine(freq, t) * Math.exp(-t / tau);
  }
}

const seconds = (value) => Math.round(value * RATE);
const blank = (value) => new Float64Array(seconds(value));

/** chime — «Колокольчик»: два удара, второй выше (как системные уведомления Windows). */
function chime() {
  const buffer = blank(1.15);
  const bell = [[1, 1.0, 1.6], [2.0, 0.5, 1.2], [2.76, 0.3, 0.8], [5.4, 0.12, 0.45]];
  strike(buffer, 0, 1046.5, 0.85, bell);
  strike(buffer, 0.42, 1308.1, 0.55, bell);
  return buffer;
}

/** ping — «Пинг»: один высокий тон с обертоном, очень короткий. */
function ping() {
  const buffer = blank(0.4);
  tone(buffer, 0, 1320, 0.35, 0.07, 0.9);
  tone(buffer, 0, 2640, 0.3, 0.05, 0.22);
  return buffer;
}

/** knock — «Стук»: два низких удара (дерево/корпус), узнаваемо в мастерской. */
function knock() {
  const buffer = blank(0.5);
  for (const [start, seed] of [[0, 7], [0.16, 11]]) {
    tone(buffer, start, 170, 0.25, 0.055, 0.95);
    tone(buffer, start, 340, 0.2, 0.04, 0.35);
    const rnd = noiseFrom(seed * 7919);
    for (let i = 0; i < buffer.length; i++) {
      const t = i / RATE - start;
      if (t < 0 || t > 0.03) continue;
      buffer[i] += 0.28 * rnd() * Math.exp(-t / 0.012);
    }
  }
  return buffer;
}

/** triple — «Три сигнала»: три коротких бипа одинаковой высоты. */
function triple() {
  const buffer = blank(0.8);
  for (const start of [0, 0.22, 0.44]) tone(buffer, start, 1046.5, 0.12, 0.045, 0.6);
  return buffer;
}

/** alert — «Сигнал»: восходящий двухтональный (внимание, не «дзынь»). */
function alert() {
  const buffer = blank(0.85);
  tone(buffer, 0, 740, 0.22, 0.1, 0.75);
  tone(buffer, 0.1, 1108, 0.28, 0.09, 0.65);
  tone(buffer, 0.34, 1480, 0.3, 0.08, 0.5);
  return buffer;
}

/** Выравнивание громкости по RMS + мягкие края → PCM 16-bit mono WAV. */
function wav(buffer) {
  const body = Float64Array.from(buffer);
  const fade = seconds(TAIL_FADE);
  let peak = 0;
  let energy = 0;
  for (const v of body) {
    peak = Math.max(peak, Math.abs(v));
    energy += v * v;
  }
  const rms = body.length > 0 ? Math.sqrt(energy / body.length) : 0;
  // Сначала целимся в ту же громкость, что у принятой «капли» (RMS), потом
  // ограничиваем пик: колокольчик с высоким крест-фактором не должен «резаться».
  let scale = rms > 0 ? 10 ** (TARGET_RMS_DB / 20) / rms : 0;
  if (peak * scale > PEAK) scale = PEAK / peak;
  for (let i = 0; i < body.length; i++) {
    const tail = Math.min(1, (body.length - i) / fade);
    body[i] *= scale * tail;
  }
  const data = Buffer.alloc(body.length * 2);
  for (let i = 0; i < body.length; i++) {
    const sample = Math.max(-1, Math.min(1, body[i]));
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);            // размер fmt-блока
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(1, 22);             // моно
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);      // байт/сек
  header.writeUInt16LE(2, 32);             // выравнивание блока
  header.writeUInt16LE(16, 34);            // бит на сэмпл
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "public", "audio");
const SOUNDS = { chime: chime(), ping: ping(), knock: knock(), triple: triple(), alert: alert() };
for (const [name, buffer] of Object.entries(SOUNDS)) {
  const file = path.join(OUT, `${name}.wav`);
  writeFileSync(file, wav(buffer), { mode: 0o644 });
  console.log(`[sounds] ${name}.wav — ${wav(buffer).length} байт, ${(buffer.length / RATE).toFixed(2)} с`);
}
