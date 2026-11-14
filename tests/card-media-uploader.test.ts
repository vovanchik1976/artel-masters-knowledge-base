/**
 * Тесты CardMediaUploader (SP-15 v3, D-069): порядок шагов и обработка отказов.
 *
 *   U1 порядок: init → startUpload(chat=PM бота, pm=true, sessionUploadId) → wait → complete;
 *   U2 нет PM-чата (host-mediation выключена) → шлём в vault_chat_id, pm=false;
 *   U3 бот отклонил (`failed`) → бросаем с серверным текстом, галерею не трогаем;
 *   U4 `processing` → опрос до `completed`, пауза между попытками;
 *   U5 исчерпание попыток → таймаут;
 *   U6 нет chat_id от сервера → ошибка ДО начала передачи байтов.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CardMediaUploader,
  type MediaCompleteResult,
  type MediaInitResult,
} from "../src/ui/CardMediaUploader";

function initResponse(over: Partial<MediaInitResult> = {}): MediaInitResult {
  return {
    ok: true,
    upload_id: "11111111-2222-3333-4444-555555555555",
    mode: "public",
    vault_chat_id: -1001234567890,
    topic_id: 555,
    pm_chat_id: 777000,
    caption_hint: "upload_id:11111111-2222-3333-4444-555555555555",
    max_media: 12,
    ...over,
  };
}

function completeResponse(over: Partial<MediaCompleteResult> = {}): MediaCompleteResult {
  return { ok: true, status: "completed", error: null, media: [], ...over };
}

test("U1: порядок шагов и адрес PM бота", async () => {
  const calls: string[] = [];
  const uploader = new CardMediaUploader({
    init: async () => {
      calls.push("init");
      return initResponse();
    },
    startUpload: async (args) => {
      calls.push(`start:${args.chatId}:${args.pm}:${args.sessionUploadId}`);
      return "rust-1";
    },
    waitUpload: async (id) => {
      calls.push(`wait:${id}`);
    },
    complete: async () => {
      calls.push("complete");
      return completeResponse({ media: [{ id: 9, thumb_url: "/media/file/1/9/thumb", full_url: "/media/file/1/9/full" }] });
    },
  });

  const res = await uploader.addPhoto("file", 1, "C:/tmp/board.jpg");
  assert.equal(res.status, "completed");
  assert.deepEqual(calls, [
    "init",
    "start:777000:true:11111111-2222-3333-4444-555555555555",
    "wait:rust-1",
    "complete",
  ]);
});

test("U2: без PM-чата шлём в vault_chat_id (pm=false)", async () => {
  let seen: { chatId: number; pm: boolean } | null = null;
  const uploader = new CardMediaUploader({
    init: async () => initResponse({ pm_chat_id: null }),
    startUpload: async (args) => {
      seen = { chatId: args.chatId, pm: args.pm };
      return "rust-2";
    },
    waitUpload: async () => undefined,
    complete: async () => completeResponse(),
  });
  await uploader.addPhoto("personal", 5, "/tmp/x.png");
  assert.deepEqual(seen, { chatId: -1001234567890, pm: false });
});

test("U3: отказ бота → ошибка с серверным текстом", async () => {
  const uploader = new CardMediaUploader({
    init: async () => initResponse(),
    startUpload: async () => "rust-3",
    waitUpload: async () => undefined,
    complete: async () => completeResponse({ status: "failed", error: "медиа карточки: только изображения (фото)" }),
  });
  await assert.rejects(
    () => uploader.addPhoto("file", 1, "/tmp/doc.pdf"),
    /только изображения/,
  );
});

test("U4: processing → опрос до completed с паузой", async () => {
  let polls = 0;
  const sleeps: number[] = [];
  const uploader = new CardMediaUploader({
    init: async () => initResponse(),
    startUpload: async () => "rust-4",
    waitUpload: async () => undefined,
    complete: async () => {
      polls += 1;
      return polls < 3 ? completeResponse({ status: "processing" }) : completeResponse();
    },
    pollDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const res = await uploader.addPhoto("file", 1, "/tmp/a.jpg");
  assert.equal(res.status, "completed");
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [10, 10], "пауза только между попытками");
});

test("U5: исчерпание попыток → таймаут", async () => {
  const uploader = new CardMediaUploader({
    init: async () => initResponse(),
    startUpload: async () => "rust-5",
    waitUpload: async () => undefined,
    complete: async () => completeResponse({ status: "processing" }),
    maxPolls: 2,
    sleep: async () => undefined,
  });
  await assert.rejects(() => uploader.addPhoto("file", 1, "/tmp/a.jpg"), /таймаут/);
});

test("U6: нет chat_id → ошибка до передачи байтов", async () => {
  let started = false;
  const uploader = new CardMediaUploader({
    init: async () => initResponse({ pm_chat_id: null, vault_chat_id: 0 }),
    startUpload: async () => {
      started = true;
      return "rust-6";
    },
    waitUpload: async () => undefined,
    complete: async () => completeResponse(),
  });
  await assert.rejects(() => uploader.addPhoto("file", 1, "/tmp/a.jpg"), /chat_id/);
  assert.equal(started, false, "байты не отправляем без координат");
});
