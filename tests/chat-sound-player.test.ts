/**
 * Плеер звуков уведомлений чатов (D-144) — гейт «проба слышна с первого клика».
 *
 * РЕАЛЬНЫЙ ДЕФЕКТ (репорт владельца 2026-10-31: «как-то через раз и неправильно
 * работает прослушать»): `SettingsPage.pickSound` сначала запускал пробу, а сразу
 * за этим сохранял настройки → `onSaved` → `_applyChatSound` звал
 * `HTMLAudioElement.load()`. По спеке `load()` ПРЕРЫВАЕТ текущее воспроизведение
 * того же элемента, поэтому проба обрывалась через несколько миллисекунд (пока
 * идёт IPC-раундтрип сохранения) либо не успевала начаться вовсе. Повторный клик
 * по уже выбранному звуку звучал нормально — `pickSound` там выходит раньше
 * сохранения. Классические «через раз».
 *
 * DOM в `node:test` нет, поэтому `Audio` приходит фабрикой, а проверяется
 * ПОВЕДЕНИЕ плеера, а не текст исходников:
 *
 *   P1 повторный клик по тому же звуку звучит снова (не «одноразовый» элемент);
 *   P2 `apply()` (смена сохранённого звука) НЕ обрывает играющую пробу;
 *   P3 `apply()` прогревает новый звук, но не глушит чужое воспроизведение;
 *   P4 быстрый перебор звуков не звучит хором (предыдущий глушится);
 *   P5 `stopAll()` (выход из аккаунта) глушит всё, включая пробу;
 *   P6 отказ autoplay (`play()` reject) не бросает наружу и не ломает следующий клик;
 *   P7 неизвестный id играет дефолтный звук, а не тишину;
 *   P8 гейт по исходникам: в звуковом пути нет `load()`, модуль подключён к тестам.
 *
 * Ранер без внешних зависимостей: встроенный node:test (Node ≥ 18).
 * Запуск: npm run test:ui
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { ChatSoundPlayer, type ChatAudioLike, type ChatAudioFactory } from "../src/ui/ChatSoundPlayer";
import type { ChatSoundId } from "../shared/chatSettings";

/** Корень проекта (там `index.html`, `src/`, `tests/`) — независимо от outDir. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `корень проекта не найден (старт: ${__dirname})`);
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Только код, без комментариев: `load()` упоминается в пояснениях как ЗАПРЕЩЁННЫЙ вызов. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Фейковый media-элемент: считает вызовы и, как настоящий, гасит воспроизведение
 * на `pause()`/`load()`. `load()` в фейке — чтобы поймать рецидив дефекта.
 */
class FakeAudio implements ChatAudioLike {
  preload = "";
  currentTime = 0;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;

  constructor(
    readonly id: ChatSoundId,
    private readonly failPlay = false,
  ) {}

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.failPlay) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  /** Существует только в фейке: настоящий `load()` обрывает воспроизведение. */
  load(): this {
    this.loadCalls += 1;
    this.paused = true;
    this.currentTime = 0;
    return this;
  }
}

function harness(failing: ReadonlyArray<ChatSoundId> = []) {
  const made: FakeAudio[] = [];
  const create: ChatAudioFactory = (id) => {
    const audio = new FakeAudio(id, failing.includes(id));
    made.push(audio);
    return audio;
  };
  const player = new ChatSoundPlayer(create);
  const find = (id: ChatSoundId): FakeAudio => {
    const audio = made.find((a) => a.id === id);
    assert.ok(audio, `элемент звука «${id}» не создан`);
    return audio;
  };
  return { player, made, find };
}

test("P1: повторный клик по тому же звуку звучит снова (элемент перематывается, а не глохнет)", () => {
  const { player, made, find } = harness();
  player.play("ping");
  find("ping").currentTime = 0.35;

  player.play("ping");

  const ping = find("ping");
  assert.equal(made.length, 1, "на один id должен быть один media-элемент (иначе утечка и гонка)");
  assert.equal(ping.playCalls, 2, "второй клик обязан снова вызвать play()");
  assert.equal(ping.currentTime, 0, "повторное прослушивание начинается с начала");
});

test("P2: смена сохранённого звука НЕ обрывает играющую пробу (регресс «через раз»)", () => {
  const { player, find } = harness();
  player.play("chime");
  assert.equal(find("chime").paused, false, "проба должна играть");

  // Ровно то, что делает SettingsPage после сохранения: onSaved → apply(sound_id).
  player.apply("chime");

  const chime = find("chime");
  assert.equal(chime.paused, false, "apply() не имеет права останавливать воспроизведение — проба обрывалась");
  assert.equal(
    chime.loadCalls,
    0,
    "load() прерывает воспроизведение (спека HTMLMediaElement) — в плеере его быть не должно",
  );
  assert.equal(chime.pauseCalls, 0, "apply() не глушит звук");
});

test("P3: apply() прогревает новый звук, но не трогает текущее воспроизведение", () => {
  const { player, made, find } = harness();
  player.play("drop");

  player.apply("knock");

  assert.ok(
    made.some((a) => a.id === "knock"),
    "apply() обязан прогревать выбранный звук (первый сигнал не должен ждать загрузки файла)",
  );
  assert.equal(find("knock").playCalls, 0, "прогрев — это не проигрывание (иначе звук звучит сам по себе)");
  assert.equal(find("drop").paused, false, "прогрев другого звука не глушит текущий");
});

test("P4: быстрый перебор звуков не звучит хором — предыдущий глушится", () => {
  const { player, find } = harness();
  player.play("drop");
  player.play("ping");

  assert.equal(find("drop").paused, true, "старый звук обязан замолчать");
  assert.ok(find("drop").pauseCalls >= 1, "его надо именно поставить на паузу");
  assert.equal(find("drop").currentTime, 0, "и перемотать (следующий клик начнёт с начала)");
  assert.equal(find("ping").paused, false, "новый звук играет");
});

test("P5: stopAll() (выход из аккаунта) глушит всё, включая пробу", () => {
  const { player, made, find } = harness();
  player.play("alert");
  player.play("triple"); // alert уже на паузе, triple играет

  player.stopAll();

  for (const audio of made) {
    assert.equal(audio.paused, true, `звук «${audio.id}» остался играть после stopAll()`);
  }
  assert.equal(find("triple").currentTime, 0, "после стопа позиция сброшена");
});

test("P6: отказ autoplay (play() reject) не бросает наружу и не ломает следующий клик", () => {
  const { player, find } = harness(["triple"]);

  assert.doesNotThrow(() => player.play("triple"), "необработанный reject уронил бы обработчик клика");
  assert.equal(find("triple").playCalls, 1);

  // Клик по другому звуку после отказа должен работать как обычно.
  player.play("ping");
  assert.equal(find("ping").paused, false, "после отказа autoplay остальные звуки обязаны играть");

  // И повторный клик по «упёршемуся» звуку тоже доходит до play().
  player.play("triple");
  assert.equal(find("triple").playCalls, 2, "отказ не должен «залипать» на элементе");
});

test("P7: неизвестный id играет дефолтный звук, а не тишину", () => {
  const { player, made, find } = harness();

  player.play("space-laser");

  assert.deepEqual(
    made.map((a) => a.id),
    ["drop"],
    "битый id обязан нормализоваться в дефолт, а не создавать элемент с мусорным url",
  );
  assert.equal(find("drop").paused, false, "сигнал обязан звучать даже при битой настройке");
  assert.equal(player.id, "drop", "сохранённый id остаётся валидным");
});

test("P8: гейт по исходникам — в звуковом пути нет load(), модуль подключён к тестам", () => {
  const playerSrc = codeOnly(read(path.join("src", "ui", "ChatSoundPlayer.ts")));
  assert.ok(
    !/\.load\s*\(/.test(playerSrc),
    "ChatSoundPlayer не должен звать load(): он прерывает воспроизведение и возвращает дефект «проба через раз»",
  );
  assert.ok(
    read(path.join("src", "ui", "ChatSoundPlayer.ts")).includes("normalizeChatSoundId"),
    "битый сохранённый id обязан нормализоваться в плеере (иначе элемент с мусорным url)",
  );

  const app = codeOnly(read(path.join("src", "ui", "App.ts")));
  assert.ok(app.includes("ChatSoundPlayer"), "App обязан использовать плеер (единая точка воспроизведения)");
  assert.ok(
    !/_applyChatSound\([^)]*\)\s*\{[^}]*\.load\(/.test(app),
    "App не должен обрывать звук через load() в _applyChatSound",
  );

  const tsconfig = read("tsconfig.tests.json");
  assert.ok(
    tsconfig.includes("src/ui/ChatSoundPlayer.ts"),
    "ChatSoundPlayer не подключён к tsconfig.tests.json — тесты P1–P7 были бы невидимы для test:ui",
  );
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.ok(
    pkg.scripts["test:ui"].includes("chat-sound-player.test.js"),
    "тест плеера не зарегистрирован в npm run test:ui — гейт не запускается",
  );
});
