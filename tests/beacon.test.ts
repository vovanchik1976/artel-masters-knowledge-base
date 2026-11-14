/**
 * SP-07 S-2 — гейт клиентской части Silent Beacon (D-006 pull-only, D-007 формат, D-015 дизайн).
 *
 * RED (до S-2): у клиента не было ни одного способа узнать НОВЫЙ адрес сервера —
 * `ApiClient` знал ровно один URL (`VITE_SERVER_URL` либо канонический домен).
 * Смерть домена/DuckDNS = «кирпич» у всех установленных клиентов, а рассылка
 * координат в PM запрещена (D-006). Клиентской части маяка не существовало.
 *
 * GREEN: клиент читает описание бота (через свой TDLib), находит в нём токен
 * `BEACON:v1:<kid>:<base64url>`, расшифровывает его AES-256-GCM (§3/D-007) и
 * переключается на новый адрес. Любая проблема → fail-open (остаёмся на старом
 * адресе), ноль сообщений в PM.
 *
 * Вектор GOLDEN сгенерирован серверным `scripts/publish_beacon.py` и зафиксирован
 * также в `tests_pm/test_beacon.py` — так межъязыковой формат не разъедется.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  BEACON_KEYS,
  BEACON_KEY_LABEL,
  BEACON_MARKER,
  b64urlToBytes,
  bytesToB64url,
  decryptBeaconToken,
  extractBeaconToken,
  resolveBeacon,
  validateBeaconUrl,
  type ByteBuffer,
} from "../src/beacon";
import {
  MAX_BEACON_ATTEMPTS,
  createBeaconState,
  findFallbackServerUrl,
  isTransportFailure,
  registerBeaconAttempt,
  shouldAttemptBeacon,
} from "../src/ui/BeaconPolicy";

/** Канонические векторы из tests_pm/test_beacon.py (НЕ менять поодиночке). */
const GOLDEN =
  "BEACON:v1:1:AAECAwQFBgcICQoL7qfAD9F3YNUi4jCBVX9oTyfZluW7YKXZ1b8idiI-gjCyDRGbGfMp"
  + "X3dcMznUhJviXyMCwEMRw7PxFX3dRscdqH_FSHsEcTv4ww";
const GOLDEN_URL = "https://tv-firmware.duckdns.org";
const GOLDEN_TS = 1_789_600_000;
const FIXED_NONCE: ByteBuffer = new Uint8Array(
  Array.from({ length: 12 }, (_v, i) => i),
) as ByteBuffer;

function projectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "src", "api.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`desktop-electron не найден (${__dirname})`);
    dir = parent;
  }
}

function hexToBytes(hex: string): ByteBuffer {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Независимая (эталонная) сборка payload — тем же форматом, что и в Python. */
async function referencePayload(
  url: string,
  kid: string,
  keyHex: string,
  ts: number,
  nonce: ByteBuffer,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify({ url, ts }));
  const aad = new TextEncoder().encode(`${BEACON_MARKER}${kid}`);
  const blob = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
  );
  const joined = new Uint8Array(nonce.length + blob.length);
  joined.set(nonce, 0);
  joined.set(blob, nonce.length);
  return `${BEACON_MARKER}${kid}:${bytesToB64url(joined)}`;
}

// ── T1: межъязыковой вектор ────────────────────────────────────────────────

test("T1: GOLDEN-вектор сервера расшифровывается клиентом", async () => {
  const parsed = await decryptBeaconToken(GOLDEN, { now: (GOLDEN_TS + 60) * 1000 });
  assert.equal(parsed.url, GOLDEN_URL);
  assert.equal(parsed.kid, "1");
  assert.equal(parsed.ts, GOLDEN_TS);
});

test("T11: ключ маяка — публичное значение SHA-256(метка), а не зашитый секрет", async () => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BEACON_KEY_LABEL)),
  );
  const expected = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(BEACON_KEYS["1"], expected, "ключ обязан выводиться из публичной метки");
});

test("T1b: эталонная сборка совпадает с GOLDEN (формат nonce‖ct‖tag, AAD=kid)", async () => {
  const built = await referencePayload(GOLDEN_URL, "1", BEACON_KEYS["1"], GOLDEN_TS, FIXED_NONCE);
  assert.equal(built, GOLDEN);
});

// ── T2–T6: отказы (fail-open) ──────────────────────────────────────────────

test("T2: битый base64 → отказ, без «угадывания» адреса", async () => {
  await assert.rejects(() => decryptBeaconToken("BEACON:v1:1:!!!!не-base64!!!!"));
  assert.equal(await resolveBeacon("BEACON:v1:1:!!!!не-base64!!!!"), null);
});

test("T3: повреждённый шифротекст/тег → отказ", async () => {
  const damaged = GOLDEN.slice(0, -4) + "AAAa";
  assert.equal(await resolveBeacon(damaged), null);
});

test("T3b: подмена kid без ключа → отказ", async () => {
  const swapped = GOLDEN.replace("BEACON:v1:1:", "BEACON:v1:zz:");
  assert.equal(await resolveBeacon(swapped), null);
});

test("T4: просроченный ts → отказ (маяк не уводит на мёртвый адрес)", async () => {
  const parsed = await resolveBeacon(GOLDEN, { now: (GOLDEN_TS + 60) * 1000 });
  assert.ok(parsed, "свежий маяк обязан читаться");
  const expired = (GOLDEN_TS + 31 * 24 * 3600) * 1000;
  assert.equal(await resolveBeacon(GOLDEN, { now: expired }), null);
});

test("T5: текст без маркера → null (обычное описание бота)", async () => {
  assert.equal(extractBeaconToken("ARTEL — база знань майстрів"), null);
  assert.equal(extractBeaconToken(""), null);
  assert.equal(await resolveBeacon("ARTEL — база знань майстрів"), null);
});

test("T6: невалидный адрес в payload (http/IP/путь) → отказ", async () => {
  for (const bad of ["http://tv-firmware.duckdns.org", "https://tv-firmware.duckdns.org", "https://x.org/api"]) {
    const token = await referencePayload(bad, "1", BEACON_KEYS["1"], GOLDEN_TS, FIXED_NONCE);
    assert.equal(await resolveBeacon(token, { now: GOLDEN_TS * 1000 }), null, `принят адрес ${bad}`);
  }
  assert.equal(validateBeaconUrl(GOLDEN_URL), GOLDEN_URL);
  assert.equal(validateBeaconUrl("http://x.org"), null);
});

// ── T7–T10: политика переключения (backoff, кеш, fail-open) ────────────────

test("T7: backoff — повтор не раньше окна, не больше лимита попыток", () => {
  const now = 1_000_000;
  let state = createBeaconState();
  assert.equal(shouldAttemptBeacon(state, now), true, "первая попытка разрешена");

  state = registerBeaconAttempt(state, now);
  assert.equal(shouldAttemptBeacon(state, now), false, "вторая попытка сразу — нет");
  assert.equal(shouldAttemptBeacon(state, now + 60_000), false, "через минуту — ещё нет");
  assert.equal(shouldAttemptBeacon(state, now + 10 * 60_000), true, "через 10 минут — да");

  for (let i = 0; i < MAX_BEACON_ATTEMPTS; i++) state = registerBeaconAttempt(state, now);
  assert.equal(shouldAttemptBeacon(state, now + 24 * 3600 * 1000), false, "лимит попыток исчерпан");
});

test("T8a: маяк не пробуем при живом сервере (HTTP-ошибки — не транспорт)", () => {
  assert.equal(isTransportFailure(new Error("API 500: server_error")), false);
  assert.equal(isTransportFailure(new Error("API 401: unauthorized")), false);
  assert.equal(isTransportFailure(new TypeError("Failed to fetch")), true);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isTransportFailure(abort), true);
});

test("T9: основной адрес мёртв → клиент находит новый endpoint через маяк", async () => {
  const result = await findFallbackServerUrl({
    cached: null,
    readDescription: async () => `ARTEL — база знань майстрів\n\n${GOLDEN}`,
    now: (GOLDEN_TS + 120) * 1000,
  });
  assert.equal(result?.url, GOLDEN_URL);
  assert.equal(result?.source, "beacon");
  assert.equal(result?.kid, "1", "kid кладётся в кеш config.json");
  assert.equal(result?.ts, GOLDEN_TS, "ts кладётся в кеш config.json");
});

test("T9b: кеш адреса сильнее маяка и не требует TDLib", async () => {
  let readCalls = 0;
  const result = await findFallbackServerUrl({
    cached: { server_url: "https://cache.example.org", beacon_ts: GOLDEN_TS, beacon_kid: "1" },
    readDescription: async () => {
      readCalls += 1;
      throw new Error("TDLib не должен вызываться: кеш уже даёт адрес");
    },
  });
  assert.deepEqual(result, { url: "https://cache.example.org", source: "cache" });
  assert.equal(readCalls, 0);
});

test("T10: маяк недоступен/бесполезен → fail-open (null), без исключений", async () => {
  const logs: string[] = [];
  const nulls = await Promise.all([
    findFallbackServerUrl({
      cached: null,
      readDescription: async () => {
        throw new Error("TDLib не авторизован");
      },
      log: (m) => logs.push(m),
    }),
    findFallbackServerUrl({
      cached: null,
      readDescription: async () => "ARTEL — база знань майстрів",
      log: (m) => logs.push(m),
    }),
    findFallbackServerUrl({
      cached: { server_url: "http://ip-без-https.example.org" },
      readDescription: async () => `BEACON:v1:1:${"A".repeat(40)}`,
      log: (m) => logs.push(m),
    }),
  ]);
  assert.deepEqual(nulls, [null, null, null]);
  assert.ok(logs.length >= 3, "каждый отказ обязан оставить строку в логе (EN)");
});

// ── T12: ноль сообщений в PM (D-006) ──────────────────────────────────────

test("T12: маяк не отправляет сообщений в PM и не шлёт запросов на наш домен", () => {
  const root = projectRoot();
  const forbidden = /sendMessage|send_bot_start|tdlib_send|chat_id.*send/i;
  for (const rel of ["src/beacon.ts", "src/ui/BeaconPolicy.ts"]) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(text, forbidden, `${rel}: маяк обязан быть read-only (pull, D-006)`);
    assert.doesNotMatch(text, /fetch\(|https?:\/\/tv-firmware/, `${rel}: маяк не ходит в сеть сам`);
  }
});
