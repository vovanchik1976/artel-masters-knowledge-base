/**
 * buildMultiPartDescriptors — маппинг частей сервера в Rust-descriptor +
 * Download-RCA зеркало в файл (Linux-dev, e2e-prod32).
 *
 * BUG-DOWNLOAD-051 (live 2026-09-25, files.id=35/38): для pm_lease сервер
 * отдаёт пер-частовые PM-якоря доставки (`pm_delivery`). Клиент обязан донести
 * их до Rust (`pm_chat_id`/`pm_message_id`), иначе Rust резолвит Vault-якорь
 * (`tg_file_id` bot-side) в чужой сессии → TDLib 400 Invalid remote file
 * identifier. Проверяем: pm-якоря пер-частовые, legacy/direct_vault — без них.
 *
 * Download-RCA: `appendDownloadRca` — best-effort мост `engine.appendDownloadRca`
 * (electron/main.ts → download-rca.log в FW_ELECTRON_LOG_DIR). Вне Electron
 * (node:test) `window.fwCloud` нет — no-op, передача не ломается.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendDownloadRca,
  buildMultiPartDescriptors,
  buildOwnerPartDescriptors,
  buildOwnerResolveParams,
  isTdlibRemoteFileId,
} from "../src/ui/downloadParts";

test("isTdlibRemoteFileId: base64 → true, числовой MTProto id → false", () => {
  assert.equal(isTdlibRemoteFileId("BQACAgIAAxkBAAICCGq2kH8"), true);
  assert.equal(isTdlibRemoteFileId("1234567890123"), false);
});

test("pm_delivery: каждый part несёт СВОЙ PM-якорь доставки", () => {
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 100,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0",
        mtproto: { mtproto_chat_id: -1003888664319, mtproto_message_id: 193 },
        pm_delivery: { chat_id: 111, message_id: 501, size: 100, order: 0 },
      },
      {
        index: 1,
        size: 200,
        sha256: "aa",
        tg_file_id: "BQACAgIAAxkBAAICCWq2kT0_p1",
        mtproto: { mtproto_chat_id: -1003888664319, mtproto_message_id: 195 },
        pm_delivery: { chat_id: 111, message_id: 502, size: 200, order: 1 },
      },
    ],
    -1003888664319,
  );

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((p) => [p.pm_chat_id, p.pm_message_id]),
    [[111, 501], [111, 502]],
  );
  assert.deepEqual(out.map((p) => p.part_index), [0, 1]);
  assert.deepEqual(out.map((p) => p.expected_size), [100, 200]);
  assert.deepEqual(out.map((p) => p.expected_sha256), [null, "aa"]);
});

test("BUG-DOWNLOAD-052: pm_delivery.unique_id доносится как pm_unique_id", () => {
  // Части с ОДИНАКОВЫМ размером (files.id=38): различает только стабильный ключ.
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 2093796556,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICO2q3_p0",
        unique_id: "AgAD8KcAAkAKuEk",
        pm_delivery: {
          chat_id: 8898752180,
          message_id: 577,
          size: 2093796556,
          order: 0,
          unique_id: "AgAD8KcAAkAKuEk",
        },
      },
      {
        index: 1,
        size: 2093796556,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICPGq3_p1",
        unique_id: "AgAD-acAAkAKuEk",
        pm_delivery: {
          chat_id: 8898752180,
          message_id: 578,
          size: 2093796556,
          order: 1,
          unique_id: "AgAD-acAAkAKuEk",
        },
      },
    ],
    -1003888664319,
  );

  assert.deepEqual(
    out.map((p) => p.pm_unique_id),
    ["AgAD8KcAAkAKuEk", "AgAD-acAAkAKuEk"],
  );
});

test("BUG-DOWNLOAD-052: pm_delivery.unique_id имеет приоритет над part.unique_id", () => {
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 100,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0",
        unique_id: "PART_UNIQ",
        pm_delivery: {
          chat_id: 111,
          message_id: 501,
          size: 100,
          order: 0,
          unique_id: "DELIVERY_UNIQ",
        },
      },
    ],
    null,
  );

  assert.equal(out[0].pm_unique_id, "DELIVERY_UNIQ");
});

test("BUG-DOWNLOAD-052: пустой/отсутствующий unique_id → pm_unique_id не задан", () => {
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 100,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0",
        pm_delivery: { chat_id: 111, message_id: 501, size: 100, order: 0, unique_id: "" },
      },
    ],
    null,
  );

  assert.equal(out[0].pm_unique_id, undefined);
});

test("legacy (без pm_delivery): pm-якорей нет — поведение как раньше", () => {
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 10,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0",
        mtproto: { mtproto_chat_id: -1003888664319, mtproto_message_id: 193 },
      },
    ],
    -1003888664319,
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].pm_chat_id, undefined);
  assert.equal(out[0].pm_message_id, undefined);
  // Прежний hint-контракт (join/getChat + getMessage-warmup) сохранён.
  assert.equal(out[0].chat_id, -1003888664319);
  assert.equal(out[0].message_id, 193);
});

test("без mtproto.chat_id (0/null) hint не передаётся", () => {
  const out = buildMultiPartDescriptors(
    [{ index: 0, size: 10, sha256: "", tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0" }],
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].chat_id, undefined);
  assert.equal(out[0].message_id, undefined);
});

test("части с нечисловым/пустым tg_file_id отфильтрованы", () => {
  const out = buildMultiPartDescriptors(
    [
      { index: 0, size: 10, sha256: "", tg_file_id: "123456" },
      { index: 1, size: 10, sha256: "", tg_file_id: "" },
      { index: 2, size: 10, sha256: "", tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p2" },
    ],
    null,
  );
  assert.deepEqual(out.map((p) => p.part_index), [2]);
});

test("pm_delivery с нулевым message_id не превращается в якорь", () => {
  const out = buildMultiPartDescriptors(
    [
      {
        index: 0,
        size: 10,
        sha256: "",
        tg_file_id: "BQACAgIAAxkBAAICCGq2kH8_p0",
        pm_delivery: { chat_id: 111, message_id: 0, size: 10, order: 0 },
      },
    ],
    null,
  );
  assert.equal(out[0].pm_chat_id, 111);
  assert.equal(out[0].pm_message_id, undefined);
});

test("buildOwnerResolveParams: unique_id + size включают strict-резолв (BUG-DOWNLOAD-052 фаза 3)", () => {
  // Сервер отдаёт стабильный ключ документа доставки → Rust резолвит по нему,
  // а не по bot-side messageId («самый свежий документ чата» — чужой риск).
  const full = buildOwnerResolveParams({
    owner_pm_chat_id: 8898752180,
    delivery_message_id: 602,
    delivery_unique_id: "AgADYagAAkAKuEk",
    size_bytes: 4096,
  });
  assert.deepEqual(full, {
    chatId: 8898752180,
    messageId: 602,
    uniqueId: "AgADYagAAkAKuEk",
    expectedSize: 4096,
  });

  // Старый сервер (без unique/size) — прежний путь по messageId.
  const legacy = buildOwnerResolveParams({
    owner_pm_chat_id: 8898752180,
    delivery_message_id: 602,
  });
  assert.deepEqual(legacy, { chatId: 8898752180, messageId: 602, uniqueId: undefined });

  // Пустая строка/ноль — как отсутствие ключа.
  const empty = buildOwnerResolveParams({
    owner_pm_chat_id: 8898752180,
    delivery_message_id: 602,
    delivery_unique_id: "",
    size_bytes: 0,
  });
  assert.deepEqual(empty, { chatId: 8898752180, messageId: 602, uniqueId: undefined });
});

test("buildOwnerPartDescriptors: owner-части идут по pm-якорям в порядке part_index (BUG-DOWNLOAD-052 фаза 3)", () => {
  const out = buildOwnerPartDescriptors([
    {
      index: 1,
      size: 1314464227,
      unique_id: "AgADtZwAAvCuuUk",
      tg_file_id: null,
      pm_delivery: {
        chat_id: 8898752180, message_id: 616562688, size: 1314464227,
        order: 1, unique_id: "AgADtZwAAvCuuUk",
      },
    },
    {
      index: 0,
      size: 2093796556,
      unique_id: "AgADr5wAAvCuuUk",
      tg_file_id: null,
      pm_delivery: {
        chat_id: 8898752180, message_id: 617611264, size: 2093796556,
        order: 0, unique_id: "AgADr5wAAvCuuUk",
      },
    },
  ]);

  // Порядок частей критичен для склейки — сортируем по part_index.
  assert.deepEqual(out.map((p) => p.part_index), [0, 1]);
  assert.deepEqual(
    out.map((p) => [p.pm_chat_id, p.pm_message_id, p.pm_unique_id]),
    [
      [8898752180, 617611264, "AgADr5wAAvCuuUk"],
      [8898752180, 616562688, "AgADtZwAAvCuuUk"],
    ],
  );
  assert.deepEqual(out.map((p) => p.expected_size), [2093796556, 1314464227]);
  // tg_file_id отсутствует — Rust допускает пустой remote id при pm-якоре.
  assert.deepEqual(out.map((p) => p.tg_file_id), ["", ""]);
});

test("buildOwnerPartDescriptors: числовой tg_file_id не доносится, pm-якорь сохраняется", () => {
  const out = buildOwnerPartDescriptors([
    { index: 0, size: 10, tg_file_id: "24470618112", pm_delivery: { chat_id: 1, message_id: 2, unique_id: "U1" } },
  ]);
  assert.equal(out[0].tg_file_id, "");
  assert.equal(out[0].pm_chat_id, 1);
  assert.equal(out[0].pm_message_id, 2);
  assert.equal(out[0].pm_unique_id, "U1");
});

test("download-rca: мост до download-rca.log — no-op вне Electron, с мостом шлёт JSON", async () => {
  // Вне Electron window.fwCloud нет — вызов не должен бросать.
  appendDownloadRca({ source: "ui", op: "single", phase: "test_noop" });

  // С мостом — уходит одна JSON-строка {op,...} командой engine.appendDownloadRca.
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  (globalThis as unknown as { window: unknown }).window = {
    fwCloud: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return { status: "ok" };
      },
    },
  };
  try {
    appendDownloadRca({ source: "ui", op: "multi", phase: "part_fetch", part_index: 1 });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "engine.appendDownloadRca");
    const line = String((calls[0].args as Record<string, unknown>).line ?? "");
    assert.match(line, /"op":"multi"/);
    assert.match(line, /"phase":"part_fetch"/);
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
});
