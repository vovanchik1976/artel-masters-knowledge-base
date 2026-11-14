/**
 * Гейт «Отправить другу» — передача личного файла другому мастеру
 * (SP-33, D-175).
 *
 * Проверяем:
 *   1) чистые помощники: поиск по справочнику (регистронезависимо, по
 *      кириллице), подпись получателя, остаток срока ссылки (72 ч);
 *   2) дескрипторы частей для скачивания: у СВОЕГО файла есть клиентский
 *      `tg_file_id`, у ПРИНЯТОГО от другого мастера — только PM-якорь
 *      (`pm_delivery` + `unique_id`): Rust резолвит документ в своём чате по
 *      уникальному ключу (BUG-DOWNLOAD-051/052);
 *   3) по ИСХОДНИКАМ: кнопка «Отправить другу» на карточке личного файла,
 *      вызовы API, панель входящих в шапке, push `share_received` через billing
 *      WebSocket (без таймеров-опросов), строки локализации во всех трёх языках
 *      (ru/uk/en — тип UkDict требует полный набор ключей).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildVaultPartDescriptors,
  directoryEntryLabel,
  directoryInitials,
  filterDirectory,
  hasDownloadAnchor,
  isShareExpired,
  remainingHours,
} from "../src/ui/vaultShare";

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

const DIRECTORY = [
  { user_ref: "1", display_name: "Иван Петров", username: "ivan_p" },
  { user_ref: "2", display_name: "Пётр Сидоров", username: "petr_s" },
  { user_ref: "3", display_name: "Мастер Без Ника", username: null },
];

test("T1: поиск получателя регистронезависим (и по кириллице)", () => {
  assert.equal(filterDirectory(DIRECTORY, "иван").length, 1);
  assert.equal(filterDirectory(DIRECTORY, "ИВАН")[0].user_ref, "1");
  assert.equal(filterDirectory(DIRECTORY, "petr")[0].user_ref, "2");
  assert.equal(filterDirectory(DIRECTORY, "").length, 3);
  assert.equal(filterDirectory(DIRECTORY, "нет-такого").length, 0);
});

test("T2: подпись получателя — имя и @ник", () => {
  assert.equal(directoryEntryLabel(DIRECTORY[0]), "Иван Петров (@ivan_p)");
  assert.equal(directoryEntryLabel(DIRECTORY[2]), "Мастер Без Ника");
  assert.equal(directoryEntryLabel({ user_ref: "9", display_name: "" }), "—");
});

test("T3: остаток срока ссылки (72 ч) и истечение", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const soon = new Date(now + 3 * 3600 * 1000).toISOString();
  const past = new Date(now - 3600 * 1000).toISOString();
  assert.equal(remainingHours(soon, now), 3);
  assert.equal(remainingHours(past, now), 0);
  assert.equal(isShareExpired(soon, now), false);
  assert.equal(isShareExpired(past, now), true);
  assert.equal(isShareExpired(null, now), true);
});

test("T4: свой личный файл — дескриптор с клиентским tg_file_id", () => {
  const parts = buildVaultPartDescriptors([
    { index: 0, size: 100, sha256: "ab", tg_file_id: "client-file-id" },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].tg_file_id, "client-file-id");
  assert.equal(hasDownloadAnchor(parts[0]), true);
});

test("T5: принятый файл — PM-якорь (unique_id), клиентского id нет", () => {
  const parts = buildVaultPartDescriptors([
    {
      index: 0,
      size: 2048,
      sha256: "",
      tg_file_id: "",
      pm_delivery: {
        chat_id: 999000111,
        message_id: 4242,
        size: 2048,
        order: 0,
        unique_id: "AgAD-unique",
      },
    },
  ]);
  assert.equal(parts[0].tg_file_id, "");
  assert.equal(parts[0].pm_unique_id, "AgAD-unique");
  assert.equal(parts[0].pm_chat_id, 999000111);
  assert.equal(parts[0].pm_message_id, 4242);
  // Rust допускает пустой tg_file_id при наличии pm-якоря (parse_parts).
  assert.equal(hasDownloadAnchor(parts[0]), true);
});

test("T6: часть без якоря скачать нечем — hasDownloadAnchor=false", () => {
  const parts = buildVaultPartDescriptors([{ index: 0, size: 10, tg_file_id: "" }]);
  assert.equal(hasDownloadAnchor(parts[0]), false);
});

test("T7: на личной карточке есть кнопка «Отправить другу»", () => {
  const src = read("src/ui/SearchPage.ts");
  assert.ok(src.includes("vault-share-btn"), "нет кнопки vault-share-btn");
  assert.ok(src.includes('t("vault.card_share")'), "нет подписи кнопки");
  assert.ok(src.includes("api.vaultShare("), "нет вызова api.vaultShare");
  assert.ok(src.includes("_openShareDialog"), "нет диалога выбора получателя");
  assert.ok(
    src.includes('t("vault.share_ttl_warning"'),
    "нет предупреждения про 72 часа",
  );
});

test("T8: API-клиент умеет справочник, отправку, приём и отказ", () => {
  const src = read("src/api.ts");
  for (const method of [
    "vaultDirectory",
    "vaultShare",
    "vaultIncomingShares",
    "vaultAcceptShare",
    "vaultDeclineShare",
  ]) {
    assert.ok(src.includes(method), `нет метода ${method}`);
  }
  assert.ok(src.includes("/desktop/vault/directory"), "нет пути справочника");
  assert.ok(src.includes("/desktop/vault/shares/"), "нет пути shares");
});

test("T9: в шапке — компактная кнопка входящих с поповером, а не громоздкий блок", () => {
  const app = read("src/ui/App.ts");
  const html = read("index.html");
  const box = read("src/ui/ShareInbox.ts");
  assert.ok(html.includes('id="shareInbox"'), "нет контейнера #shareInbox");
  assert.ok(html.includes('id="shareInboxToggle"'), "нет компактной кнопки входящих");
  assert.ok(html.includes('id="shareInboxPanel"'), "нет выпадающей панели");
  assert.ok(html.includes('id="shareInboxList"'), "нет списка входящих");
  assert.ok(html.includes('class="share-inbox-pulse"'), "нет мигающего индикатора");
  assert.ok(app.includes("new ShareInbox"), "App не создаёт компонент входящих");
  assert.ok(app.includes("_refreshShareInbox"), "нет обновления входящих");
  // D-181: входящие не опрашиваются таймером — сервер сам будит клиента
  // событием `share_received` по уже открытому billing-WebSocket.
  assert.ok(
    !app.includes("setInterval(() => void this._refreshShareInbox()"),
    "входящие нельзя опрашивать по таймеру",
  );
  assert.ok(
    !app.includes("setTimeout(() => void this._refreshShareInbox()"),
    "нет отложенного стартового опроса входящих",
  );
  assert.ok(
    app.includes('data.type === "share_received"'),
    "нет обработки push-события share_received",
  );
  assert.ok(
    /ws\.onopen\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,500}?_refreshShareInbox\(\)/.test(app),
    "при подключении WS входящие не обновляются (пропустим то, что пришло без WS)",
  );
  assert.ok(box.includes("share-accept-btn"), "нет кнопки сохранения");
  assert.ok(box.includes("share-decline-btn"), "нет кнопки отклонения");
  assert.ok(!app.includes("_renderShareInbox"), "громоздкая панель осталась в App");
  // Старый полноширинный блок над баннером удалён — входящие живут в шапке.
  assert.ok(
    !html.includes('<div class="share-inbox" id="shareInbox" hidden></div>'),
    "старый полноширинный блок не удалён",
  );
});

test("T10: локализация — ключи передач есть во всех трёх языках", () => {
  for (const locale of ["uk.ts", "ru.ts", "en.ts"]) {
    const src = read(`src/i18n/locales/${locale}`);
    for (const key of [
      "card_share",
      "share_title",
      "share_ttl_warning",
      "share_search",
      "share_sent",
      "share_failed",
      "share_inbox_title",
      "share_inbox_ttl",
      "share_inbox_open",
      "share_inbox_panel_title",
      "share_inbox_new",
      "share_inbox_save",
      "share_inbox_hint",
      "share_accept",
      "share_decline",
      "share_accepted",
      "share_expired",
    ]) {
      assert.ok(
        src.includes(`${key}:`),
        `${locale}: нет ключа ${key}`,
      );
    }
  }
});

test("T15: «Принять» сохраняет карточку в личный кабинет, а не уводит на скачивание", () => {
  const app = read("src/ui/App.ts");
  const search = read("src/ui/SearchPage.ts");
  const start = app.indexOf("private async _acceptShare");
  const end = app.indexOf("private async _declineShare", start);
  assert.ok(start > 0 && end > start, "не найден _acceptShare");
  const accept = app.slice(start, end);
  assert.ok(
    !accept.includes("downloadPage.downloadPersonal"),
    "приём всё ещё уводит на страницу скачивания",
  );
  assert.ok(
    accept.includes('setVaultScope("personal")'),
    "приём не включает личный кабинет",
  );
  assert.ok(accept.includes("showPersonal()"), "не открывает личный каталог");
  assert.ok(accept.includes("flashPersonalCard("), "новая карточка не подсвечивается");
  assert.ok(search.includes("data-personal-id"), "у карточки нет личного id");
  assert.ok(search.includes("flashPersonalCard"), "нет метода подсветки карточки");
});

test("T16: пульсирующий индикатор входящих виден сразу", () => {
  const html = read("index.html");
  assert.ok(/@keyframes\s+share-inbox-pulse/.test(html), "нет анимации пульса");
  const start = html.indexOf(".share-inbox {");
  const end = html.indexOf(".vault-share-overlay {");
  assert.ok(start > 0 && end > start, "не найден блок стилей входящих");
  const css = html.slice(start, end);
  assert.ok(css.includes("animation:"), "индикатор не анимирован");
  assert.ok(css.includes("prefers-reduced-motion"), "нет режима reduced-motion");
  assert.ok(
    css.includes(".share-inbox[hidden] { display: none; }"),
    "кнопка входящих останется видимой при hidden (display перебивает hidden)",
  );
  const box = read("src/ui/ShareInbox.ts");
  assert.ok(box.includes("share-inbox-dot"), "в строке входящего нет мигающей метки");
  assert.ok(box.includes("aria-expanded"), "кнопка не сообщает состояние панели");
  assert.ok(box.includes("Escape"), "панель не закрывается по Escape");
  assert.ok(
    box.includes("composedPath()"),
    "клик по действию после перерисовки закрывает панель (нужен composedPath)",
  );
});

test("T17: несколько входящих — компактный список со скроллом и счётчиком", () => {
  const html = read("index.html");
  const start = html.indexOf(".share-inbox-panel {");
  const end = html.indexOf(".vault-share-overlay {");
  assert.ok(start > 0 && end > start, "не найдена панель входящих");
  const css = html.slice(start, end);
  assert.ok(css.includes("max-height"), "панель без ограничения высоты");
  assert.ok(css.includes("overflow-y: auto"), "список не скроллится");
  const box = read("src/ui/ShareInbox.ts");
  assert.ok(box.includes("shareInboxCount"), "нет счётчика входящих");
  assert.ok(box.includes("items.length"), "счётчик не обновляется");
});

test("T11: получатель без активного хранилища в список не попадает", () => {
  const withVault = { user_ref: "1", display_name: "Иван", vault_active: true };
  const withoutVault = { user_ref: "2", display_name: "Иван Без Права", vault_active: false };
  const legacy = { user_ref: "3", display_name: "Старый Сервер" };

  const all = filterDirectory([withVault, withoutVault, legacy], "");
  assert.deepEqual(
    all.map((i) => i.user_ref),
    ["1", "3"],
    "vault_active=false обязан быть скрыт, отсутствие поля — совместимость",
  );
  assert.deepEqual(
    filterDirectory([withVault, withoutVault], "иван").map((i) => i.user_ref),
    ["1"],
    "поиск не должен «воскрешать» мастера без хранилища",
  );
});

test("T12: инициалы для аватара-кружка", () => {
  assert.equal(directoryInitials("Иван Петров"), "ИП");
  assert.equal(directoryInitials("  мастер  "), "М");
  assert.equal(directoryInitials("Пётр"), "П");
  assert.equal(directoryInitials(""), "?");
  assert.equal(directoryInitials(null), "?");
});

test("T13: диалог собран на классах темы, без инлайн-стилей", () => {
  const html = read("index.html");
  for (const cls of [
    ".vault-share-overlay",
    ".vault-share-dialog",
    ".vault-share-user",
    ".vault-share-avatar",
    ".vault-share-badge",
    ".vault-share-state",
  ]) {
    assert.ok(html.includes(cls), `index.html: нет стиля ${cls}`);
  }

  const dialogCss = html.slice(
    html.indexOf(".vault-share-dialog {"),
    html.indexOf(".vault-share-state {"),
  );
  for (const token of [
    "var(--glass)",
    "var(--glass-border)",
    "var(--r-card)",
    "var(--shadow-card)",
    "var(--blur-card)",
    "var(--accent-rgb)",
    "var(--surface2)",
  ]) {
    assert.ok(dialogCss.includes(token), `диалог не использует токен ${token}`);
  }

  // Панель входящих больше не ссылается на несуществующие --border/--bg-secondary.
  const inboxCss = html.slice(
    html.indexOf(".share-inbox {"),
    html.indexOf(".vault-share-overlay {"),
  );
  assert.ok(inboxCss.length > 0, "не найден блок .share-inbox");
  assert.ok(!inboxCss.includes("var(--border)"), ".share-inbox: мёртвый токен --border");
  assert.ok(
    !inboxCss.includes("var(--bg-secondary)"),
    ".share-inbox: мёртвый токен --bg-secondary",
  );
  assert.ok(inboxCss.includes("var(--glass)"), ".share-inbox: нужен токен темы");

  const src = read("src/ui/SearchPage.ts");
  const start = src.indexOf("private async _openShareDialog");
  const end = src.indexOf("private renderVaultCard", start);
  assert.ok(start > 0 && end > start, "не найден _openShareDialog");
  const dialog = src.slice(start, end);
  assert.ok(!dialog.includes('style="'), "диалог: инлайн-стили запрещены");
  assert.ok(!dialog.includes("style.cssText"), "диалог: style.cssText запрещён");
  assert.ok(dialog.includes('e.key === "Escape"'), "нет закрытия по Escape");
  assert.ok(dialog.includes("inputEl.focus()"), "нет фокуса на поле поиска");
  assert.ok(dialog.includes("prevFocus?.focus?.()"), "фокус не возвращается после закрытия");
  assert.ok(dialog.includes("if (sending) return;"), "нет защиты от двойной отправки");
  assert.ok(dialog.includes('t("vault.share_loading")'), "нет состояния загрузки");
  assert.ok(dialog.includes('t("vault.share_no_vault_users")'), "нет пустого состояния");
  assert.ok(dialog.includes('t("vault.share_load_failed")'), "нет состояния ошибки");
  assert.ok(
    dialog.includes('t("vault.share_only_with_vault")'),
    "нет пояснения про активное хранилище",
  );
  assert.ok(
    dialog.includes("directoryInitials("),
    "нет аватара-инициалов у строки получателя",
  );
});

test("T14: контракт справочника знает vault_active во всех трёх языках и API", () => {
  const api = read("src/api.ts");
  assert.ok(
    /interface VaultDirectoryItem[\s\S]*?vault_active\?: boolean;/.test(api),
    "VaultDirectoryItem: нет поля vault_active",
  );
  for (const locale of ["uk.ts", "ru.ts", "en.ts"]) {
    const src = read(`src/i18n/locales/${locale}`);
    for (const key of [
      "share_loading",
      "share_only_with_vault",
      "share_no_vault_users",
      "share_vault_active",
    ]) {
      assert.ok(src.includes(`${key}:`), `${locale}: нет ключа ${key}`);
    }
  }
});
