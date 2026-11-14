/**
 * SP-07 S-2 — Silent Beacon: политика резервного адреса сервера (D-006 pull-only).
 *
 * Модуль отвечает на три вопроса и НИЧЕГО не отправляет сам:
 *   1. когда вообще пробовать маяк (backoff + лимит попыток);
 *   2. что считать обрывом транспорта (а что — живым сервером с ошибкой);
 *   3. в каком порядке искать новый адрес: локальный кеш → маяк в описании бота.
 *
 * Всё чистое и с инъекцией зависимостей: чтение описания бота (TDLib) и запись
 * кеша живут в вызывающем коде, поэтому политика тестируется без сети и движка.
 */
import { resolveBeacon, validateBeaconUrl, type BeaconPayload } from "../beacon";

/** Окна ожидания между попытками (мс): первая — сразу, далее 5 и 30 минут. */
export const BEACON_BACKOFF_MS: readonly number[] = [0, 5 * 60 * 1000, 30 * 60 * 1000];

/** Больше попыток за сессию не делаем (иначе клиент «долбит» Telegram). */
export const MAX_BEACON_ATTEMPTS = BEACON_BACKOFF_MS.length;

export interface BeaconState {
  attempts: number;
  lastAttemptAt: number;
}

/** Кеш адреса (`userData/config.json`): последний адрес, полученный из маяка. */
export interface ServerUrlCache {
  server_url?: string;
  beacon_ts?: number;
  beacon_kid?: string;
}

export function createBeaconState(): BeaconState {
  return { attempts: 0, lastAttemptAt: 0 };
}

/** Разрешена ли попытка маяка сейчас. */
export function shouldAttemptBeacon(state: BeaconState, nowMs: number): boolean {
  if (state.attempts >= MAX_BEACON_ATTEMPTS) return false;
  const index = Math.min(state.attempts, BEACON_BACKOFF_MS.length - 1);
  return nowMs - state.lastAttemptAt >= BEACON_BACKOFF_MS[index];
}

/** Зафиксировать попытку (вызывается ПЕРЕД обращением к TDLib). */
export function registerBeaconAttempt(state: BeaconState, nowMs: number): BeaconState {
  return { attempts: state.attempts + 1, lastAttemptAt: nowMs };
}

/**
 * Обрыв транспорта ли это? Маяк нужен только когда сервер НЕДОСТУПЕН.
 *
 * Ответ сервера (4xx/5xx) — это живой сервер: адрес менять нельзя, иначе
 * переключение уведёт клиента в сторону от работающего backend'а.
 */
export function isTransportFailure(err: unknown): boolean {
  const name = String((err as { name?: string })?.name ?? "");
  const message = String((err as { message?: string })?.message ?? err ?? "");
  if (/abort/i.test(name) || /abort/i.test(message)) return true;
  if (/^\s*API \d{3}/.test(message)) return false;
  if (err instanceof TypeError) return true;
  return /failed to fetch|network|load failed|timed? ?out|ENOTFOUND|ECONNREFUSED|socket/i.test(
    message,
  );
}

export interface FallbackInput {
  /** Локальный кеш адреса (если есть) — проверяется ДО обращения к TDLib. */
  cached?: ServerUrlCache | null;
  /** Чтение описания бота (TDLib). Бросает, если движок не авторизован и т.п. */
  readDescription: () => Promise<string>;
  /** Расшифровка маяка (по умолчанию `resolveBeacon`). */
  resolve?: (text: string, options?: { now?: number }) => Promise<BeaconPayload | null>;
  /** Валидация адреса (по умолчанию `validateBeaconUrl`). */
  validateUrl?: (url: string) => string | null;
  now?: number;
  log?: (message: string) => void;
}

export interface FallbackResult {
  url: string;
  source: "cache" | "beacon";
  /** Для source === "beacon": kid/ts из payload — кладутся в кеш `config.json`. */
  kid?: string;
  ts?: number;
}

/**
 * Найти резервный адрес сервера: кеш → маяк → `null` (fail-open).
 *
 * Никогда не бросает: недоступность TDLib, битый маяк и невалидный адрес — это
 * штатные ситуации, при которых клиент просто остаётся на текущем адресе.
 */
export async function findFallbackServerUrl(input: FallbackInput): Promise<FallbackResult | null> {
  const log = input.log ?? ((message: string) => console.warn(`[beacon] ${message}`));
  const validate = input.validateUrl ?? validateBeaconUrl;

  const cachedRaw = input.cached?.server_url ?? "";
  if (cachedRaw) {
    const cachedUrl = validate(cachedRaw);
    if (cachedUrl) {
      log("using cached server url");
      return { url: cachedUrl, source: "cache" };
    }
    log("cached server url rejected by validation");
  }

  let description = "";
  try {
    description = await input.readDescription();
  } catch (e) {
    log(`bot description read failed: ${(e as { message?: string })?.message ?? String(e)}`);
    return null;
  }

  const resolve = input.resolve ?? resolveBeacon;
  let payload: BeaconPayload | null = null;
  try {
    payload = await resolve(description, { now: input.now });
  } catch (e) {
    log(`beacon decode failed: ${(e as { message?: string })?.message ?? String(e)}`);
    payload = null;
  }
  if (!payload) {
    log("no usable beacon in bot description");
    return null;
  }

  const url = validate(payload.url);
  if (!url) {
    log("beacon url rejected by validation");
    return null;
  }
  log("beacon resolved a new server address");
  return { url, source: "beacon", kid: payload.kid, ts: payload.ts };
}
