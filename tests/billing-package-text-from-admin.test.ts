/**
 * Гейт «админка — источник истины для карточки пакета» (BUG-ADMIN-PKG-TEXT-001).
 *
 * ПРЕЖДЕ: `BillingPage._pkgName/_pkgDesc` сначала смотрели локаль
 * (`billing.packages.<id>.name|description`) и только при её отсутствии брали
 * серверное значение. Для `package_starter/master/service/pro` ключи были
 * захардкожены в ru/uk/en с устаревшим текстом («25 баллов — стартовый пакет…»),
 * поэтому правки владельца в админке (points 0, новые названия/описания) в
 * карточке магазина не появлялись НИКОГДА — выглядело как «в админке сохранил,
 * а в клиенте ничего не изменилось».
 * ПОСЛЯ: карточка рисует ТОЛЬКО серверные name/description (данные не
 * переводятся, D-158/SP-20), захардкоженные блоки удалены из всех локалей.
 *
 * Гейт по ИСХОДНИКАМ (DOM в node:test нет): BillingPage.ts + локали +
 * admin.html + billing_api.py.
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

/** Файл клиента — путь относительно `desktop-electron/`. */
function readClient(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Файл бота — путь относительно корня репозитория (на уровень выше клиента). */
function readRepo(rel: string): string {
  return fs.readFileSync(path.join(path.dirname(projectRoot()), rel), "utf8");
}

const BILLING_PAGE = "src/ui/BillingPage.ts";
const LOCALES = ["uk", "ru", "en"] as const;
/** Известные id пакетов, для которых раньше был захардкожен текст в локалях. */
const KNOWN_PACKAGE_IDS = [
  "package_starter",
  "package_master",
  "package_service",
  "package_pro",
];

test("G1: карточка пакета не читает название/описание из локалей", () => {
  const src = readClient(BILLING_PAGE);
  assert.equal(
    src.includes("billing.packages.${"),
    false,
    "BillingPage.ts снова строит ключ `billing.packages.${…}` — админ-правки перестанут быть видны",
  );
  assert.equal(
    /hasKey\s*\(/.test(src),
    false,
    "BillingPage.ts не должен решать судьбу серверного текста через hasKey(): источник истины — админка",
  );
});

test("G2: _pkgName/_pkgDesc возвращают серверные поля как есть", () => {
  const src = readClient(BILLING_PAGE);
  const name = /private\s+_pkgName\s*\([^)]*\)\s*:\s*string\s*\{\s*return\s+pkg\.name;\s*\}/.exec(src);
  assert.ok(name, "_pkgName обязан возвращать pkg.name (серверное значение) без подмены локалями");
  const desc = /private\s+_pkgDesc\s*\([^)]*\)\s*:\s*string\s*\{\s*return\s+pkg\.description;\s*\}/.exec(src);
  assert.ok(desc, "_pkgDesc обязан возвращать pkg.description (серверное значение) без подмены локалями");
});

test("G3: захардкоженных названий/описаний пакетов нет ни в одной локали", () => {
  for (const lang of LOCALES) {
    const dict = readClient(`src/i18n/locales/${lang}.ts`);
    assert.equal(
      /^\s*packages:\s*\{/m.test(dict),
      false,
      `локаль ${lang}: блок packages удалён — названия/описания пакетов приходят из админки`,
    );
    for (const id of KNOWN_PACKAGE_IDS) {
      assert.equal(
        dict.includes(`${id}:`),
        false,
        `локаль ${lang}: остался захардкоженный текст пакета ${id}`,
      );
    }
  }
});

test("G4: сервер отдаёт магазину тексты из БД, а не из словаря", () => {
  const api = readRepo("bot/presentation/web/billing_api.py");
  assert.match(
    api,
    /"name":\s*pkg\.display_name\s+or\s+pkg\.name/,
    "billing_api.py обязан отдавать name из строки billing_packages (display_name или name)",
  );
  assert.match(
    api,
    /"description":\s*pkg\.description/,
    "billing_api.py обязан отдавать description из строки billing_packages",
  );
  for (const id of KNOWN_PACKAGE_IDS) {
    assert.equal(
      api.includes(id),
      false,
      `billing_api.py не должен знать про конкретный пакет ${id}`,
    );
  }
});

test("G5: в админке поле утилит подписано как КОЛИЧЕСТВО разблокировок (D-158), а не срок в днях", () => {
  const admin = readRepo("bot/webapp/templates/admin.html");
  assert.match(
    admin,
    /Количество разблокировок GEO_Unlock/,
    "поле geo_unlock_count должно называться «Количество разблокировок GEO_Unlock»",
  );
  assert.equal(
    admin.includes("Срок действия утилит (в днях)"),
    false,
    "подпись «Срок действия утилит (в днях)» противоречит D-158 (считаем разблокировки, не дни)",
  );
});
