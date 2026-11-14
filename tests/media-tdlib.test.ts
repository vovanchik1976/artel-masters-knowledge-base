/**
 * Медиа карточки через СВОЮ TDLib — чистая логика (SP-15 срез 5, D-071).
 *
 * Приказ владельца (2026-10-13): «Гоним всё через TDLib ровно так, как и файлы».
 * Проверяем ровно то, на чём этот путь ломается незаметно:
 *
 *   T1 `mediaAnchorOf` — якорь только при чате + ключе сообщения (иначе TDLib-путь
 *      невозможен и должен молча уйти на серверный прокси);
 *   T2 `pickMediaFileId` — thumb-вариант берёт миниатюру, а при её отсутствии
 *      падает на ОРИГИНАЛ (fail-open, как сервер); нет файла → 0 (не «что-нибудь»);
 *   T3 `mediaCacheFileName` — стабилен, различает варианты, санитайзит unique_id,
 *      расширение берёт из имени оригинала;
 *   T4 `joinLocalPath` — Windows/POSIX, хвостовые слэши, пустой каталог;
 *   T5 `localFileUrl` — Windows/POSIX, пробел, `#` (файл с «#» иначе не откроется);
 *   T6 `mediaDownloadOutcome` — error важнее completed, прогресс ≠ финал;
 *   T7 `mediaCacheKey` — разные варианты/файлы не схлопываются в один ключ.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expectedMediaBytes,
  joinLocalPath,
  localFileUrl,
  mediaAnchorOf,
  mediaCacheFileName,
  mediaCacheKey,
  mediaDownloadOutcome,
  pickMediaFileId,
  type MediaAnchor,
} from "../src/ui/MediaTdlib";

const ANCHOR: MediaAnchor = {
  chatId: 777,
  messageId: 585,
  uniqueId: "AgAD8KcAAkAKuEk",
  sizeBytes: 26_214_400,
};

test("T1: якорь собирается только при чате и ключе сообщения", () => {
  assert.deepEqual(
    mediaAnchorOf({
      tg_chat_id: 777,
      tg_message_id: 585,
      tg_file_unique_id: "UID",
      size_bytes: 1000,
    }),
    { chatId: 777, messageId: 585, uniqueId: "UID", sizeBytes: 1000 },
  );
  // Только unique_id (bot-side id не нужен — резолв идёт по истории PM).
  assert.deepEqual(
    mediaAnchorOf({ tg_chat_id: 777, tg_file_unique_id: "UID" }),
    { chatId: 777, messageId: 0, uniqueId: "UID", sizeBytes: 0 },
  );
  // Нет чата или нет ключа — TDLib-путь невозможен (фолбэк на прокси).
  assert.equal(mediaAnchorOf({ tg_message_id: 585, tg_file_unique_id: "UID" }), null);
  assert.equal(mediaAnchorOf({ tg_chat_id: 777 }), null);
  assert.equal(mediaAnchorOf(null), null);
  assert.equal(mediaAnchorOf(undefined), null);
});

test("T2: выбор файла под вариант — thumb, иначе оригинал (fail-open)", () => {
  const info = { file_id: 900, size: 26_214_400, thumb_file_id: 901, thumb_size: 12_345 };
  assert.equal(pickMediaFileId(info, "thumb"), 901);
  assert.equal(pickMediaFileId(info, "full"), 900);
  // Миниатюры нет — превью-слот тянет оригинал (как сервер: variant=thumb без thumb).
  assert.equal(pickMediaFileId({ file_id: 900, thumb_file_id: 0 }, "thumb"), 900);
  // Нет основного файла — 0: вызывающий обязан уйти в фолбэк, а не качать «что-то».
  assert.equal(pickMediaFileId({ thumb_file_id: 901 }, "full"), 0);
  assert.equal(pickMediaFileId(null, "thumb"), 0);
  assert.equal(expectedMediaBytes(info, "thumb"), 12_345);
  assert.equal(expectedMediaBytes(info, "full"), 26_214_400);
  assert.equal(expectedMediaBytes({ file_id: 900, thumb_file_id: 901 }, "thumb"), 0);
});


test("T3: имя файла кеша — стабильное, разделяет варианты, санитайзит ключ", () => {
  assert.equal(mediaCacheFileName(ANCHOR, "thumb"), "c777_thumb_AgAD8KcAAkAKuEk.jpg");
  assert.equal(mediaCacheFileName(ANCHOR, "full", "IMG_0042.JPG"), "c777_full_AgAD8KcAAkAKuEk.jpg");
  assert.equal(
    mediaCacheFileName({ ...ANCHOR, uniqueId: "" }, "full", null),
    "c777_full_m585.img",
  );
  // Разделители/непечатное в unique_id не должны создавать подкаталоги.
  assert.equal(
    mediaCacheFileName({ ...ANCHOR, uniqueId: "a/b c+d" }, "thumb"),
    "c777_thumb_a_b_c_d.jpg",
  );
  // Длинный ключ подрезается (иначе Windows-лимит пути).
  const long = mediaCacheFileName({ ...ANCHOR, uniqueId: "x".repeat(200) }, "thumb");
  assert.ok(long.length < 80, `имя обязано быть коротким: ${long.length}`);
  assert.equal(mediaCacheFileName(ANCHOR, "thumb"), mediaCacheFileName(ANCHOR, "thumb"));
});

test("T4: joinLocalPath — POSIX/Windows, хвостовой слэш, пустой каталог", () => {
  assert.equal(
    joinLocalPath("/tmp/firmware-desktop/media", "a.jpg"),
    "/tmp/firmware-desktop/media/a.jpg",
  );
  assert.equal(joinLocalPath("/tmp/media/", "a.jpg"), "/tmp/media/a.jpg");
  assert.equal(joinLocalPath("C:\\Temp\\media", "a.jpg"), "C:\\Temp\\media\\a.jpg");
  assert.equal(joinLocalPath("", "a.jpg"), "a.jpg");
  assert.equal(joinLocalPath("/tmp/media", ""), "/tmp/media");
});

test("T5: localFileUrl — Windows/POSIX, пробел, `#`", () => {
  assert.equal(localFileUrl("C:\\Photos\\a b.jpg"), "file:///C:/Photos/a%20b.jpg");
  assert.equal(localFileUrl("/home/u/1.jpg"), "file:///home/u/1.jpg");
  // `#` в имени файла encodeURI не трогает — без замены путь обрезался бы.
  assert.equal(localFileUrl("/tmp/a#1.jpg"), "file:///tmp/a%231.jpg");
  assert.equal(localFileUrl(""), "");
});

test("T6: терминальное состояние передачи — error важнее completed", () => {
  assert.deepEqual(mediaDownloadOutcome({ completed: true }), { done: true, error: null });
  assert.deepEqual(mediaDownloadOutcome({ downloaded: 10, total: 100 }), {
    done: false,
    error: null,
  });
  assert.deepEqual(mediaDownloadOutcome({ completed: true, error: "move failed" }), {
    done: false,
    error: "move failed",
  });
  assert.deepEqual(mediaDownloadOutcome(null), { done: false, error: null });
});

test("T7: ключ кеша различает вариант и файл (иначе превью подменится оригиналом)", () => {
  assert.equal(mediaCacheKey(ANCHOR, "thumb"), "c777:AgAD8KcAAkAKuEk:thumb");
  assert.notEqual(mediaCacheKey(ANCHOR, "thumb"), mediaCacheKey(ANCHOR, "full"));
  assert.equal(mediaCacheKey({ ...ANCHOR, uniqueId: "" }, "full"), "c777:m585:full");
});
