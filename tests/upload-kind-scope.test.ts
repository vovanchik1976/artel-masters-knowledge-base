/**
 * SP-35 / D-185: дискриминатор «Що ви завантажуєте?» залежить від режиму.
 *
 * RED (test-first): до фіксу `UploadPage` малював ВСІ опції зі схеми завжди, тому
 * «Довільний файл» (`any_file`, лише особисте сховище) можна було обрати в
 * публічному режимі — сервер відмовляв 400 `KIND_NOT_ALLOWED_IN_SCOPE`, тобто
 * мастер дізнавався про помилку вже після заповнення форми й пакування архіву.
 *
 * Контракт схеми (server-driven): кожна опція несе `scopes`
 * (`["public","personal"]` або `["personal"]`). Відсутність `scopes` = опція
 * доступна в обох режимах (легасі-схема/кеш).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  kindAllowedInScope,
  kindNeedsBrandModel,
  kindRequiresTitle,
  kindSupportsFolder,
  pickKindForScope,
  visibleKindOptions,
} from "../src/ui/uploadKinds";

/** Корень `desktop-electron` (от `outDir` тестов `tmp-tests/tests` вверх). */
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

function readLocale(loc: string): string {
  return fs.readFileSync(
    path.join(projectRoot(), "src", "i18n", "locales", `${loc}.ts`),
    "utf-8",
  );
}

const OPTIONS = [
  { value: "firmware", scopes: ["public", "personal"] },
  { value: "documentation", scopes: ["public", "personal"] },
  { value: "software", scopes: ["public", "personal"] },
  { value: "datasheet", scopes: ["public", "personal"] },
  { value: "any_file", scopes: ["personal"] },
];

test("kindAllowedInScope: any_file жив лише в особистому сховищі", () => {
  // public (personal=false) → заборонено; personal (personal=true) → дозволено
  assert.equal(kindAllowedInScope({ value: "any_file", scopes: ["personal"] }, false), false);
  assert.equal(kindAllowedInScope({ value: "any_file", scopes: ["personal"] }, true), true);
});

test("kindAllowedInScope: без scopes опція доступна в обох режимах (легасі)", () => {
  assert.equal(kindAllowedInScope({ value: "firmware" }, false), true);
  assert.equal(kindAllowedInScope({ value: "firmware" }, true), true);
});

test("kindAllowedInScope: порожній scopes не блокує (fail-open схеми)", () => {
  assert.equal(kindAllowedInScope({ value: "datasheet", scopes: [] }, true), true);
});

test("visibleKindOptions: у публічному режимі any_file прихований", () => {
  const values = visibleKindOptions(OPTIONS, false).map((o) => o.value);
  assert.deepEqual(values, ["firmware", "documentation", "software", "datasheet"]);
});

test("visibleKindOptions: в особистому режимі доступні всі п'ять", () => {
  const values = visibleKindOptions(OPTIONS, true).map((o) => o.value);
  assert.deepEqual(values, ["firmware", "documentation", "software", "datasheet", "any_file"]);
});

test("pickKindForScope: дозволений kind лишається", () => {
  assert.equal(pickKindForScope("datasheet", OPTIONS, true), "datasheet");
});

test("pickKindForScope: заборонений у режимі kind відкочується на firmware", () => {
  assert.equal(pickKindForScope("any_file", OPTIONS, false), "firmware");
  // В особистому режимі any_file легальний — не скидаємо
  assert.equal(pickKindForScope("any_file", OPTIONS, true), "any_file");
});

test("pickKindForScope: невідомий kind (кеш/легасі) → firmware", () => {
  assert.equal(pickKindForScope("chip_dump", OPTIONS, false), "firmware");
});

// ════════════ SP-36 / D-188: isp_emmc + repair_pictures ════════════

const SCHEMA_V8 = [
  { value: "firmware", scopes: ["public", "personal"] },
  { value: "documentation", scopes: ["public", "personal"] },
  { value: "software", scopes: ["public", "personal"] },
  { value: "datasheet", scopes: ["public", "personal"] },
  { value: "isp_emmc", scopes: ["public", "personal"] },
  { value: "repair_pictures", scopes: ["public", "personal"] },
  { value: "any_file", scopes: ["personal"] },
];

test("SP-36: нові kind публічні (scopes public+personal)", () => {
  const pub = visibleKindOptions(SCHEMA_V8, false).map((o) => o.value);
  assert.ok(pub.includes("isp_emmc"));
  assert.ok(pub.includes("repair_pictures"));
  assert.equal(pickKindForScope("isp_emmc", SCHEMA_V8, false), "isp_emmc");
  assert.equal(pickKindForScope("repair_pictures", SCHEMA_V8, true), "repair_pictures");
});

test("SP-36: brand/model НЕ потрібні для title-only kind (fiks UploadPage)", () => {
  for (const k of ["software", "datasheet", "any_file", "isp_emmc", "repair_pictures"]) {
    assert.equal(kindNeedsBrandModel(k), false, k);
  }
  // firmware/documentation — як і раніше вимагають бренд/модель.
  assert.equal(kindNeedsBrandModel("firmware"), true);
  assert.equal(kindNeedsBrandModel("documentation"), true);
});

test("SP-37/D-189: title обов'язковий тільки для software/datasheet", () => {
  for (const k of ["software", "datasheet"]) {
    assert.equal(kindRequiresTitle(k), true, k);
  }
  // SP-37/D-189: у isp_emmc/repair_pictures поля «Назва файлу» в формі НЕМАЄ —
  // назва карточки будується автоматично: шасі → модель → ім'я файлу.
  for (const k of ["isp_emmc", "repair_pictures", "any_file", "firmware", "documentation"]) {
    assert.equal(kindRequiresTitle(k), false, k);
  }
});

test("SP-37/D-189: папку/кілька файлів можна завантажити тільки як Прошивку", () => {
  assert.equal(kindSupportsFolder("firmware"), true);
  for (const k of ["documentation", "software", "datasheet", "isp_emmc", "repair_pictures", "any_file"]) {
    assert.equal(kindSupportsFolder(k), false, k);
  }
  assert.equal(kindSupportsFolder("unknown"), false);
  assert.equal(kindSupportsFolder(null), false);
});

test("SP-37/D-189: i18n — мертві ключі «Назва файлу» прибрані, є повідомлення папки", () => {
  for (const loc of ["uk", "ru", "en"]) {
    const src = readLocale(loc);
    // Поле «Назва файлу» більше не в формах нових kind — ключі підписів
    // мертві. NOTE: placeholder_isp_emmc/repair_pictures живуть ЛЕГАЛЬНО в
    // namespace описань (upload.field.description.placeholder.*) — ті не
    // чіпаємо, тому гейт тільки по label_*.
    for (const dead of [
      "label_isp_emmc:",
      "label_repair_pictures:",
    ]) {
      assert.ok(!src.includes(dead), `${loc}: мертвий ключ ${dead} має бути видалений`);
    }
    // Опції дискримінатора/пошуку живуть.
    for (const needle of [
      "isp_emmc: \"",
      "repair_pictures: \"",
    ]) {
      assert.ok(src.includes(needle), `${loc}: відсутній ключ ${needle}`);
    }
    // Гейт папки: повідомлення в усіх трьох локалях.
    assert.ok(
      src.includes("folder_firmware_only:"),
      `${loc}: відсутній ключ folder_firmware_only`,
    );
  }
});
