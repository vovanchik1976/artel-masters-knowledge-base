/**
 * Очередь записи настроек чата (D-144, BUG-CHAT-SOUND-PREVIEW-001).
 *
 * ПОЧЕМУ ОЧЕРЕДЬ: `SettingsPage` писал настройки прямо из обработчика клика и
 * защищался флагом `busy` — то есть ВТОРОЙ клик по звуку молча игнорировался,
 * пока шла запись первого (мастер как раз перебирает шесть звуков: «через раз»).
 * Параллельные `chat_settings_set` тоже опасны: `this.value` перезаписывался
 * ответом, который пришёл последним, а не тем, который нажали последним.
 *
 * Теперь запись последовательная, а накопленное намерение («последнее побеждает»)
 * уходит следующим шагом. Проверяем именно это:
 *
 *   W1 перебор звуков: сохраняется ПОСЛЕДНИЙ выбор, лишние записи схлопываются;
 *   W2 два сохранения одновременно не выполняются (нет гонки ответов);
 *   W3 клик по уже сохранённому значению не пишет на диск вообще;
 *   W4 ошибка записи не зацикливает очередь и не мешает следующему клику;
 *   W5 `whenIdle()` честно ждёт окончания очереди (иначе тест/UI «завис» бы).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatSettingsWriter, type ChatSettingsWriterPort } from "../src/ui/ChatSettingsWriter";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "../shared/chatSettings";

/** Порт с задержкой записи: даёт «пока сохраняется» окно для второго клика. */
function harness(options: { delay?: number; failOn?: number[] } = {}) {
  let value: ChatSettings = { ...DEFAULT_CHAT_SETTINGS };
  const calls: ChatSettings[] = [];
  const applied: ChatSettings[] = [];
  let failures = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const port: ChatSettingsWriterPort = {
    current: () => ({ ...value }),
    save: async (next) => {
      calls.push({ ...next });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.delay) await new Promise((r) => setTimeout(r, options.delay));
        if (options.failOn?.includes(calls.length)) throw new Error("disk full");
        value = { ...next };
        return { ...value };
      } finally {
        inFlight -= 1;
      }
    },
    applied: (v) => {
      applied.push({ ...v });
    },
    failed: () => {
      failures += 1;
    },
  };

  return {
    writer: new ChatSettingsWriter(port),
    calls,
    applied,
    value: () => ({ ...value }),
    failures: () => failures,
    maxInFlight: () => maxInFlight,
  };
}

test("W1: перебор звуков сохраняет ПОСЛЕДНИЙ выбор, лишние записи схлопываются", async () => {
  const h = harness({ delay: 20 });
  const steps = [
    h.writer.submit({ sound_id: "drop" }),
    h.writer.submit({ sound_id: "ping" }),
    h.writer.submit({ sound_id: "knock" }),
  ];
  await Promise.all(steps);
  await h.writer.whenIdle();

  assert.equal(h.value().sound_id, "knock", "на диск обязан уйти последний выбранный звук");
  assert.ok(h.calls.length <= 2, `лишние записи не схлопнулись: ${h.calls.length} вместо ≤2`);
});

test("W2: две записи никогда не идут одновременно (нет гонки «кто ответил последним»)", async () => {
  const h = harness({ delay: 15 });
  await Promise.all([
    h.writer.submit({ sound_id: "chime" }),
    h.writer.submit({ sound_enabled: true }),
    h.writer.submit({ sound_id: "alert" }),
  ]);
  await h.writer.whenIdle();

  assert.equal(h.maxInFlight(), 1, "параллельный chat_settings_set перезаписывает чужой выбор");
  assert.equal(h.value().sound_id, "alert", "звук — последнее намерение мастера");
});

test("W3: клик по уже сохранённому значению не пишет на диск", async () => {
  const h = harness();
  await h.writer.submit({ sound_id: DEFAULT_CHAT_SETTINGS.sound_id });
  await h.writer.whenIdle();

  assert.equal(h.calls.length, 0, "запись без изменений — лишний IPC и лишний onSaved (лишний тост/перерисовка)");
});

test("W4: ошибка записи не зацикливает очередь и не мешает следующему клику", async () => {
  const h = harness({ failOn: [1] });
  await h.writer.submit({ sound_id: "triple" });
  await h.writer.whenIdle();

  assert.equal(h.failures(), 1, "отказ записи обязан дойти до UI (честный статус, а не тишина)");
  assert.equal(h.applied.length, 0, "несохранённое значение не применяется как сохранённое");

  await h.writer.submit({ sound_id: "ping" });
  await h.writer.whenIdle();

  assert.equal(h.value().sound_id, "ping", "после ошибки следующий выбор обязан сохраняться");
  assert.equal(h.applied.length, 1, "успешная запись обязана примениться");
});

test("W5: whenIdle() честно ждёт окончания очереди", async () => {
  const h = harness({ delay: 25 });
  const work = h.writer.submit({ sound_id: "chime" });

  await h.writer.whenIdle();
  assert.equal(h.value().sound_id, "chime", "whenIdle() вернулся раньше, чем запись дошла до диска");

  await work;
});
