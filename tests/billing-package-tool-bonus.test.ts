/**
 * Гейт «GEO_Unlock — бонус пакета магазину» (D-151).
 *
 * ПРЕЖДЕ: утиліта відкривалася лише серверним grant'ом, а картка пакета в
 * магазині показувала тільки «особисте сховище» — майстер, купуючи пакет, не
 * знав, що той самий пакет відкриває ще й вкладку «Інструменти».
 * ПОСЛЯ: пакет показує ОБИДВА бонуси (сховище + утиліта), і кількість
 * розблокувань утиліти береться зі своєї колонки `geo_unlock_count`,
 * незалежно від сховища.
 *
 * Гейт по ІСХОДНИКАХ (DOM у node:test немає): billing_api.py +
 * vault_entitlement.py + BillingPage.ts + api.ts + локалі + index.html +
 * admin.html.
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

/** Значение строкового ключа словаря локали (`<key>: "…"`), без кавычек. */
function keyText(dict: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*\"((?:[^\"\\\\\\\\]|\\\\\\\\.)*)\"`, "m").exec(dict);
  assert.ok(m, `нет ключа ${key} в словаре локали`);
  return m[1];
}

/** Тело CSS-правила по селектору (с учётом вложенности) — DOM в node:test нет. */
function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `в index.html нет правила ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`правило ${selector} не закрыто — CSS сломан`);
}

test("B1: сервер рахує розблокування бонуса в ОДНОМУ місці (Vault і GEO_Unlock не розʼїдуться)", () => {
  const ent = readRepo("bot/application/vault/vault_entitlement.py");
  assert.match(
    ent,
    /^def package_entitlement_days\(/m,
    "нужна функция package_entitlement_days(package) — единая точка правды про дни бонуса",
  );
  assert.match(
    ent,
    /^def package_geo_unlock_count\(/m,
    "нужна функция package_geo_unlock_count(package) — отдельная точка правды про разблокировки утилит",
  );

  const useCaseFrom = ent.indexOf("class ApplyPackageVaultBonusUseCase");
  assert.ok(useCaseFrom !== -1, "не нашли ApplyPackageVaultBonusUseCase");
  const useCase = ent.slice(useCaseFrom);
  assert.match(
    useCase,
    /package_entitlement_days\(package\)/,
    "выдача права на хранилище обязана звать package_entitlement_days",
  );
  assert.match(
    useCase,
    /package_geo_unlock_count\(package\)/,
    "выдача права на утилиту обязана звать package_geo_unlock_count",
  );
  assert.doesNotMatch(
    useCase,
    /package\.(grants_vault_bonus_days|vault_days|geo_unlock_count) or 0/,
    "дни/разблокировки не считаются ВТОРЫМ разу — иначе сроки и счётчики разойдутся",
  );
});

test("B2: /api/v1/billing/packages отдає geo_unlock_count — своє, незалежне від сховища", () => {
  const api = readRepo("bot/presentation/web/billing_api.py");
  assert.match(
    api,
    /from bot\.application\.vault\.vault_entitlement import package_geo_unlock_count/,
    "billing_api повинен імпортувати єдиний розрахунок розблокувань",
  );
  assert.match(
    api,
    /"geo_unlock_count":\s*pkg\.geo_unlock_count/,
    "в видачі пакетів є geo_unlock_count — клієнт покаже кількість розблокувань",
  );
});

test("B3: клієнтський тип пакета знає geo_unlock_count", () => {
  const apiTs = readClient("src/api.ts");
  const from = apiTs.indexOf("export interface BillingPackage");
  assert.ok(from !== -1, "не нашли BillingPackage в api.ts");
  const block = apiTs.slice(from, from + 2000);
  assert.match(block, /geo_unlock_count\?: number/, "в BillingPackage є geo_unlock_count");
});

test("B4: картка магазина малює бонус утиліти, а без розблокувань — не малює", () => {
  const page = readClient("src/ui/BillingPage.ts");

  const bonusFrom = page.indexOf("private _toolBonus");
  assert.ok(bonusFrom !== -1, "нет _toolBonus — карта не покаже бонус");
  const bonus = page.slice(bonusFrom, bonusFrom + 900);

  assert.match(
    bonus,
    /pkg\.geo_unlock_count \?\? 0/,
    "кількість розблокувань візьмється ТІЛЬКИ з сервера (`geo_unlock_count`)",
  );
  assert.doesNotMatch(
    bonus,
    /grants_vault_bonus_days|vault_days/,
    "клієнт не має права рахувати розблокування утиліти другий раз (правило тарифа живе на сервері)",
  );
  assert.match(bonus, /count > 0/, "бонус показується лише при наявності розблокувань");

  assert.match(
    page,
    /class="billing-card-tool"/,
    "в картці немає рядка бонуса утиліти (клас billing-card-tool)",
  );
  assert.match(page, /\$\{toolLine\}/, "рядок бонуса утиліти не вставлено в розмітку картки");
  assert.match(page, /toolModalLine/, "в модальному вікні підтвердження немає рядка про утиліту");
});

test("B4b: довгого опису утиліти на картці немає (рішення володаря 2026-11-01)", () => {
  const page = readClient("src/ui/BillingPage.ts");
  assert.doesNotMatch(
    page,
    /_toolNote|geo_unlock_note|billing-card-tool-note/,
    "на картці/в модальному вікні знову довгий опис утиліти — володар просив його прибрати",
  );
  assert.doesNotMatch(
    readClient("index.html"),
    /\.billing-card-tool-note\s*\{/,
    "стиль .billing-card-tool-note залишився без розмітки (мертве правило)",
  );
});

test("B5: три локалі називають кількість розблокувань; прибраного опису в словниках немає", () => {
  const sameTerm: Record<string, RegExp> = {
    uk: /розблокувань/i,
    ru: /разблокировок/i,
    en: /unlocks/i,
  };
  for (const lang of ["uk", "ru", "en"] as const) {
    const dict = readClient(`src/i18n/locales/${lang}.ts`);
    const bonus = keyText(dict, "geo_unlock_bonus");
    assert.match(bonus, /\{days\}/, `${lang}: бонус повинен називати кількість розблокувань`);
    assert.match(bonus, sameTerm[lang], `${lang}: бонус повинен говорити про розблокування`);
    assert.match(bonus, /GEO_Unlock/i, `${lang}: бонус повинен називати утиліту`);
    assert.doesNotMatch(
      dict,
      /^\s*geo_unlock_note\s*:/m,
      `${lang}: ключ geo_unlock_note повернувся — прибраний довгий опис не можна повертати`,
    );
  }
});

test("B6: бейдж утиліти бере колір і форму з ТЕМИ, а не зі «сткла ARTEL»", () => {
  const rule = cssRule(readClient("index.html"), ".billing-card-tool");
  assert.match(
    rule,
    /color:\s*var\(--accent\)/,
    "колір тексту бейджу зашитий — на темах «Майстерня»/«Пульт» він залишиться чужим",
  );
  assert.match(
    rule,
    /rgba\(var\(--accent-rgb\)/,
    "фон/рамка бейджу повинні йти через --accent-rgb (акцент обраної теми)",
  );
  assert.match(
    rule,
    /border-radius:\s*var\(--r-badge/,
    "радиус бейджу повинен йти через --r-badge (у HUD він нульовий, у «Майстерні» — свій)",
  );
  assert.doesNotMatch(
    rule,
    /#7dd3fc|rgba\(\s*56\s*,\s*189\s*,\s*248/i,
    "залився зашитий синій колір ARTEL — тема його не перефарбує",
  );
});

test("B7: адмінка бачить бонус утиліти поруч з бонусом сховища", () => {
  const admin = readRepo("bot/webapp/templates/admin.html");
  const start = admin.indexOf("function renderPackages(");
  assert.ok(start !== -1, "не знайдено renderPackages в admin.html");
  const nextFn = admin.indexOf("\n  function ", start + 1);
  const block = admin.slice(start, nextFn > start ? nextFn : start + 4000);
  assert.match(block, /GEO_Unlock/, "в таблиці пакетів адмінки немає бонусу утиліти");
  assert.match(block, /toolBadge/, "бонус утиліти має бути окремим бейджем");
});
