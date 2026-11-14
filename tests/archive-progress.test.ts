/**
 * Прогресс «Архиватора» (pack/unpack) — гейты по ИСХОДНИКАМ.
 *
 * Почему по тексту: событие `archive-progress` эмитит Rust-движок, а рисует
 * вкладка — сквозной путь проверяется живым прогоном (`e2e-prod*.sh`), здесь же
 * фиксируются инварианты, которые нельзя проверить юнит-тестом UI:
 *
 *  A1  полоса есть в разметке и стоит ВНУТРИ вкладки «Архиватор» (перед логом);
 *  A2  вкладка подписана на `archive-progress` и рисует кадры через `report()`;
 *  A3  троттлинг — ТОЛЬКО в движке: обработчик кадра без таймеров (иначе на
 *      гигабайтном файле UI «дёргается» и роняет плавность);
 *  A4  `total <= 0` (размер неизвестен) НЕ рисует ложные 100 % — полоса
 *      остаётся в неопределённом режиме «⏳»;
 *  A5  полоса закрывается в `finally` обеих операций (успех/ошибка);
 *  A6  движок эмитит `{op, processed, total}` и троттлит 200 мс / +1 %;
 *  A7  firmware-core отправляет ПРИНУДИТЕЛЬНЫЙ финальный кадр `(total, total)`
 *      в обеих ветках (zip и tar.zst, упаковка и распаковка) — без него полоса
 *      не доходит до 100 %.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

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

function read(rel: string): string {
  return fs.readFileSync(path.join(projectRoot(), rel), "utf8");
}

/** Тело метода: от `marker` до парной закрывающей скобки (балансировка). */
function methodBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `не найден метод \`${marker}\``);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`незакрытый метод \`${marker}\``);
}


test("A1: полоса #archiveProgress* есть в разметке внутри вкладки «Архиватор»", () => {
  const html = read("index.html");
  for (const id of [
    "archiveProgress",
    "archiveProgressFill",
    "archiveProgressText",
    "archiveProgressEta",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `в index.html нет #${id}`);
  }
  const tab = html.indexOf('id="tab-archiver"');
  assert.ok(tab >= 0, "в index.html нет вкладки #tab-archiver");
  const progress = html.indexOf('id="archiveProgress"');
  const log = html.indexOf('id="archiveLog"');
  assert.ok(
    progress > tab && progress < log,
    "полоса должна стоять внутри #tab-archiver перед #archiveLog",
  );
});

test("A2: вкладка подписана на archive-progress и рисует кадры report()", () => {
  const src = read("src/ui/ArchivePage.ts");
  assert.match(
    src,
    /listen<ArchiveProgressPayload>\("archive-progress"/,
    "нет подписки на событие archive-progress",
  );
  assert.match(
    src,
    /this\.progress\.report\(processed, total\)/,
    "кадр не доходит до ProgressUI.report (детерминированной полосы не будет)",
  );
  assert.match(
    src,
    /new ProgressUI\(\s*"archiveProgress",\s*"archiveProgressFill",\s*"archiveProgressText",\s*"archiveProgressEta",?\s*\)/,
    "ProgressUI должен быть привязан к #archiveProgress* из index.html",
  );
});

test("A3: троттлинг только в движке — обработчик кадра без таймеров", () => {
  const body = methodBody(read("src/ui/ArchivePage.ts"), "private _onArchiveProgress(");
  assert.doesNotMatch(
    body,
    /Date\.now|performance\.now|setTimeout|setInterval/,
    "UI не должен троттлить кадры: иначе полоса отстаёт от движка",
  );
});

test("A4: total<=0 (размер неизвестен) не рисует ложные 100 %", () => {
  const body = methodBody(read("src/ui/ArchivePage.ts"), "private _onArchiveProgress(");
  const guard = body.search(/total\s*<=\s*0/);
  assert.ok(guard >= 0, "нет страховки `total <= 0` (неопределённый режим)");
  const report = body.indexOf(".report(");
  assert.ok(report > guard, "report() обязан вызываться ПОСЛЕ проверки total");
});

test("A5: полоса закрывается в finally обеих операций", () => {
  const src = read("src/ui/ArchivePage.ts");
  for (const [marker, op] of [
    ["async pack(", "pack"],
    ["async unpack(", "unpack"],
  ] as const) {
    const body = methodBody(src, marker);
    assert.match(
      body,
      new RegExp(`_beginProgress\\("${op}"\\)`),
      `${op}: операция не запускает полосу`,
    );
    assert.match(
      body,
      /finally \{[\s\S]*_endProgress\(/,
      `${op}: полоса обязана гаситься в finally (ошибка/успех)`,
    );
  }
});

test("A6: движок эмитит {op, processed, total} и троттлит 200 мс / +1 %", () => {
  const m2 = read("engine-core/src/m2.rs");
  assert.match(m2, /"archive-progress"/, "нет имени события в M2-диспетчере");
  assert.match(m2, /"op": "pack"/, "кадры упаковки без op=pack");
  assert.match(m2, /"op": "unpack"/, "кадры распаковки без op=unpack");
  assert.match(m2, /"processed": processed/, "в кадре нет processed");
  assert.match(m2, /"total": total/, "в кадре нет total");
  assert.match(
    m2,
    /now_ms\.saturating_sub\(t\) >= 200/,
    "нет 200-мс окна троттлинга (stdout зальёт кадрами)",
  );
  assert.match(
    m2,
    /processed >= total/,
    "финальный кадр обязан форсироваться (иначе полоса не дойдёт до 100 %)",
  );
});

test("A7: firmware-core шлёт принудительный финальный кадр (total,total)", () => {
  for (const file of ["firmware-core/src/archive.rs", "firmware-core/src/tar_zst.rs"]) {
    const src = read(file);
    const hits = src.match(/on_progress\(total, total\)/g) ?? [];
    assert.ok(
      hits.length >= 2,
      `${file}: ожидалось ≥2 финальных кадра (упаковка + распаковка), найдено ${hits.length}`,
    );
  }
});
