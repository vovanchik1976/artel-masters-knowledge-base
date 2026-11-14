/**
 * Политика принудительного обновления Desktop (общая для renderer и main).
 *
 * Контракт манифеста — `GET /updater/latest.json` (блок `electron`):
 *
 * {
 *   "electron": {
 *     "version": "0.5.2",
 *     "notes": "...",
 *     "pub_date": "...",
 *     "platforms": {
 *       "win32-ia32": {"url": "/updater/files/v0.5.2/ARTEL-Electron-...-ia32-setup.exe",
 *                      "sha256": "<64 hex>", "size": 123456789},
 *       "win32-x64":  {...}
 *     }
 *   }
 * }
 *
 * Инварианты:
 *   - ничего не делаем, если блока electron нет (Tauri-only релиз) — `none`;
 *   - мусорный/неполный манифест → `invalid` (вызывающий обязан fail-open:
 *     сеть/сервер не должны «кирпичить» клиент);
 *   - обновление только ВВЕРХ: версия манифеста обязана быть новее текущей;
 *   - URL установщика — относительный от текущего адреса сервера ИЛИ https
 *     на ТОМ ЖЕ host. Чужие схемы/host запрещены.
 *
 * Модуль не импортирует Electron/Node API — покрыт чистыми тестами.
 */

export interface UpdateTarget {
  /** Относительный путь (`/updater/...`) или абсолютный https-URL. */
  url: string;
  /** SHA-256 установщика, нижний регистр hex (64 символа). */
  sha256: string;
  /** Размер файла в байтах (> 0). */
  size: number;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  pubDate: string;
  /** Ключ платформы (`win32-ia32` / `win32-x64`) → цель обновления. */
  targets: Record<string, UpdateTarget>;
}

export type UpdateDecision =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "update";
      version: string;
      notes: string;
      url: string;
      sha256: string;
      size: number;
    };

/** Установщик NSIS ~100 МБ; 2 ГиБ — верхняя граница sanity-проверки. */
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** Строгий semver `X.Y.Z` → [X, Y, Z]; иначе null. */
export function parseSemver(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** candidate строго новее current? Невалидные версии → false. */
export function isNewer(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

/** process.arch → ключ платформы манифеста. Неизвестная арка → null. */
export function platformKey(arch: string): string | null {
  if (arch === "ia32" || arch === "x86") return "win32-ia32";
  if (arch === "x64") return "win32-x64";
  return null;
}

/** Разрешённая форма URL установщика (без резолва). */
function isAllowedUrlShape(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (url.startsWith("//")) return false; // protocol-relative — чужой host
  if (url.startsWith("/")) return true;   // относительный от базы
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function parseTarget(raw: unknown): UpdateTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!isAllowedUrlShape(obj.url)) return null;
  if (typeof obj.sha256 !== "string" || !SHA256_RE.test(obj.sha256.trim())) return null;
  const size = obj.size;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > MAX_INSTALLER_BYTES
  ) {
    return null;
  }
  return {
    url: obj.url,
    sha256: obj.sha256.trim().toLowerCase(),
    size,
  };
}

/**
 * Разобрать манифест. `null` — манифест невалиден целиком.
 * Отсутствие блока `electron` — валидный манифест без целей (Tauri-only).
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const electron = obj.electron;
  if (electron === undefined || electron === null) {
    return {
      version: typeof obj.version === "string" ? obj.version : "",
      notes: "",
      pubDate: "",
      targets: {},
    };
  }
  if (typeof electron !== "object") return null;

  const e = electron as Record<string, unknown>;
  if (!parseSemver(e.version)) return null;
  const platforms = e.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) return null;

  const targets: Record<string, UpdateTarget> = {};
  for (const [key, value] of Object.entries(platforms as Record<string, unknown>)) {
    const target = parseTarget(value);
    if (!target) return null; // любой битый таргет → манифест недоверенный
    targets[key] = target;
  }

  return {
    version: String(e.version).trim(),
    notes: typeof e.notes === "string" ? e.notes : "",
    pubDate: typeof e.pub_date === "string" ? e.pub_date : "",
    targets,
  };
}

/** Решение по обновлению для текущей версии и архитектуры. */
export function decideUpdate(
  raw: unknown,
  currentVersion: string,
  arch: string,
): UpdateDecision {
  if (!raw || typeof raw !== "object") {
    return { kind: "invalid", reason: "manifest is not an object" };
  }
  const electron = (raw as Record<string, unknown>).electron;
  if (electron === undefined || electron === null) return { kind: "none" }; // Tauri-only

  const parsed = parseManifest(raw);
  if (!parsed) return { kind: "invalid", reason: "electron block is malformed" };

  const key = platformKey(arch);
  if (!key) return { kind: "none" };
  const target = parsed.targets[key];
  if (!target) return { kind: "none" }; // эта арка не публиковалась

  if (!isNewer(currentVersion, parsed.version)) return { kind: "none" };

  return {
    kind: "update",
    version: parsed.version,
    notes: parsed.notes,
    url: target.url,
    sha256: target.sha256,
    size: target.size,
  };
}

/**
 * Резолв URL установщика от текущей базы клиента.
 * `null` — URL недопустим (чужая схема/host, битая база).
 */
export function resolveUpdateUrl(baseUrl: string, url: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;

  if (url.startsWith("/") && !url.startsWith("//")) {
    try {
      const resolved = new URL(base.origin + url);
      return resolved.protocol === "https:" ? resolved.toString() : null;
    } catch {
      return null;
    }
  }

  let abs: URL;
  try {
    abs = new URL(url);
  } catch {
    return null;
  }
  if (abs.protocol !== "https:" || abs.origin !== base.origin) return null;
  return abs.toString();
}
