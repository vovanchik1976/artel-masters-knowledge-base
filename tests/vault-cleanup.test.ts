/**
 * Гейт уборки копии личного файла из чата с ботом (решение владельца
 * 2026-11-10, вариант «Б»).
 *
 * Смысл: личное хранилище ARTEL — указатели на документы в личке с ботом.
 * Когда файл забрали на диск, копия в чате больше не нужна, иначе чат с ботом
 * превращается в складку (для файлов >2 ГБ там десятки сообщений-частей).
 * Поэтому после успешного скачивания ARTEL предлагает убрать копию одним
 * тапом; файл при этом пропадает из ARTEL (как при «Удалить из личного»).
 *
 * Проверяем:
 *   1) чистую логику уборки (запись в ARTEL + self-delete сообщений в PM,
 *      честные ошибки);
 *   2) по ИСХОДНИКАМ: колбэк после скачивания, предложение с честным
 *      предупреждением, локализация во всех трёх языках.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  removePersonalChatCopy,
  type ChatCopyRemovalDeps,
} from "../src/ui/vaultCleanup";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "tests"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron");
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Фейковые зависимости: сервер отдаёт pm_delete, клиент «удаляет» сообщения. */
function deps(overrides: Partial<ChatCopyRemovalDeps> = {}): {
  deps: ChatCopyRemovalDeps;
  deleted: Array<{ chatId: number; messageIds: number[] }>;
} {
  const deleted: Array<{ chatId: number; messageIds: number[] }> = [];
  const base: ChatCopyRemovalDeps = {
    deleteFile: async () => ({
      pm_delete: { chat_id: 999000111, message_ids: [11, 12, 13] },
    }),
    deleteMessages: async (chatId: number, messageIds: number[]) => {
      deleted.push({ chatId, messageIds });
    },
    ...overrides,
  };
  return { deps: base, deleted };
}

test("T1: уборка удаляет запись в ARTEL и сообщения в чате", async () => {
  const { deps: d, deleted } = deps();
  const res = await removePersonalChatCopy(42, d);
  assert.equal(res.removed, true);
  assert.equal(res.messages, 3);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].chatId, 999000111);
  assert.deepEqual(deleted[0].messageIds, [11, 12, 13]);
});

test("T2: если копии в чате нет — запись всё равно убрана, ошибки нет", async () => {
  const { deps: d, deleted } = deps({
    deleteFile: async () => ({ pm_delete: null }),
  });
  const res = await removePersonalChatCopy(42, d);
  assert.equal(res.removed, true);
  assert.equal(res.messages, 0);
  assert.equal(deleted.length, 0);
});

test("T3: ошибка удаления сообщений возвращается наружу (не молчим)", async () => {
  const { deps: d } = deps({
    deleteMessages: async () => {
      throw new Error("TDLib: chat not found");
    },
  });
  const res = await removePersonalChatCopy(42, d);
  assert.equal(res.removed, false);
  assert.match(String(res.error), /TDLib/);
});

test("T4: ошибка сервера — запись не убрана, ошибка наружу", async () => {
  const { deps: d, deleted } = deps({
    deleteFile: async () => {
      throw new Error("401 Unauthorized");
    },
  });
  const res = await removePersonalChatCopy(42, d);
  assert.equal(res.removed, false);
  assert.match(String(res.error), /401/);
  assert.equal(deleted.length, 0);
});

test("T5: после скачивания клиент зовёт колбэк уборки", () => {
  const src = read("src/ui/DownloadPage.ts");
  assert.ok(src.includes("onPersonalDownloaded"), "нет колбэка onPersonalDownloaded");
  assert.ok(
    src.includes("this.onPersonalDownloaded?.(pfId, resolvedName)"),
    "колбэк не зовётся после успешной загрузки",
  );
});

test("T6: предложение убрать копию показывается с честным предупреждением", () => {
  const app = read("src/ui/App.ts");
  assert.ok(app.includes("_offerRemoveChatCopy"), "нет метода предложения уборки");
  assert.ok(app.includes("promptRemoveChatCopy("), "нет вызова модалки");
  assert.ok(
    app.includes('t("vault.chat_copy_offer_text")'),
    "нет текста предупреждения",
  );
  assert.ok(
    app.includes("removePersonalChatCopy("),
    "нет вызова уборки копии",
  );
  assert.ok(
    app.includes("liveChatCopyRemovalDeps()"),
    "нет боевых зависимостей уборки",
  );
});

test("T7: локализация — ключи уборки во всех трёх языках", () => {
  for (const locale of ["uk.ts", "ru.ts", "en.ts"]) {
    const src = read(`src/i18n/locales/${locale}`);
    for (const key of [
      "chat_copy_offer_text",
      "chat_copy_remove",
      "chat_copy_keep",
      "chat_copy_removed",
      "chat_copy_remove_failed",
    ]) {
      assert.ok(src.includes(`${key}:`), `${locale}: нет ключа ${key}`);
    }
  }
});
