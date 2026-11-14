/**
 * Гейт вкладки «Інструменти» (GEO Unlock, D-148/D-150).
 *
 * ПРЕЖДЕ: ядер GEO_Unlock жили в main, но в UI их не было — пользователь не мог
 * ни выбрать дамп, ни запустить патч; платный путь был недоступен вообще.
 * ПОСЛЕ: вкладка «Інструменти» с двумя карточками (Samsung eeprom / LG NVM),
 * своей иконкой инструмента и корректным порядком «grant → патч».
 *
 * Гейт по ИСХОДНИКАМ (DOM в node:test нет): index.html + public/ + ToolsPage.ts.
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

/** Значение строкового ключа словаря локали (`<key>: "…"`), без кавычек. */
function keyText(dict: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(dict);
  assert.ok(m, `нет ключа ${key} в словаре локали`);
  return m[1];
}

function toolsTabHtml(): string {
  const html = read("index.html");
  const from = html.indexOf('<div class="tab-content" id="tab-tools">');
  const to = html.indexOf('<!-- Owner-backdoor Tab');
  assert.ok(from !== -1 && to > from, "не нашли блок #tab-tools в index.html");
  return html.slice(from, to);
}

test("T1: вкладка «Інструменти» есть в панели и рисуется 3D-иконкой вкладки", () => {
  const html = read("index.html");
  const tabsFrom = html.indexOf('<div class="tabs">');
  const tabsTo = html.indexOf("<!-- Upload Tab -->");
  assert.ok(tabsFrom !== -1 && tabsTo > tabsFrom, "не нашли блок .tabs");
  const tabs = html.slice(tabsFrom, tabsTo);
  assert.match(tabs, /data-tab="tools"/, "нет кнопки вкладки tools");
  const img = /<img[^>]*src="\/tab-tools-3d\.png"[^>]*class="[^"]*tab-icon-3d/.exec(tabs);
  assert.ok(img, "вкладка tools должна рисоваться img/tab-tools-3d.png с классом tab-icon-3d");
  assert.match(tabs, /data-i18n="tabs\.tools"/, "подпись вкладки должна идти через i18n");
});

test("T2: контейнер вкладки на месте, у инструмента СВОЯ иконка из public/", () => {
  const block = toolsTabHtml();
  assert.match(block, /id="toolsContainer"/, "нет #toolsContainer (App его монтирует)");
  assert.match(
    block,
    /<img[^>]*src="\/geo-unlock-3d\.png"[^>]*>/,
    "иконка GEO Unlock должна быть public/geo-unlock-3d.png",
  );
  const icon = path.join(projectRoot(), "public", "geo-unlock-3d.png");
  const ok = fs.existsSync(icon) && fs.statSync(icon).size > 10_000;
  assert.ok(ok, "нет файла public/geo-unlock-3d.png (или он подозрительно мал)");
});

test("T3: обе карточки и все рабочие кнопки присутствуют", () => {
  const block = toolsTabHtml();
  for (const id of [
    "geoPickSamsungBtn",
    "geoCheckSamsungBtn",
    "geoPatchSamsungBtn",
    "geoRegionInput",
    "geoSamsungLog",
    "geoTierBadge",
    "geoPickLgBtn",
    "geoScanLgBtn",
    "geoPatchLgBtn",
    "geoLgValueInput",
    "geoLgLog",
  ]) {
    assert.ok(block.includes(`id="${id}"`), `нет элемента #${id}`);
  }
  // Галочка «Тільки перевірка» убрана осознанно (D-154): проверка — отдельная
  // кнопка «Перевірити дамп», а вторая галочка только сбивала мастера.
  assert.ok(
    !block.includes('id="geoLgDryRun"'),
    "чекбокс #geoLgDryRun не должен вернуться на экран (D-154)",
  );
});

test("T4: страница дергает ровно те IPC-команды, что есть в main", () => {
  const page = read("src/ui/ToolsPage.ts");
  for (const cmd of ["geo_samsung_scan", "geo_samsung_patch", "geo_lg_scan", "geo_lg_patch"]) {
    assert.ok(page.includes(`"${cmd}"`), `ToolsPage не вызывает ${cmd}`);
  }
  // Рендерер не трогает ФС: пути приходят из диалогов Tauri-полифилла.
  assert.ok(page.includes('from "@tauri-apps/plugin-dialog"'), "диалоги — только через plugin-dialog");
});

test("T5: grant спрашивается ТОЛЬКО для платного дампа и ДО патча", () => {
  const page = read("src/ui/ToolsPage.ts");
  const guard = page.indexOf("if (!checkOnly) {");
  const needs = page.indexOf("if (this.samsungNeedsGrant) {");
  const request = page.indexOf("this.requestGrant()");
  const patch = page.indexOf('invoke<SamsungPatchResult>("geo_samsung_patch"');
  assert.ok(guard !== -1, "нет ветки записи (checkOnly должен её обходить)");
  assert.ok(needs > guard, "grant должен спрашиваться только в ветке записи");
  assert.ok(request > needs, "requestGrant должен стоять под условием samsungNeedsGrant");
  assert.ok(patch > request, "патч запускается ПОСЛЕ получения grant'а");
  // Никакого «default allow»: needsGrant приходит из main, а не считается в UI.
  assert.ok(
    page.includes("samsungNeedsGrant = scan.needsGrant"),
    "рендерер обязан брать needsGrant из ответа скана (main — единственный источник)",
  );
});

test("T6: теория GPP1 удалена из кода инструмента (D-150)", () => {
  const files = [
    "electron/geo-unlock/service.ts",
    "electron/geo-unlock/index.ts",
    "electron/main.ts",
    "src/ui/ToolsPage.ts",
    "tests/geo-unlock-fixtures.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.ok(!/"gpp1"/.test(source), `${file}: в коде не должно остаться значения "gpp1"`);
    assert.ok(!source.includes("GPP1_UNSUPPORTED"), `${file}: нет отказа GPP1_UNSUPPORTED`);
    assert.ok(!source.includes("buildGpp1"), `${file}: нет фикстуры buildGpp1`);
  }
});

test("T8: карточка называет ОБА типа дампа (64 КіБ мікросхема / 2 МіБ розділ eMMC) и честно предупреждает про плоские копии", () => {
  // Решение владельца 2026-11-01: карточка обязана явно говорить, что инструмент
  // принимает и дамп микросхемы 24C512 (64 КіБ, бесплатно), и дамп раздела eMMC
  // (NVRAM-пул 2 МиБ, Tizen-10 / ТВ 2026 р., платно — только с пакетом из магазина).
  const block = toolsTabHtml();
  assert.match(
    block,
    /data-i18n="tools\.accepts"/,
    "в карточке Samsung нет строки «какие дампы принимает» (tools.accepts)",
  );

  // Ключ есть во всех трёх языках и называет ОБА размера + поколение Tizen.
  // Единица — МиБ/МіБ/MiB (2 МиБ = 0x200000): та же, что в tools.samsung_source,
  // иначе в одной карточке стояли бы «2 МБ» и «2 МиБ» (D-153).
  const expects: Record<string, { chip: string; emmc: string; tizen: string }> = {
    uk: { chip: "64 КіБ", emmc: "2 МіБ", tizen: "Tizen-10" },
    ru: { chip: "64 КиБ", emmc: "2 МиБ", tizen: "Tizen-10" },
    en: { chip: "64 KiB", emmc: "2 MiB", tizen: "Tizen-10" },
  };
  for (const [lang, want] of Object.entries(expects)) {
    const dict = read(`src/i18n/locales/${lang}.ts`);
    const accepts = keyText(dict, "accepts");
    assert.ok(accepts.includes(want.chip), `${lang}: tools.accepts без «${want.chip}»`);
    assert.ok(accepts.includes(want.emmc), `${lang}: tools.accepts без «${want.emmc}»`);
    assert.ok(accepts.includes(want.tizen), `${lang}: tools.accepts без «${want.tizen}»`);
    assert.ok(accepts.includes("2026"), `${lang}: tools.accepts без года 2026`);
    assert.ok(/eMMC/i.test(accepts), `${lang}: tools.accepts без eMMC`);
    assert.match(
      accepts,
      /магазин|store/i,
      `${lang}: tools.accepts должен сказать, что платный патч — только по пакету из магазина`,
    );

    // Текст предупреждения: плоские копии регион не меняют, работает патч раздела
    // eMMC — «тільки в пакетах з магазину» / «только в пакетах из магазина».
    const warn = keyText(dict, "warn_flat_only");
    assert.ok(warn.includes(want.tizen), `${lang}: warn_flat_only без «${want.tizen}»`);
    assert.ok(warn.includes(want.emmc), `${lang}: warn_flat_only без «${want.emmc}»`);
    assert.match(
      warn,
      /пакетах (з|из) магазину|пакетах (з|из) магазина|store package/,
      `${lang}: предупреждение обязано сказать «работает только в пакетах из магазина»`,
    );
  }

  // Рендерер показывает предупреждение по флагу main, а не считает копии сам.
  const page = read("src/ui/ToolsPage.ts");
  assert.ok(page.includes("flatOnly"), "интерфейс ответа патча должен нести flatOnly");
  assert.ok(page.includes("tools.warn_flat_only"), "UI не выводит текст предупреждения");
});

test("T7: цена платной операции — разблокировки пакета (D-158/D-173)", () => {
  // main принимает новый вид выдачи, иначе действующий пакет упирался бы в отказ.
  const service = read("electron/geo-unlock/service.ts");
  assert.match(
    service,
    /kind:\s*"owner"\s*\|\s*"package"\s*\|\s*"trial"\s*\|\s*"paid"/,
    "GeoGrant обязан знать kind \"package\"",
  );
  assert.ok(service.includes('kind !== "package"'), "requireGrant обязан принимать \"package\"");

  // API-контракт клиента: ответ grant'а несёт ОСТАТОК разблокировок.
  // Срок пакета (`package_until`) больше не часть контракта: у утилиты нет срока,
  // есть счётчик (D-158/D-173), а сервер его отдаёт полем `package_unlocks_left`.
  const api = read("src/api.ts");
  assert.ok(
    api.includes("package_unlocks_left"),
    "ответ grant'а должен нести package_unlocks_left",
  );
  assert.ok(!api.includes("package_until"), "срок пакета больше не часть контракта");

  // UI: отдельная строка лога для пакета и человеческий текст отказа 402.
  const page = read("src/ui/ToolsPage.ts");
  assert.ok(page.includes('res.kind === "package"'), "UI обязан обрабатывать kind \"package\"");
  assert.ok(page.includes("tools.grant_package"), "нет текста «осталось разблокировок …»");
  assert.ok(
    page.includes('e?.status === 402 ? t("tools.grant_no_package")'),
    "402 должен превращаться в «нужен активный пакет», а не в сырой API-текст",
  );
});

test("T9: справка разложена ПО МЕТОДАМ — общие правила в шапке, Samsung и LG в своих карточках (D-153)", () => {
  // ПРЕЖДЕ: справка по двум методам жила одним текстом, и мастер искал в ней свою
  // строку (Samsung p31 / LG 24C256) среди чужой.
  // ПОСЛЕ: «два правила» (один ТВ — свой файл; исходник не меняется) стоят в шапке,
  // инструкция Samsung — в карточке Samsung, инструкция LG — в карточке LG.
  const block = toolsTabHtml();
  const at = (needle: string): number => {
    const i = block.indexOf(needle);
    assert.ok(i !== -1, `нет «${needle}» в блоке #tab-tools`);
    return i;
  };
  const samsung = at('data-i18n="tools.samsung_title"');
  const lg = at('data-i18n="tools.lg_title"');
  for (const key of ["tools.rules_one_tv", "tools.rules_keep_dump"]) {
    assert.ok(
      at(`data-i18n="${key}"`) < samsung,
      `${key}: общие правила принадлежат шапке карточки (до карточки Samsung)`,
    );
  }
  // Внутри карточки Samsung — ДВА метода по поколениям (D-154): сначала старые
  // модели (микросхема 24C512), затем новые (дамп 2 МиБ из eMMC). Порядок держим
  // гейтом, иначе текст снова смешается в один абзац.
  let prev = samsung;
  for (const key of [
    "tools.samsung_old_title",
    "tools.samsung_old_howto",
    "tools.samsung_new_title",
    "tools.samsung_source",
    "tools.samsung_howto",
  ]) {
    const i = at(`data-i18n="${key}"`);
    assert.ok(
      i > prev && i < lg,
      `${key} должен стоять В карточці Samsung, после предыдущего блока метода и до LG`,
    );
    prev = i;
  }
  for (const key of ["tools.lg_source", "tools.lg_howto"]) {
    assert.ok(at(`data-i18n="${key}"`) > lg, `${key} должен стоять В карточке LG`);
  }

  // Каждый data-i18n="tools.*" вкладки обязан существовать в эталонном словаре uk,
  // иначе опечатка в разметке превращается в сырой ключ на экране.
  const ukDict = read("src/i18n/locales/uk.ts");
  for (const m of block.matchAll(/data-i18n="tools\.([a-z0-9_]+)"/g)) {
    assert.match(ukDict, new RegExp(`^\\s*${m[1]}:`, "m"), `в uk.ts нет ключа tools.${m[1]}`);
  }

  // Факты методов — те, что мастер вводит руками, поэтому они обязаны быть на экране
  // (и на всех трёх языках): офсеты вычитки пула, офсет байта региона, размер LG-дампа,
  // адреса Area Option и ходовые значения регионов.
  const wants: Record<
    string,
    {
      size: string;
      chipSize: string;
      lgSize: string;
      serial: string;
      newFile: RegExp;
      rollback: RegExp;
    }
  > = {
    uk: {
      size: "2 МіБ",
      chipSize: "64 КіБ",
      lgSize: "32 КіБ",
      serial: "серійний номер",
      newFile: /новий файл/,
      rollback: /відкат/,
    },
    ru: {
      size: "2 МиБ",
      chipSize: "64 КиБ",
      lgSize: "32 КиБ",
      serial: "серийный номер",
      newFile: /новый файл/,
      rollback: /откат/,
    },
    en: {
      size: "2 MiB",
      chipSize: "64 KiB",
      lgSize: "32 KiB",
      serial: "serial number",
      newFile: /new file/i,
      rollback: /rollback/i,
    },
  };
  for (const [lang, want] of Object.entries(wants)) {
    const dict = read(`src/i18n/locales/${lang}.ts`);

    // Samsung, старые модели: микросхема 24C512 — размер дампа и байт региона.
    assert.ok(
      keyText(dict, "samsung_old_title").includes(want.chipSize),
      `${lang}: samsung_old_title обязан назвать размер микросхемы (${want.chipSize})`,
    );
    const oldHowto = keyText(dict, "samsung_old_howto");
    for (const token of [want.chipSize, "0x3E65"]) {
      assert.ok(oldHowto.includes(token), `${lang}: samsung_old_howto без «${token}»`);
    }

    // Samsung, новые модели: это дамп 2 МиБ из eMMC и офсеты вычитки.
    assert.match(
      keyText(dict, "samsung_new_title"),
      /emmc/i,
      `${lang}: samsung_new_title обязан назвать eMMC`,
    );
    // Номера — ДОСЛОВНО из FAQ утилиты (D-157), без пересчёта единиц (пока текст
    // отдавал производный «байтовый» 0x3A3010000, мастер искал в поле дампера
    // число, которого там нет).
    const source = keyText(dict, "samsung_source");
    for (const token of [want.size, "0x1D1328000", "0x3A3010000"]) {
      assert.ok(source.includes(token), `${lang}: samsung_source без «${token}»`);
    }
    // Объяснение «это тот же номер, что стоит в имени дампа (0_NONE_0x01D18080_…bin)
    // — его и используйте» УБРАНО по прямому указанию владельца 2026-11-01
    // («Убрать эту строку»). Номеров офсетов достаточно; привязка к имени файла —
    // лишний шум в подсказке. Гейт держит, чтобы строку не вернули обратно.
    assert.ok(
      !/імені дампа|имени дампа|file name|0_NONE_/i.test(source),
      `${lang}: samsung_source не должен объяснять номер через имя файла дампа`,
    );
    // Порядок действий — в ТОМ ЖЕ блоке, где номера офсетов (слова владельца 2026-11-01:
    // «добавить "Порядок: снять 2 МиБ" в пересчёте в HEX»). Строка взята из FAQ утилиты
    // («Порядок: слить 2 МиБ по офсету -> патч -> залить обратно по тому же офсету»),
    // D-157. Без неё мастер видит числа, но не видит, что именно снимать по этому номеру
    // и куда писать патч обратно.
    assert.match(
      source,
      /порядок|order/i,
      `${lang}: samsung_source обязан назвать порядок (снять 2 МиБ → патч → залить обратно)`,
    );
    assert.match(
      source,
      /офсет|offset/i,
      `${lang}: samsung_source без слова «офсет» — непонятно, по какому номеру снимать`,
    );
    // «Порядок» не должен читаться дважды подряд (было: source без порядка + howto
    // начинался с «Порядок: …», после переноса строки в HEX-блок дубль убран).
    assert.ok(
      !/^\s*(порядок|order)/i.test(keyText(dict, "samsung_howto")),
      `${lang}: samsung_howto не должен повторять «Порядок» — он уже в samsung_source`,
    );
    const howto = keyText(dict, "samsung_howto");
    // D-167: адрес байта региона в блоке НОВЫХ моделей убран — сам адрес
    // (0x3E65 = 02) остался только в старой ветке samsung_old_howto.
    assert.ok(
      !howto.includes("0x3E65"),
      `${lang}: samsung_howto не должен называть 0x3E65 — адрес остался только в старой ветке`,
    );
    assert.match(
      howto,
      /усіх|всех|every/i,
      `${lang}: samsung_howto обязан сказать, что байт правится во ВСЕХ копиях`,
    );

    // LG: размер дампа остаётся; формула упаковки и адреса-кандидаты из UI
    // убраны (D-167) — адрес ищет утилита сама, внутренние координаты мастеру
    // не нужны (в коде они не тронуты).
    const lgSource = keyText(dict, "lg_source");
    for (const token of ["24C256", want.lgSize]) {
      assert.ok(lgSource.includes(token), `${lang}: lg_source без «${token}»`);
    }
    for (const token of ["0x04FC", "0x1C58", "0x0E38", "continentIdx"]) {
      assert.ok(
        !lgSource.includes(token),
        `${lang}: lg_source не должен содержать внутренние координаты «${token}» (D-167)`,
      );
    }
    const lgHowto = keyText(dict, "lg_howto");
    for (const token of ["3122", "3640", "3642"]) {
      assert.ok(lgHowto.includes(token), `${lang}: lg_howto без «${token}»`);
    }

    // Два общих правила.
    const oneTv = keyText(dict, "rules_one_tv");
    assert.ok(oneTv.includes(want.serial), `${lang}: rules_one_tv без «${want.serial}»`);
    assert.match(oneTv, /MAC/, `${lang}: rules_one_tv без MAC-адреса`);
    const keep = keyText(dict, "rules_keep_dump");
    assert.match(keep, want.newFile, `${lang}: rules_keep_dump не говорит про НОВЫЙ файл`);
    assert.match(keep, want.rollback, `${lang}: rules_keep_dump не говорит про откат`);

    // Единица измерения одна на всю карточку: если «что сливать» говорит «2 МіБ»,
    // строка тарифа не может говорить «2 МБ» (раньше так и было).
    assert.ok(
      keyText(dict, "accepts").includes(want.size),
      `${lang}: tools.accepts обязан мерить пул той же единицей (${want.size})`,
    );
  }

  // Теория GPP1 снята (D-149/D-150): в текстах вкладки её быть не должно — иначе
  // мастер снова ищет «плоский дамп» вместо раздела p31.
  assert.ok(!/gpp/i.test(block), "в блоке #tab-tools не должно быть GPP1");
  for (const lang of Object.keys(wants)) {
    const dict = read(`src/i18n/locales/${lang}.ts`);
    const tools = dict.slice(dict.indexOf("tools: {"));
    assert.ok(!/gpp/i.test(tools), `${lang}: словарь tools.* не должен упоминать GPP1`);

    // «Менше про пули» (D-154, слова владельца): мастеру не нужны имена внутренних
    // структур — он правит дамп. Технический жаргон в подсказках только мешает.
    for (const jargon of ["NVRAM", "mmcblk0p31", "журнал", "пул", "pool", "journal"]) {
      assert.ok(
        !tools.includes(jargon),
        `${lang}: в tools.* остался жаргон «${jargon}» — подсказки должны быть проще (D-154)`,
      );
    }

    // Подсказка в поле Area Option приходит из i18n, а не хардкодом в разметке.
    keyText(dict, "lg_value_hint");
    // Галочка «только проверка» убрана — ключ не должен висеть в словаре.
    assert.ok(
      !new RegExp(`^\\s*lg_dry:`, "m").test(dict),
      `${lang}: ключ lg_dry больше не используется (D-154)`,
    );
  }
});

test("T10: LG — поле Area Option без «0»-заглушки, запись только по валидному значению (D-154)", () => {
  // ПРЕЖДЕ: в поле стоял 0 (настоящий регион NORDIC), рядом — галочка «тільки
  // перевірка». Мастер мог снять галочку и записать NORDIC, не заметив.
  // ПОСЛЕ: поле пустое с подсказкой, «Застосувати…» заблокована до валидного
  // значения, проверка — только кнопкой «Перевірити дамп».
  const block = toolsTabHtml();
  const input = /<input[^>]*id="geoLgValueInput"[^>]*>/.exec(block);
  assert.ok(input, "нет поля #geoLgValueInput");
  assert.ok(
    !/\bvalue="/.test(input[0]),
    "поле Area Option не должно иметь значения по умолчанию (0 — это реальный регион)",
  );
  assert.match(
    input[0],
    /data-i18n-placeholder="tools\.lg_value_hint"/,
    "подсказка поля Area Option должна идти через i18n (data-i18n-placeholder)",
  );

  // Кнопка записи стартует заблокированной: без значения писать нечего.
  const patchBtn = /<button[^>]*id="geoPatchLgBtn"[^>]*>/.exec(block);
  assert.ok(patchBtn, "нет кнопки #geoPatchLgBtn");
  assert.match(patchBtn[0], /\bdisabled\b/, "«Застосувати…» должна быть disabled в разметке");

  const page = read("src/ui/ToolsPage.ts");
  // Галочки в коде больше нет: иначе `dryRun` остался бы true по умолчанию и
  // патч LG молча перестал бы писать файлы.
  assert.ok(
    !page.includes("lgDryRun"),
    "ToolsPage не должна читать #geoLgDryRun (D-154)",
  );
  assert.match(
    page,
    /dryRun:\s*false/,
    "патч LG обязан вызываться с dryRun: false — иначе файл не пишется",
  );
  // Кнопка записи зависит от валидности значения, а не только от выбранного файла.
  assert.match(
    page,
    /lgValueOk|lgValueOrNull/,
    "setButtons должен учитывать валидность значения Area Option",
  );
});

test("T11: стара гілка Samsung названа поколіннями 2016–2025 (Tizen 2.4–9.0) і значенням 0x3E65 = 02 (D-155)", () => {
  // Жива перевірка на реальних дампах показала: майстер зі старою моделлю читає
  // «старі моделі — мікросхема 24C512» без жодного орієнтира, ЯКІ це роки і ЯКЕ
  // значення писати. У справжній роботі правка робиться саме на `0x3E65 = 02`
  // (розблокування регіону), і саме ці факти мусять бути на екрані.
  const block = toolsTabHtml();
  assert.match(
    block,
    /data-i18n="tools\.samsung_old_title"/,
    "стара гілка Samsung має лишатися окремим заголовком",
  );

  const wants: Record<string, { gen: string; tizen: string; hex: string; value: RegExp }> = {
    uk: { gen: "2016–2025", tizen: "Tizen 2.4", hex: "0x3E65", value: /\b02\b/ },
    ru: { gen: "2016–2025", tizen: "Tizen 2.4", hex: "0x3E65", value: /\b02\b/ },
    en: { gen: "2016–2025", tizen: "Tizen 2.4", hex: "0x3E65", value: /\b02\b/ },
  };
  for (const [lang, want] of Object.entries(wants)) {
    const dict = read(`src/i18n/locales/${lang}.ts`);
    const title = keyText(dict, "samsung_old_title");
    const howto = keyText(dict, "samsung_old_howto");

    assert.ok(
      title.includes(want.gen),
      `${lang}: samsung_old_title без поколінь «${want.gen}» — майстер не знає, його це ТВ чи ні`,
    );
    assert.ok(
      `${title} ${howto}`.includes(want.tizen),
      `${lang}: гілка старих моделей без «${want.tizen}» — немає орієнтира по поколінню Tizen`,
    );
    assert.ok(howto.includes(want.hex), `${lang}: samsung_old_howto без «${want.hex}»`);
    assert.match(
      howto,
      want.value,
      `${lang}: samsung_old_howto мусить назвати значення 02 — саме його пише майстер`,
    );
    // Обіцянка «контрольна сума перераховується» була неправдою: у 24C512 поле
    // 0xFFFC стерте (0xFFFFFFFF), і нічого там не перераховується. Текст має бути
    // умовним — «якщо сума є в дампі».
    assert.match(
      howto,
      /якщо|если|if/i,
      `${lang}: у samsung_old_howto сума мусить бути умовною («якщо є»), а не безумовною`,
    );
  }
});

test("T12: функционал каждой тулзы — под спойлером (D-167)", () => {
  // ПРАВИЛО: у тулзы видимы название + описание (иконка, subtitle, общие
  // правила), а функциональные секции — свёрнуты в <details class="tool-spoiler">.
  // Паттерн обязателен для НОВЫХ тулз: summary = название секции через i18n.
  const block = toolsTabHtml();

  // Два спойлера — Samsung и LG, каждый со своим summary-названием.
  const spoilers = [...block.matchAll(/<details class="tool-spoiler">/g)];
  assert.equal(spoilers.length, 2, "функциональные секции должны лежать в .tool-spoiler");
  const summaries = [
    ...block.matchAll(/<summary[^>]*data-i18n="tools\.(samsung_title|lg_title)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    summaries,
    ["samsung_title", "lg_title"],
    "summary спойлера — название метода через i18n (видно и в свёрнутом виде)",
  );

  // Стартуют свёрнутыми: атрибут open на спойлерах запрещён.
  assert.ok(!/<details[^>]*\bopen\b/.test(block), "спойлеры должны стартовать свёрнутыми");

  // Описание тулзы — ДО первого спойлера (остаётся видимым).
  const firstDetails = block.indexOf("<details");
  for (const key of ["tools.rules_one_tv", "tools.rules_keep_dump"]) {
    const i = block.indexOf(`data-i18n="${key}"`);
    assert.ok(i !== -1 && i < firstDetails, `${key} — описание тулзы, обязано остаться вне спойлера`);
  }

  // Функционал (кнопки, логи) — ВНУТРИ спойлеров.
  for (const id of [
    "geoPickSamsungBtn",
    "geoCheckSamsungBtn",
    "geoPatchSamsungBtn",
    "geoSamsungLog",
    "geoPickLgBtn",
    "geoScanLgBtn",
    "geoPatchLgBtn",
    "geoLgLog",
  ]) {
    const i = block.indexOf(`id="${id}"`);
    assert.ok(i > firstDetails, `#${id} (функционал) должен лежать под спойлером`);
  }

  // Стиль спойлера присутствует (иначе details выглядит голым элементом).
  const html = read("index.html");
  assert.match(html, /\.tool-spoiler summary/, "в стилях нет оформления .tool-spoiler");
});

test("T13: тулза = тайл-лаунчер (D-169): иконка кликабельна, функционал раскрывается по клику", () => {
  // Поручение владельца 2026-11-04: 3D-иконка «намекает — нажми на меня» → клик
  // по тайлу открывает функционал тулзы со своими спойлерами. Тулза —
  // САМОДОСТАТОЧНЫЙ блок .tool-entry (тайл + рабочая область внутри): новые
  // тулзы добавляются копированием секции и никогда не перекрывают друг друга
  // (аккордеон: открыта максимум одна).
  const block = toolsTabHtml();

  assert.match(
    block,
    /<section class="tool-entry" data-tool="geo-unlock">/,
    "тулза обязана быть самодостаточной секцией .tool-entry",
  );

  // Тайл — кнопка целиком (крупная цель для клика, клавиатура — нативно,
  // состояние — в aria-expanded, цель раскрытия — в aria-controls).
  const tileStart = block.indexOf('<button type="button" class="tool-tile"');
  assert.ok(tileStart !== -1, "тайл тулзы обязан быть <button class=\"tool-tile\">");
  const tileEnd = block.indexOf("</button>", tileStart);
  assert.ok(tileEnd > tileStart, "не найден конец тайла");
  const tileHtml = block.slice(tileStart, tileEnd);
  assert.match(
    tileHtml,
    /aria-expanded="false"[\s\S]*aria-controls="toolBodyGeoUnlock"/,
    "тайл обязан нести aria-expanded/aria-controls",
  );
  // 3D-иконка внутри тайла — «намекает: нажми на меня».
  assert.match(tileHtml, /class="tool-tile-icon"/, "иконка обязана иметь .tool-tile-icon");
  assert.match(tileHtml, /src="\/geo-unlock-3d\.png"/, "3D-иконка обязана быть внутри тайла");
  assert.match(
    tileHtml,
    /data-i18n="tools\.subtitle"/,
    "описание тулзы обязано быть на тайле (видно ДО раскрытия)",
  );

  // Рабочая область: скрыта по умолчанию; правила и ОБА спойлера — внутри.
  const wsStart = block.indexOf('<div class="tool-workspace" id="toolBodyGeoUnlock" hidden');
  assert.ok(wsStart > tileEnd, "рабочая область обязана идти после тайла и стартовать скрытой");
  const wsEnd = block.indexOf("</section>", wsStart);
  assert.ok(wsEnd > wsStart, "рабочая область и спойлеры должны жить внутри .tool-entry");
  const ws = block.slice(wsStart, wsEnd);
  for (const key of [
    "tools.rules_one_tv",
    "tools.rules_keep_dump",
    "tools.samsung_title",
    "tools.lg_title",
  ]) {
    assert.ok(ws.includes(`data-i18n="${key}"`), `в рабочей области нет ${key}`);
  }

  // Общая обвязка в ToolsPage: тогглы вешаются на ВСЕ .tool-tile по
  // aria-controls — новой тулзе JS не нужен вообще.
  const page = read("src/ui/ToolsPage.ts");
  assert.match(
    page,
    /querySelectorAll<HTMLButtonElement>\("\.tool-tile"\)/,
    "обвязка обязана быть общей (querySelectorAll .tool-tile)",
  );
  assert.match(page, /getAttribute\("aria-controls"\)/, "раскрытие — по aria-controls");
  assert.match(page, /setAttribute\("aria-expanded"/, "состояние — в aria-expanded");
  assert.match(
    page,
    /other === tile \? willOpen : false/,
    "аккордеон: открытие одной тулзы обязано закрывать остальные",
  );

  // Стили тайла/рабочей области: hover-подсветка иконки + анимация раскрытия.


test("T14: счётчик разблокировок — ВНУТРИ спойлера Samsung, цифра с сервера (D-173)", () => {
  // Требование владельца: счётчик «осталось разблокировок TIZEN 2026+» живёт не в
  // шапке клиента, а в карточке утилиты — в спойлере Samsung. Рядом обязана стоять
  // пометка, что микросхема NVM (Tizen до 2026) бесплатна: иначе мастер считает,
  // что платить нужно за любое разблокирование.
  const block = toolsTabHtml();
  const samsung = block.indexOf('data-i18n="tools.samsung_title"');
  const lg = block.indexOf('data-i18n="tools.lg_title"');
  assert.ok(samsung !== -1 && lg !== -1, "нет карточек Samsung/LG во вкладке");

  const counter = block.indexOf('id="geoUnlocksLeft"');
  assert.ok(counter !== -1, "нет элемента счётчика #geoUnlocksLeft");
  assert.ok(
    counter > samsung && counter < lg,
    "счётчик обязан стоять внутри спойлера Samsung (до карточки LG)",
  );

  const note = block.indexOf('data-i18n="tools.free_nvm_note"');
  assert.ok(note !== -1, "нет пометки «NVM Tizen до 2026 — бесплатно»");
  assert.ok(
    note > samsung && note < lg,
    "пометка о бесплатном NVM стоит в карточке Samsung, рядом со счётчиком",
  );

  // Цифру даёт СЕРВЕР отдельным ЧТЕНИЕМ: спрашивать остаток через grant нельзя —
  // выдача списывает разблокировку и стоила бы мастеру операции.
  const page = read("src/ui/ToolsPage.ts");
  assert.ok(page.includes("api.geoUnlockStatus()"), "нет чтения остатка (geoUnlockStatus)");
  assert.ok(page.includes('querySelector("#geoUnlocksLeft")'), "счётчик не привязан к DOM");
  assert.ok(page.includes("renderUnlockCounter"), "нет рендера счётчика");
  assert.ok(
    page.includes("package_unlocks_left"),
    "остаток после операции берётся из ответа grant'а, а не пересчитывается",
  );

  // Вкладку открыли — остаток обновили (он мог измениться, пока вкладка была закрыта).
  const app = read("src/ui/App.ts");
  assert.match(
    app,
    /tabName === "tools"[\s\S]{0,400}toolsPage\.refreshStatus\(\)/,
    "открытие вкладки «Інструменти» обязано обновлять счётчик",
  );

  // Все тексты счётчика — во всех трёх локалях, иначе на экране сырой ключ.
  const keys = [
    "free_nvm_note",
    "unlocks_loading",
    "unlocks_left",
    "unlocks_unlimited",
    "unlocks_owner",
    "unlocks_trial",
    "unlocks_none",
  ];
  for (const lang of ["uk", "ru", "en"]) {
    const dict = read(`src/i18n/locales/${lang}.ts`);
    for (const key of keys) {
      assert.match(dict, new RegExp(`^\\s*${key}:`, "m"), `${lang}: нет ключа tools.${key}`);
    }
  }

  // Форм-плейсхолдеры счётчика: число подставляется, текст не хардкодится в разметке.
  const uk = read("src/i18n/locales/uk.ts");
  assert.match(keyText(uk, "unlocks_left"), /\{n\}/, "uk: счётчик обязан подставлять {n}");
  assert.match(
    keyText(uk, "unlocks_trial"),
    /\{left\}[\s\S]*\{limit\}/,
    "uk: пробные попытки показывают остаток и лимит",
  );
});

  const html = read("index.html");
  assert.match(html, /\.tool-tile \{/, "нет стилей тайла");
  assert.match(html, /\.tool-tile:hover \.tool-tile-icon/, "нет hover-подсветки иконки");
  assert.match(html, /\.tool-workspace:not\(\[hidden\]\)/, "нет анимации раскрытия рабочей области");
});

