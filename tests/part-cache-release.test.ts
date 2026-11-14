/**
 * Освобождение кеша принятой части (BUG-PART-CACHE-PEAK-001) — гейт по ИСХОДНИКУ
 * [`engine-core/src/parts_download.rs`](../engine-core/src/parts_download.rs).
 *
 * Почему гейт по тексту, а не поведенческий тест: рассинхронизация, которую он
 * ловит, живёт НА ГРАНИЦЕ trait-impl/inherent-impl, куда Rust-тесты не достают —
 * юнит-тесты гоняют фейковые `PartSource` (RecordingSource/StallSource), а боевой
 * `TdlibPartSource` требует живого рантайма TDLib. Реальный дефект, пойманый этим
 * гейтом в первом заходе: `fn release_cache` был объявлен в `impl
 * TdlibPartSource<'_>` (inherent), а НЕ в `impl PartSource for TdlibPartSource`,
 * поэтому боевой путь молча брал no-op дефолт трейта — кеш не снимался бы никогда,
 * а все поведенческие тесты остались бы зелёными.
 *
 * Второй инвариант — ПОРЯДОК: `release_cache` (приёмка) обязан вызываться ПОСЛЕ
 * size-guard. До приёмки (склейка + совпадение размера) кеш части — источник
 * resume для stall-ретрая (BUG-DOWNLOAD-049), снятие раньше сделало бы повтор
 * холодным. Отдельная строка — детерминированные ошибки целостности
 * (sha/size mismatch): там байты уже неверны, кеш снимается СРАЗУ
 * (BUG-CABINET-VAULT-SHA-MISMATCH-001), и это не считается «приёмкой».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Исходник Rust-движка: поднимаемся до корня проекта (`engine-core/` рядом с
 *  `desktop-electron/`), чтобы гейт не зависел от `outDir` тестов (`tmp-tests/tests`). */
function partsDownloadSourcePath(): string {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, "engine-core", "src", "parts_download.rs");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`engine-core/src/parts_download.rs не найден (старт: ${__dirname})`);
    }
    dir = parent;
  }
}

function source(): string {
  return fs.readFileSync(partsDownloadSourcePath(), "utf8");
}

/** Тело блока `impl <header> { ... }` с балансировкой скобок. */
function implBody(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `не найден блок \`${header}\``);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`незакрытый блок \`${header}\``);
}

test("боевой TdlibPartSource переопределяет release_cache в trait-impl", () => {
  const body = implBody(source(), "impl PartSource for TdlibPartSource<'_>");
  assert.match(
    body,
    /fn\s+release_cache\s*\(/,
    "в `impl PartSource for TdlibPartSource` нет override `release_cache`: сработает \
     no-op дефолт трейта, и кеш части в бою не снимется (кеш ×2 к target)",
  );
  assert.match(
    body,
    /delete_cached_part\s*\(\s*file_id\s*\)/,
    "override обязан делегировать в `delete_cached_part` (тот шлёт TDLib `deleteFile`)",
  );
});

test("deleteFile уходит точечно, а не сносом каталогов кеша", () => {
  const src = source();
  const body = implBody(src, "impl TdlibPartSource<'_>");
  const fnAt = body.indexOf("fn delete_cached_part");
  assert.ok(fnAt >= 0, "нет `delete_cached_part` — снимать кеш части нечем");
  const impl = body.slice(fnAt, body.indexOf("\n    }", fnAt));
  assert.match(
    impl,
    /"@type"\s*:\s*"deleteFile"/,
    "кеш части снимается точечным `deleteFile`; `purge_cache_dirs` снёс бы кеш \
     параллельной вкладки (общий на TDLib-сессию)",
  );
  assert.doesNotMatch(
    impl,
    /purge_cache_dirs|post_download_purge/,
    "снятие кеша MID-job не имеет права звать каталоговые пурги",
  );
});

test("кеш снимается ПОСЛЕ приёмки части (склейка + size-guard)", () => {
  const src = source();
  const body = implBody(src, "fn process_part_once<");
  const guardAt = body.indexOf("size mismatch");
  assert.ok(guardAt >= 0, "в `process_part_once` нет size-guard — проверь разметку теста");
  // Приёмка: первый вызов ПОСЛЕ size-guard (до него кеш — источник resume).
  const releaseAfterGuard = body.indexOf("release_cache(", guardAt);
  assert.ok(
    releaseAfterGuard > guardAt,
    "`release_cache` обязан вызываться ПОСЛЕ size-guard: до приёмки кеш части — \
     источник resume для stall-ретрая (BUG-DOWNLOAD-049)",
  );
  // Детерминированная ошибка целостности — не приёмка, а признание байтов
  // битыми: кеш снимается сразу (BUG-CABINET-VAULT-SHA-MISMATCH-001), иначе
  // повтор читает отравленный файл.
  const shaAt = body.indexOf("verify_sha(&cached");
  assert.ok(shaAt >= 0, "нет проверки sha в `process_part_once`");
  assert.ok(
    body.indexOf("release_cache(", shaAt) > shaAt,
    "sha-mismatch обязан снимать кеш части — иначе повтор и следующий запуск \
     читают те же неверные байты",
  );
});
