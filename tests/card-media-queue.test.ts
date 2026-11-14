/**
 * Очередь фото карточки + мелкая арифметика панели (SP-15 срез 3b, D-069 v4).
 *
 * Приказ владельца (2026-10-13): фото выбираются СРАЗУ (с превью и лимитом), а в тему
 * карточки уходят автоматически после `/complete` — карточки до этого момента не
 * существует. Значит очередь — это МОДЕЛЬ, которая живёт без DOM и без TDLib, и её
 * поведение (лимит, дубли, «хвосты» прошлой карточки) обязано быть проверяемым.
 *
 *   Q1  лимит по умолчанию и отказ на N+1 фото;
 *   Q2  повтор того же пути не добавляется (`duplicate`);
 *   Q3  пустой путь отбрасывается (`no_path`) — без него загрузчик упал бы «молча»;
 *   Q4  фото, УЖЕ лежащие на карточке (галерея), тоже занимают лимит (`baseline`);
 *   Q5  конвейер: takeNext → sending, markSent/markError, retry, remove;
 *   Q6  `clearSent`/`dropSettled` НЕ трогают ждущие фото (потеря выбора = дефект);
 *   Q7  мусорные лимиты/счётчики игнорируются (иначе панель «залипнет» пустой);
 *   Q8  `MAX_MEDIA_FALLBACK` не разъехался с `MAX_PER_CARD` сервера;
 *   Q9  превью/имя/размер элемента: `previewUrl` выживает, имя — из пути;
 *   Q10 `localFileUrl` — Windows/POSIX, пробел, `#` (иначе файл с «#» не откроется);
 *   Q11 `mediaSizeNotice` — предупреждение «в веб будет только превью»;
 *   Q12 `ringGeometry` — геометрия кольца прогресса (спиннер и доли).
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { CardMediaQueue, MAX_MEDIA_FALLBACK } from "../src/ui/CardMediaQueue";
import { localFileUrl } from "../src/ui/CardMediaPanel";
import { MEDIA_LARGE_BYTES, mediaSizeNotice } from "../src/ui/MediaSize";
import { ringGeometry, ringIsIndeterminate } from "../src/ui/ProgressRing";

/** Корень проекта (там `index.html`, `src/`, `tests/`) — независимо от outDir. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "src"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`корень проекта не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

function photo(name: string, size = 1024): { path: string; name: string; size: number } {
  return { path: `/photos/${name}`, name, size };
}

// ─── Q1..Q4: лимит, дубли, пути, галерея ───────────────────────────────────

test("Q1: лимит по умолчанию и отказ на N+1 фото", () => {
  const queue = new CardMediaQueue();
  assert.equal(queue.max, MAX_MEDIA_FALLBACK);
  const res = queue.add([
    photo("1.jpg"),
    photo("2.jpg"),
    photo("3.jpg"),
    photo("4.jpg"),
    photo("5.jpg"),
    photo("6.jpg"),
  ]);
  assert.equal(res.added.length, MAX_MEDIA_FALLBACK, "лимит обязан обрезать пачку целиком");
  assert.deepEqual(res.rejected, [{ path: "/photos/6.jpg", reason: "limit" }]);
  assert.equal(queue.full, true);
  assert.equal(queue.used, MAX_MEDIA_FALLBACK);
});

test("Q2: повтор того же пути отклоняется (`duplicate`)", () => {
  const queue = new CardMediaQueue(5);
  queue.add([photo("a.jpg")]);
  const res = queue.add([photo("a.jpg")]);
  assert.equal(res.added.length, 0);
  assert.deepEqual(res.rejected, [{ path: "/photos/a.jpg", reason: "duplicate" }]);
  // Разные пути с одинаковым именем — это РАЗНЫЕ фото (пользователь мог выбрать из разных папок).
  const other = queue.add([{ path: "/other/a.jpg", name: "a.jpg", size: 10 }]);
  assert.equal(other.added.length, 1);
});

test("Q3: пустой путь отбрасывается (`no_path`) — загрузчику нечего отправлять", () => {
  const queue = new CardMediaQueue(5);
  const res = queue.add([{ path: "", name: "x.jpg", size: 10 }]);
  assert.equal(res.added.length, 0);
  assert.deepEqual(res.rejected, [{ path: "", reason: "no_path" }]);
});

test("Q4: галерея карточки входит в лимит (`baseline`)", () => {
  const queue = new CardMediaQueue(5);
  queue.setBaseline(3);
  assert.equal(queue.used, 3);
  const res = queue.add([photo("1.jpg"), photo("2.jpg"), photo("3.jpg")]);
  assert.equal(res.added.length, 2, "на карточке уже 3 из 5 — влезает только два");
  assert.deepEqual(res.rejected, [{ path: "/photos/3.jpg", reason: "limit" }]);
  assert.equal(queue.full, true);
});

// ─── Q5..Q7: конвейер и очистка ────────────────────────────────────────────

test("Q5: takeNext → sending, ошибка не авторетраится, «Повторить» возвращает в очередь", () => {
  const queue = new CardMediaQueue(5);
  const [first] = queue.add([photo("1.jpg"), photo("2.jpg")]).added;
  const taken = queue.takeNext();
  assert.equal(taken?.id, first.id);
  assert.equal(taken?.status, "sending");
  // Второй вызов берёт СЛЕДУЮЩЕЕ, а не то же самое.
  const second = queue.takeNext();
  assert.notEqual(second?.id, first.id);
  assert.equal(queue.takeNext(), null, "больше ждущих нет");

  queue.markError(first.id, "в теме карточки нет доступа");
  assert.equal(queue.items.find((it) => it.id === first.id)?.status, "error");
  assert.equal(queue.waitingCount, 0);
  assert.equal(queue.retry(first.id), true);
  assert.equal(queue.items.find((it) => it.id === first.id)?.status, "waiting");
  assert.equal(queue.items.find((it) => it.id === first.id)?.error, undefined);
  assert.equal(queue.retry(first.id), false, "повтор возможен только для упавшего фото");

  queue.markSent(second!.id);
  assert.equal(queue.sentCount, 1);
  const removed = queue.remove(second!.id);
  assert.equal(removed?.id, second!.id);
  assert.equal(queue.used, 1);
  assert.equal(queue.remove(99999), null);
});

test("Q6: clearSent/dropSettled сохраняют ждущие фото (потеря выбора = дефект)", () => {
  const queue = new CardMediaQueue(5);
  queue.setBaseline(2);
  const [a, b, c] = queue.add([photo("1.jpg"), photo("2.jpg"), photo("3.jpg")]).added;
  queue.markSent(a.id);
  queue.markError(b.id, "boom");

  const sent = queue.clearSent();
  assert.deepEqual(sent.map((it) => it.id), [a.id], "в галерею уходят только отправленные");
  assert.deepEqual(queue.items.map((it) => it.id), [b.id, c.id]);
  assert.equal(queue.max, 5, "baseline при clearSent не сбрасывается — галерея та же");

  const settled = queue.dropSettled();
  assert.deepEqual(
    settled.map((it) => it.id),
    [b.id],
    "«хвост» упавшего фото относится к прошлой карточке",
  );
  assert.deepEqual(queue.items.map((it) => it.id), [c.id], "ждущее фото обязано остаться");
  assert.equal(queue.used, 1, "новая карточка — галереи прошлой в лимите больше нет");

  const all = queue.clear();
  assert.deepEqual(all.map((it) => it.id), [c.id]);
  assert.equal(queue.items.length, 0);
});

test("Q7: мусорные лимиты/счётчики игнорируются (панель не «залипает» пустой)", () => {
  const queue = new CardMediaQueue(5);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    queue.setMax(bad as number);
    assert.equal(queue.max, 5, `setMax(${String(bad)}) не должен менять лимит`);
  }
  queue.setMax(3.7);
  assert.equal(queue.max, 3, "дробный лимит — вниз, до целого");
  queue.setBaseline(Number.NaN);
  assert.equal(queue.used, 0);
  const fallback = new CardMediaQueue(Number.NaN);
  assert.equal(fallback.max, MAX_MEDIA_FALLBACK, "кривой лимит конструктора → серверный fallback");
});

// ─── Q8: анти-дрейф с сервером ─────────────────────────────────────────────

const serverService = path.join(projectRoot(), "..", "bot", "services", "card_media_service.py");
const hasServerSource = fs.existsSync(serverService);

test(
  "Q8: MAX_MEDIA_FALLBACK совпадает с серверным MAX_PER_CARD",
  { skip: hasServerSource ? false : "серверный код не лежит рядом (client-only checkout)" },
  () => {
    const src = fs.readFileSync(serverService, "utf8");
    const match = /^MAX_PER_CARD\s*=\s*(\d+)\s*$/m.exec(src);
    assert.ok(match, "в card_media_service.py не найден MAX_PER_CARD");
    assert.equal(
      Number(match[1]),
      MAX_MEDIA_FALLBACK,
      "лимит в клиенте разъехался с серверным — пользователь увидит не тот лимит",
    );
  },
);

// ─── Q9..Q12: элемент очереди, превью, размер, кольцо ──────────────────────

test("Q9: элемент очереди — previewUrl, имя из пути, нулевой/битый размер", () => {
  const queue = new CardMediaQueue(5);
  const res = queue.add([
    { path: "C:\\Pic\\shot 1.jpg", name: "", size: Number.NaN, previewUrl: "blob:fw/1" },
    { path: "/tmp/b.jpg", name: "b.jpg", size: -5 },
  ]);
  const [first, second] = res.added;
  assert.equal(first.previewUrl, "blob:fw/1");
  assert.equal(first.name, "shot 1.jpg", "пустое имя берём из пути (Windows-разделитель)");
  assert.equal(first.size, 0, "битый размер — 0, а не NaN в разметке");
  assert.equal(second.previewUrl, undefined, "нет превью — панель деградирует до file:// по пути");
  assert.equal(second.size, 0);
});

test("Q10: localFileUrl — Windows/POSIX, пробел, символ `#`", () => {
  assert.equal(localFileUrl("C:\\Photos\\a b.jpg"), "file:///C:/Photos/a%20b.jpg");
  assert.equal(localFileUrl("/home/u/1.jpg"), "file:///home/u/1.jpg");
  // `#` в имени файла зарезервирован в URL — не экранировав, откроем не тот файл.
  assert.equal(localFileUrl("/tmp/a#1.jpg"), "file:///tmp/a%231.jpg");
  assert.equal(localFileUrl(""), "");
});

test("Q11: mediaSizeNotice — предупреждение только для реально больших кадров", () => {
  assert.equal(mediaSizeNotice(0), "ok");
  assert.equal(mediaSizeNotice(Number.NaN), "ok");
  assert.equal(mediaSizeNotice(MEDIA_LARGE_BYTES), "ok", "ровно на пороге — ещё не «крупное»");
  assert.equal(mediaSizeNotice(MEDIA_LARGE_BYTES + 1), "large");
});

test("Q12: ringGeometry — спиннер и доли окружности", () => {
  const spinner = ringGeometry(null);
  assert.equal(ringIsIndeterminate(null), true);
  assert.equal(spinner.dashOffset, Number((spinner.circumference * 0.75).toFixed(3)));

  const half = ringGeometry(0.5);
  assert.equal(ringIsIndeterminate(0.5), false);
  assert.equal(half.dashOffset, Number((half.circumference * 0.5).toFixed(3)));
  assert.equal(ringGeometry(1).dashOffset, 0);
  assert.equal(
    ringGeometry(-3).dashOffset,
    ringGeometry(0).dashOffset,
    "отрицательный прогресс зажимается",
  );
  assert.equal(ringGeometry(3).dashOffset, 0, "прогресс больше единицы зажимается");
  assert.ok(ringGeometry(0.5, 32, 3).radius > 0, "радиус положителен (иначе кольцо невидимо)");
});
