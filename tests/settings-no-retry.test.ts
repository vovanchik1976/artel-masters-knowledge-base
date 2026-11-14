/**
 * Гейт «в Настройках нет кнопки-обманки» (решение владельца 2026-10-31, вариант C).
 *
 * ПРЕЖДЕ (RED): в `SettingsPage` была скрытая кнопка «Повторить» (`data-retry`),
 * которая при ошибке СОХРАНЕНИЯ вызывала `load()` — то есть ПЕРЕЧИТЫВАЛА старые
 * значения: галочка молча откатывалась, статус гас, и мастер думал, что
 * настройка сохранена (а она не сохранена). Плюс текст ошибки обещал
 * «Повторите попытку» / «Спробуйте ще раз» / «Please try again» — обещание,
 * которое кнопка выполняла неверно.
 * ПОСЛЕ: кнопки нет вообще; остаётся честная строка состояния об ошибке,
 * а повтор — это естественное повторное переключение самого переключателя
 * (обычный `save()`), без скрытой «полу-рабочей» кнопки.
 *
 * Гейт по ИСХОДНИКАМ (DOM в node:test нет): читаем `src/ui/SettingsPage.ts`
 * и словари локалей ru/uk/en.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function settingsPageSource(): string {
  return fs.readFileSync(path.join(projectRoot(), "src", "ui", "SettingsPage.ts"), "utf8");
}

/** Блок `settings: { ... }` словаря (по отступу в два пробела). */
function settingsBlock(lang: "ru" | "uk" | "en"): string {
  const src = fs.readFileSync(path.join(projectRoot(), "src", "i18n", "locales", `${lang}.ts`), "utf8");
  const from = src.indexOf("\n  settings: {");
  assert.ok(from >= 0, `${lang}.ts: не нашли блок settings`);
  const to = src.indexOf("\n  },", from + 1);
  assert.ok(to > from, `${lang}.ts: блок settings не закрыт`);
  return src.slice(from, to);
}

test("R1: страница Настроек не создаёт кнопку повтора (нет data-retry / settings.retry)", () => {
  const src = settingsPageSource();
  assert.ok(
    !src.includes("data-retry"),
    "в SettingsPage остался <button data-retry> — кнопка-обманка (при ошибке сохранения перечитывала старые значения)",
  );
  assert.ok(
    !src.includes("settings.retry"),
    "в SettingsPage остался ключ settings.retry — кнопка повтора должна быть удалена целиком",
  );
  assert.ok(
    !/\bthis\.retry\b/.test(src),
    "в SettingsPage осталось поле this.retry — обработчик повтора не должен существовать",
  );
});

test("R2: ошибка настроек всё равно доходит до пользователя (убрали кнопку, а не сигнал)", () => {
  const src = settingsPageSource();
  assert.ok(
    src.includes("t('settings.error')"),
    "applyLang обязан показывать t('settings.error') при this.failed — иначе ошибка станет невидимой",
  );
  assert.equal(
    (src.match(/this\.failed=true/g) ?? []).length,
    2,
    "флаг ошибки ставится и при чтении (load), и при записи (save) — оба пути обязаны сообщать о сбое",
  );
});

test("R3: в словарях ru/uk/en нет ключа settings.retry, а текст ошибки не обещает повтора", () => {
  for (const lang of ["ru", "uk", "en"] as const) {
    const block = settingsBlock(lang);
    assert.ok(!/\n\s+retry\s*:/.test(block), `${lang}.ts: ключ settings.retry стал мёртвым — удалить`);
    const errorLine = block.match(/\n\s+error\s*:\s*"([^"]*)"/);
    assert.ok(errorLine, `${lang}.ts: в settings нет ключа error`);
    const text = errorLine![1].toLowerCase();
    for (const forbidden of ["повторите", "спробуйте", "try again"]) {
      assert.ok(
        !text.includes(forbidden),
        `${lang}.ts: текст ошибки обещает повтор («${forbidden}») — кнопки повтора больше нет, обещание ложное`,
      );
    }
    assert.ok(
      text.includes("сохран") || text.includes("збер") || text.includes("save"),
      `${lang}.ts: текст ошибки обязан говорить о сохранении/загрузке настроек`,
    );
  }
});
