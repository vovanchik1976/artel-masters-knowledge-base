/**
 * SP-07 S-2 — Silent Beacon: чтение адреса сервера из описания бота (D-007 формат).
 *
 * Зачем: единственный адрес клиента — канонический домен (SP-07 S-1/D-009). Если
 * домен/DuckDNS/сертификат перестают работать, УЖЕ установленный клиент остаётся
 * «кирпичом»: адрес нельзя сменить без пересборки и релиза. Массовая рассылка
 * координат в PM запрещена (D-006 — анти-спам/анти-бан), поэтому координаты
 * лежат в описании бота, а клиент читает их САМ (pull) через свой TDLib.
 *
 * Формат (D-007):
 *   BEACON:v1:<kid>:<base64url( nonce(12) ‖ AES-256-GCM(ct ‖ tag) )>
 * AAD = `BEACON:v1:<kid>` — подмена `kid` ломает тег аутентификации.
 * Плейнтекст — компактный JSON `{"url": ..., "ts": ...}`.
 *
 * Ключ маяка — ПУБЛИЧНОЕ по построению значение (SHA-256 от литеральной метки,
 * D-015). Он не защищает тайну (адрес сервера публичен), а лишь не даёт описанию
 * бота выглядеть «сырым техническим адресом» для анти-фишинг эвристик Telegram.
 * Поэтому «Zero Secrets in Binary» не нарушается: гейт `scripts/verify_no_secrets.js`
 * остаётся зелёным, а значение ниже воспроизводится одной командой (см. тест).
 *
 * Модуль ЧИСТЫЙ: никакой сети, никаких TDLib-команд, никаких сообщений в PM.
 */

/** Маркер payload в описании бота. */
export const BEACON_MARKER = "BEACON:v1:";

/** Публичная метка, из которой выводится ключ (SHA-256) — не секрет (D-015). */
export const BEACON_KEY_LABEL = "artel.beacon.v1";

/**
 * kid → ключ (hex). Ключ = SHA-256("artel.beacon.v1"):
 *   python3 -c 'import hashlib;print(hashlib.sha256(b"artel.beacon.v1").hexdigest())'
 * Ротация: добавить новый kid в этот словарь ВМЕСТЕ с релизом, который его знает.
 */
export const BEACON_KEYS: Record<string, string> = {
  "1": "40445aa270260f493521a752121d49698ff23e39f69db212f7991f48a288a622",
};

/** Маяк свежий 30 суток; прод-деплой перепубликовывает его (ts обновляется). */
export const BEACON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Запас на расхождение часов: маяк «из будущего» невозможен. */
export const BEACON_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

const TOKEN_RE = /BEACON:v1:([A-Za-z0-9_-]{1,16}):([A-Za-z0-9_-]{16,})/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface BeaconPayload {
  url: string;
  kid: string;
  ts: number;
}

export interface BeaconDecodeOptions {
  /** Ключи kid → hex (по умолчанию BEACON_KEYS). */
  keys?: Record<string, string>;
  /** Текущее время в мс (для тестов; по умолчанию Date.now()). */
  now?: number;
}

/**
 * Байтовый буфер с СОБСТВЕННЫМ `ArrayBuffer`: WebCrypto в TS 5.7+ требует
 * `BufferSource` = `ArrayBufferView<ArrayBuffer>` (не `ArrayBufferLike`).
 */
export type ByteBuffer = Uint8Array<ArrayBuffer>;

/** Найти токен маяка в тексте описания бота (null — маяка нет). */
export function extractBeaconToken(text: string): string | null {
  if (!text) return null;
  const match = TOKEN_RE.exec(text);
  return match ? match[0] : null;
}

export function hexToBytes(hex: string): ByteBuffer {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("beacon: odd hex key length");
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("beacon: key is not hex");
    out[i] = byte;
  }
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(text: string): ByteBuffer {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  // `%` в JS знаковый (`-2 % 4 === -2`), поэтому паддинг считаем через остаток от деления.
  const padLength = (4 - (normalized.length % 4)) % 4;
  const binary = atob(normalized + "=".repeat(padLength));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Валидация адреса из маяка: только https, домен (без IP-литерала), без пути.
 *
 * Инвариант SP-07 (D-009): адрес сервера — домен, а не сырой IP. Маяк обязан
 * подчиняться тому же правилу, иначе он станет лазейкой для возврата IP.
 * Возвращает нормализованный origin либо null.
 */
export function validateBeaconUrl(url: string): string | null {
  const raw = (url ?? "").trim().replace(/\/+$/, "");
  if (!raw.startsWith("https://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (!host) return null;
  if (IPV4_RE.test(host) || host.startsWith("[")) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.port && parsed.port !== "443") return null;
  return `https://${parsed.host}`;
}

/** Расшифровать токен маяка; любая проблема → throw (вызывающий решает, что делать). */
export async function decryptBeaconToken(
  token: string,
  options: BeaconDecodeOptions = {},
): Promise<BeaconPayload> {
  if (!token || !token.startsWith(BEACON_MARKER)) throw new Error("beacon: not a beacon token");
  const rest = token.slice(BEACON_MARKER.length);
  const sep = rest.indexOf(":");
  if (sep < 0) throw new Error("beacon: no kid in token");
  const kid = rest.slice(0, sep);
  const body = rest.slice(sep + 1);

  const keys = options.keys ?? BEACON_KEYS;
  const keyHex = keys[kid];
  if (!keyHex) throw new Error(`beacon: unknown kid '${kid}'`);

  const blob = b64urlToBytes(body);
  if (blob.length < 12 + 16) throw new Error("beacon: payload shorter than nonce+tag");
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);

  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const aad = new TextEncoder().encode(`${BEACON_MARKER}${kid}`);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext),
    );
  } catch {
    throw new Error("beacon: AES-GCM tag mismatch (key/kid/tampered payload)");
  }

  let data: { url?: unknown; ts?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(plaintext)) as { url?: unknown; ts?: unknown };
  } catch {
    throw new Error("beacon: plaintext is not JSON");
  }
  const url = validateBeaconUrl(String(data.url ?? ""));
  if (!url) throw new Error("beacon: invalid server url in payload");
  const ts = Number(data.ts);
  if (!Number.isFinite(ts)) throw new Error("beacon: ts is not a number");

  const now = options.now ?? Date.now();
  const stampMs = ts * 1000;
  if (stampMs - now > BEACON_MAX_FUTURE_MS) throw new Error("beacon: ts is in the future");
  if (now - stampMs > BEACON_MAX_AGE_MS) throw new Error("beacon: beacon payload expired");

  return { url, kid, ts };
}

/**
 * Fail-open обёртка: найти и расшифровать маяк в тексте описания.
 * Любая проблема (нет маркера, битый payload, просрочен, невалидный адрес) →
 * `null` + одна строка в лог (EN). Исключений наружу не бросает.
 */
export async function resolveBeacon(
  text: string,
  options: BeaconDecodeOptions = {},
): Promise<BeaconPayload | null> {
  const token = extractBeaconToken(text);
  if (!token) return null;
  try {
    return await decryptBeaconToken(token, options);
  } catch (e) {
    const reason = (e as { message?: string })?.message ?? String(e);
    console.warn(`[beacon] payload rejected: ${reason}`);
    return null;
  }
}
