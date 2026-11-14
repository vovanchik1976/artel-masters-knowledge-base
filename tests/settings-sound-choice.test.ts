/**
 * Гейт «выбор озвучки уведомлений» (поручение владельца 2026-10-31: «добавляем
 * выбор озвучки и накидай стандартных звуков»).
 *
 * ПОЧЕМУ ГЕЙТ ПО ИСХОДНИКАМ: DOM в `node:test` нет, а цена ошибки — тишина или
 * «выбрал звук, а играет другой». Поэтому проверяются 4 вещи, каждая из которых
 * уже ломалась в подобных местах:
 *   1. страница строит выбор из ЕДИНОГО списка `CHAT_SOUND_IDS` (а не хардкодом) —
 *      иначе новый звук есть в настройках, но не играет (или наоборот);
 *   2. у каждого id есть ФАЙЛ в `public/audio` (иначе выбор «есть», а звука нет);
 *   3. подписи звуков есть во всех трёх языках (пустая кнопка = непонятный выбор);
 *   4. выбор применяется БЕЗ перезапуска (App читает сохранённый `sound_id`) и
 *      сохраняется САМ, без кнопки «Сохранить» (решение владельца 2026-10-31:
 *      авто-сохранение честнее кнопки-черновика).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHAT_SOUND_IDS } from "../shared/chatSettings";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Блок `settings: { ... }` словаря (по отступу в два пробела). */
function settingsBlock(lang: "ru" | "uk" | "en"): string {
  const src = read(path.join("src", "i18n", "locales", `${lang}.ts`));
  const from = src.indexOf("\n  settings: {");
  assert.ok(from >= 0, `${lang}.ts: не нашли блок settings`);
  const to = src.indexOf("\n  },", from + 1);
  assert.ok(to > from, `${lang}.ts: блок settings не закрыт`);
  return src.slice(from, to);
}

/** id звука → файл. Список НАМЕРЕННО продублирован: гейт должен падать, если id добавили, а файл забыли. */
const SOUND_FILES: Readonly<Record<string, string>> = {
  drop: "water-drop.wav",
  chime: "chime.wav",
  ping: "ping.wav",
  knock: "knock.wav",
  triple: "triple.wav",
  alert: "alert.wav",
};

test("S1: Настройки строят выбор звука из единого списка CHAT_SOUND_IDS и сохраняют его без кнопки", () => {
  const src = read(path.join("src", "ui", "SettingsPage.ts"));
  assert.ok(src.includes("CHAT_SOUND_IDS"), "SettingsPage обязан брать список звуков из shared/chatSettings (не хардкодить)");
  assert.ok(src.includes("data-sound-id"), "в разметке нет кнопок выбора звука (data-sound-id)");
  assert.ok(src.includes('role="radiogroup"'), "выбор звука обязан быть радиогруппой (доступность/клавиатура)");
  assert.ok(!/data-sound-save|settings\.save["']/.test(src), "кнопки «Сохранить» у выбора звука быть не должно — выбор авто-сохраняется");
  assert.ok(/this\.deps\.save\(/.test(src), "выбор звука обязан идти через тот же save(), что и галочки (одна точка записи)");
  assert.ok(/this\.deps\.preview\(/.test(src), "клик по звуку обязан давать пробу (preview) — иначе выбор делается вслепую");
});


test("S2: у каждого звука есть подпись во всех трёх языках, и общий текст больше не называет один конкретный звук", () => {
  assert.deepEqual(
    Object.keys(SOUND_FILES).sort(),
    [...CHAT_SOUND_IDS].sort(),
    "набор id в тесте разошёлся с CHAT_SOUND_IDS — обнови SOUND_FILES и локали",
  );
  for (const lang of ["ru", "uk", "en"] as const) {
    const block = settingsBlock(lang);
    assert.ok(/\n\s+sound_choice\s*:/.test(block), `${lang}.ts: нет подписи группы «Звук уведомления»`);
    for (const id of CHAT_SOUND_IDS) {
      assert.ok(new RegExp(`\\n\\s+sound_${id}\\s*:`).test(block), `${lang}.ts: нет подписи звука sound_${id}`);
    }
    const general = block.match(/\n\s+sound\s*:\s*"([^"]*)"/);
    assert.ok(general, `${lang}.ts: нет ключа settings.sound`);
    for (const wrong of ["капл", "крапл", "water drop"]) {
      assert.ok(
        !general![1].toLowerCase().includes(wrong),
        `${lang}.ts: settings.sound всё ещё называет один конкретный звук («${general![1]}») — теперь звук выбирается ниже`,
      );
    }
  }
});

test("S3: каждому id соответствует реальный WAV-файл, и маппинг покрывает набор целиком", () => {
  const urls = read(path.join("src", "ui", "chatSoundUrls.ts"));
  assert.ok(
    /Record<\s*ChatSoundId\s*,\s*string\s*>/.test(urls),
    "chatSoundUrls обязан объявить Record<ChatSoundId,string> — тогда новый id без файла ломает сборку, а не тишину",
  );
  for (const [id, file] of Object.entries(SOUND_FILES)) {
    assert.ok(urls.includes(`public/audio/${file}?url`), `chatSoundUrls: нет импорта файла ${file} (звук «${id}» будет молчать)`);
    const full = path.join(projectRoot(), "public", "audio", file);
    assert.ok(fs.existsSync(full), `нет файла public/audio/${file}`);
    const size = fs.statSync(full).size;
    assert.ok(size > 2000, `public/audio/${file}: ${size} байт — подозрительно мало, файл битый/пустой`);
  }
});

test("S4: выбор применяется без перезапуска — App берёт sound_id из сохранённых настроек", () => {
  const app = read(path.join("src", "ui", "App.ts"));
  const player = read(path.join("src", "ui", "ChatSoundPlayer.ts"));
  /** Только код: `load()` упоминается в комментариях как ЗАПРЕЩЁННЫЙ вызов. */
  const playerCode = player.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(app.includes("chatSoundUrl("), "App обязан резолвить url звука по id (а не один файл на всё)");
  assert.ok(app.includes("ChatSoundPlayer"), "App обязан отдавать воспроизведение плееру (единая точка, см. P1–P7)");
  assert.ok(app.includes("value.sound_id"), "App обязан применять сохранённый sound_id (иначе новый звук слышно только после перезапуска)");
  assert.ok(/preview\s*:/.test(app), "App обязан передать пробу звука в настройки");
  assert.ok(/onSaved\s*:/.test(app), "App обязан узнать о сохранении выбора (иначе звук не переключится сразу)");
  assert.ok(/pause\(\)/.test(playerCode), "stopAll обязан глушить проигрывание (выход из аккаунта не оставляет сирену)");
  assert.ok(!/\.load\(\)/.test(playerCode), "плеер не должен звать load() — он обрывает пробу (BUG-CHAT-SOUND-PREVIEW-001)");
  assert.ok(!/import waterDropUrl/.test(app), "старый единственный звук water-drop.wav больше не импортируется напрямую");
});

test("S6: клик по звуку не теряется во время сохранения — проба первая, записи через очередь", () => {
  const src = read(path.join("src", "ui", "SettingsPage.ts"));
  const from = src.indexOf("private async pickSound");
  assert.ok(from >= 0, "не нашли обработчик выбора звука");
  const pick = src.slice(from, src.indexOf("\n  }", from));
  assert.ok(
    !/busy/.test(pick),
    "pickSound не должен зависеть от busy: пока шла запись первого звука, второй клик молча терялся",
  );
  const previewAt = pick.indexOf("this.deps.preview(");
  const submitAt = pick.indexOf("this.submit(");
  assert.ok(previewAt >= 0, "клик обязан давать пробу");
  assert.ok(submitAt > previewAt, "проба локальная — она обязана играть ДО записи в файл");
  assert.ok(pick.includes("normalizeChatSoundId"), "битый id нормализуется до пробы и записи");

  assert.ok(src.includes("ChatSettingsWriter"), "запись настроек обязана идти через очередь (последнее намерение побеждает)");
  assert.ok(!/private async persist\(/.test(src), "старая параллельная запись persist() должна быть удалена");
});

test("S5: самопроверка — парсер блоков локалей не мёртвый", () => {
  const block = settingsBlock("ru");
  assert.ok(/\n\s+title\s*:/.test(block), "парсер settings-блока не видит ключ title — гейт S2 был бы фиктивным");
  assert.ok(block.includes("sound"), "в блоке settings нет ключей звука — парсер смотрит не туда");
});
