/**
 * Гейт согласованности карточки прошивки (D-167).
 *
 * ПРАВИЛО: model не может повторять brand — в любом регистре и с лишними
 * пробелами. Модель — обозначение аппарата, бренд — производитель; повтор =
 * неправильно заполненные поля, загрузка блокируется с явным предупреждением.
 * Шасси НЕ сравнивается (поправка владельца): совпадение model/chassis бывает
 * легитимным.
 *
 * Гейт по ИСХОДНИКАМ (DOM в node:test нет): UploadPage.ts + серверный init.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "tests"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, "не нашли корень desktop-electron (package.json + tests/)");
    dir = parent;
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

test("C1: клиент блокирует firmware-загрузку при model == brand", () => {
  const page = read("src/ui/UploadPage.ts");
  // Проверка стоит в предзагрузочной валидации: после required-полей и
  // ДО тяжёлых операций (TDLib runtime check) — fail-fast без лишней работы.
  const requiredAt = page.indexOf('"❌ Fill in the required fields: brand, model"');
  const guardAt = page.indexOf("model must differ from brand");
  assert.ok(requiredAt !== -1, "нет блока required-полей (точка отсчёта)");
  assert.ok(guardAt > requiredAt, "проверка model≠brand должна стоять после required-полей");
  const runtimeAt = page.indexOf('invoke<{ ready: boolean }>("tdlib_runtime_status")');
  assert.ok(runtimeAt > guardAt, "проверка model≠brand должна срабатывать ДО TDLib runtime check");

  // Гейт только для firmware-карточки (software/documentation не трогаем) и
  // только при заполненных обоих полях.
  assert.match(
    page,
    /contentKind === "firmware" && brand && model/,
    "проверка обязана применяться только к kind=firmware",
  );

  // Сравнение без учёта регистра (toLowerCase) и схлопывание пробелов.
  assert.match(page, /replace\(\/\\s\+\/g, " "\)/, "лишние пробелы схлопываются");
  assert.match(page, /toLowerCase\(\)/, "сравнение обязано игнорировать регистр");

  // При конфликте — явное предупреждение об ошибке и обрыв (upload не идёт).
  const conflictBlock = page.slice(guardAt, runtimeAt);
  assert.match(conflictBlock, /"error"/, "предупреждение о неправильно заполненных полях — ошибкой");
  assert.match(conflictBlock, /return;/, "загрузка обязана прерваться (return)");
  assert.match(conflictBlock, /startUploadBtn\.disabled = false;/, "кнопки возвращаются в рабочее состояние");
});

test("C2: сервер отклоняет init с model == brand для firmware", () => {
  const api = read("../bot/presentation/web/desktop_uploads_api.py");
  // Импорт чистой функции + гейт в init только для firmware.
  assert.match(
    api,
    /from bot\.utils\.card_rules import brand_model_conflict/,
    "серверный init обязан использовать общее правило из bot/utils/card_rules.py",
  );
  assert.match(
    api,
    /content_kind == "firmware" and brand_model_conflict\(brand, model\)/,
    "серверный гейт только для kind=firmware",
  );
  assert.match(api, /CARD_FIELDS_CONFLICT/, "отказ обязан нести машинный код");
  assert.match(api, /status=400/, "отказ — 400 (fail-fast до создания job/темы)");

  // Чистая функция: сравнение без учёта регистра; шасси в правиле НЕТ.
  const helper = read("../bot/utils/card_rules.py");
  assert.match(helper, /casefold\(\)/, "сравнение регистронезависимое");
  assert.ok(
    !/def brand_model_conflict\([^)]*chassis/.test(helper),
    "шасси НЕ сравнивается (поправка владельца D-167)",
  );
});
