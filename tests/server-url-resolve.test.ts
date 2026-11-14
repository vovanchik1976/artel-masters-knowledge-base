/**
 * Zero-Domain живучесть (SP-07 §5, решения D-005/D-009) — гейт по ИСХОДНИКАМ:
 * клиентский код обязан знать ТОЛЬКО канонический домен, ни одного публичного
 * IP-литерала в код-пути.
 *
 * Почему гейт по тексту, а не поведенческий тест: `ApiClient` в конструкторе
 * читает `import.meta.env` (Vite) — в `node:test` этого нет, а `src/api.ts`
 * тянет за собой весь граф renderer'а. При этом инвариант критичен и проверяется
 * статически: сырой IP в дефолте = «кирпич» у всех установленных клиентов при
 * переезде VPS на новый адрес (сменить адрес без пересборки и релиза нельзя).
 *
 * RED (до SP-07 S-1): `src/api.ts` держал
 * `constructor(baseUrl: string = import.meta.env.VITE_SERVER_URL || "http://tv-firmware.duckdns.org:8081")`,
 * комментарий рядом ссылался на staging `http://tv-firmware.duckdns.org:8082`, а
 * e2e-стенды делали префлайт прямо по `http://tv-firmware.duckdns.org:8081/healthz`.
 * GREEN: дефолт — `https://tv-firmware.duckdns.org`, IP-литералов нет ни в
 * `src/**`, ни в `electron/**`, e2e префлайтят только канонический адрес.
 *
 * Разрешённые исключения: loopback (`127.0.0.1`, `0.0.0.0`) — это локальные
 * адреса dev-сервера, наружу не ведут.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** Канонический адрес клиента (Caddy + Let's Encrypt на DuckDNS-домене). */
const CANONICAL_URL = "https://tv-firmware.duckdns.org";

/** Каталог `desktop-electron`: ищем вверх по дереву от скомпилированного
 *  `tmp-tests/tests`, чтобы гейт не зависел от `outDir` тестов. */
function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "src", "api.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`desktop-electron не найден (старт поиска: ${__dirname})`);
    }
    dir = parent;
  }
}

/** IPv4-литерал целиком (version-строки вида `22.3.27` не матчатся). */
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

/** Локальные адреса разрешены: dev-сервер Vite, loopback-хелперы, 0.0.0.0. */
function isLocalLiteral(ip: string): boolean {
  return ip.startsWith("127.") || ip === "0.0.0.0";
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("дефолт ApiClient — канонический домен, а не сырой IP", () => {
  const src = fs.readFileSync(path.join(projectRoot(), "src", "api.ts"), "utf8");
  const match =
    /constructor\s*\(\s*baseUrl\s*:\s*string\s*=\s*import\.meta\.env\.VITE_SERVER_URL\s*\|\|\s*"([^"]+)"\s*\)/.exec(
      src,
    );
  assert.ok(
    match,
    "не найден дефолт `constructor(baseUrl = import.meta.env.VITE_SERVER_URL || \"...\")` — проверь разметку теста",
  );
  assert.equal(
    match![1],
    CANONICAL_URL,
    `дефолт клиента обязан быть каноническим доменом ${CANONICAL_URL}: сырой IP \
     делает установленные клиенты «кирпичом» при смене адреса VPS (D-009)`,
  );
  assert.ok(
    !/https?:\/\/\d/.test(src),
    "в api.ts остался URL со сырым IP-литералом",
  );
});

test("в клиентском код-пути (src/, electron/) нет публичных IP-литералов", () => {
  const root = projectRoot();
  const violations: string[] = [];
  for (const scope of ["src", "electron"]) {
    const abs = path.join(root, scope);
    if (!fs.existsSync(abs)) continue;
    for (const file of collectSources(abs)) {
      const text = fs.readFileSync(file, "utf8");
      for (const hit of text.matchAll(IPV4)) {
        const ip = hit[0];
        if (isLocalLiteral(ip)) continue;
        violations.push(`${path.relative(root, file)}: ${ip}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `публичные IP-адреса в клиенте запрещены (нарушения: ${violations.join(", ")}) — \
     адрес сервера резолвится только из канонического домена/env/маяка`,
  );
});

test("e2e-стенды префлайтят только канонический адрес (никакого IP:8081)", () => {
  const root = projectRoot();
  for (const script of ["e2e-prod.sh", "e2e-prod32.sh"]) {
    const text = fs.readFileSync(path.join(root, script), "utf8");
    assert.ok(
      text.includes(CANONICAL_URL),
      `${script}: префлайт обязан ходить на ${CANONICAL_URL}/healthz (тот же адрес, что у релиза)`,
    );
    assert.doesNotMatch(
      text,
      /164\.68\.126\.154|:8081/,
      `${script}: прод admin больше не публикуется наружу (SP-07 S-1b) — префлайт по \
       прямому IP:8081 либо устарел, либо проверяет то, чего снаружи нет`,
    );
  }
});
