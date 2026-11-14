/** Управление локальным состоянием (auth tokens, настройки, кеш) */

import { invoke } from "@tauri-apps/api/core";
import { normalizeTheme } from "./ui/ThemePresets";

const AUTH_FILE = "auth.json";
const STORAGE_KEY_THEME = "fw_theme";

export interface AuthData {
  access_token: string;
  refresh_token: string;
  tg_id: number;
  username: string;
  /** Telegram API ID — нужен для очистки Grammers-сессии при logout */
  api_id?: number;
  /**
   * Username бота платформы (приходит после TDLib-входа, `pm_bot_username`).
   * Нужен маяку SP-07 S-2: по нему клиент находит описание бота своим TDLib.
   */
  bot_username?: string;
}

/**
 * Кеш адреса сервера (`userData/config.json`, SP-07 S-2).
 *
 * Заполняется, когда клиент нашёл новый адрес через маяк. Нужен, чтобы при
 * следующем запуске не искать маяк заново (кеш читается локально, без сети).
 */
export interface ServerUrlCache {
  server_url?: string;
  beacon_ts?: number;
  beacon_kid?: string;
}

const CONFIG_FILE = "config.json";

/**
 * Кеш app-state и upload form schema для offline/degraded режима.
 * Desktop сохраняет последнюю схему/state, чтобы показывать fallback
 * при недоступности сервера.
 */
export interface CachedAppState {
  data: any;           // сырой JSON ответа /desktop/app-state
  timestamp: number;   // Date.now() при сохранении
}

export interface CachedUploadSchema {
  data: any;           // сырой JSON ответа /desktop/forms/upload
  timestamp: number;
}

const CACHE_KEYS = {
  APP_STATE: "cached_app_state",
  UPLOAD_SCHEMA: "cached_upload_schema",
};

/** Максимальный возраст кеша: 1 час (в мс) */
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export class Store {
  private data: AuthData | null = null;

  async load(): Promise<AuthData | null> {
    try {
      const json = await invoke<string>("read_auth_file");
      this.data = JSON.parse(json) as AuthData;
      return this.data;
    } catch {
      this.data = null;
      return null;
    }
  }

  async save(auth: AuthData): Promise<void> {
    this.data = auth;
    await invoke("write_auth_file", {
      content: JSON.stringify(auth, null, 2),
    });
  }

  async clear(): Promise<void> {
    this.data = null;
    try {
      await invoke("remove_auth_file");
    } catch {
      // file may not exist
    }
  }

  get(): AuthData | null {
    return this.data;
  }

  isAuthenticated(): boolean {
    return this.data !== null && !!this.data.access_token;
  }

  // ── Пресет оформления (хранится в localStorage) ──
  /** Прочитать сохранённый пресет: artel | paper | photon | hud (старые цветовые → artel). */
  getTheme(): string {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY_THEME));
    } catch { /* ignore */ }
    return 'artel';
  }
  /** Сохранить пресет и вернуть нормализованное значение. */
  setTheme(theme: string): string {
    const next = normalizeTheme(theme);
    try { localStorage.setItem(STORAGE_KEY_THEME, next); } catch { /* ignore */ }
    return next;
  }

  // ── App State Cache ──

  /** Сохранить app state в localStorage (Tauri WebView) */
  saveAppState(state: any): void {
    try {
      const cached: CachedAppState = {
        data: state,
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEYS.APP_STATE, JSON.stringify(cached));
    } catch (e) {
      console.warn("Failed to cache app state:", e);
    }
  }

  /** Загрузить кешированный app state (null если нет или过期) */
  loadAppState(): CachedAppState | null {
    try {
      const raw = localStorage.getItem(CACHE_KEYS.APP_STATE);
      if (!raw) return null;
      const cached: CachedAppState = JSON.parse(raw);
      // Проверка возраста кеша
      if (Date.now() - cached.timestamp > CACHE_MAX_AGE_MS) {
        localStorage.removeItem(CACHE_KEYS.APP_STATE);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  /** Получить app state из кеша (без timestamp) */
  getCachedAppState(): any | null {
    const cached = this.loadAppState();
    return cached ? cached.data : null;
  }

  // ── Upload Schema Cache ──

  /** Сохранить upload form schema в localStorage */
  saveUploadSchema(schema: any): void {
    try {
      const cached: CachedUploadSchema = {
        data: schema,
        timestamp: Date.now(),
      };
      localStorage.setItem(CACHE_KEYS.UPLOAD_SCHEMA, JSON.stringify(cached));
    } catch (e) {
      console.warn("Failed to cache upload schema:", e);
    }
  }

  /** Загрузить кешированную upload schema (null если нет или过期) */
  loadUploadSchema(): CachedUploadSchema | null {
    try {
      const raw = localStorage.getItem(CACHE_KEYS.UPLOAD_SCHEMA);
      if (!raw) return null;
      const cached: CachedUploadSchema = JSON.parse(raw);
      if (Date.now() - cached.timestamp > CACHE_MAX_AGE_MS) {
        localStorage.removeItem(CACHE_KEYS.UPLOAD_SCHEMA);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  /** Получить upload schema из кеша */
  getCachedUploadSchema(): any | null {
    const cached = this.loadUploadSchema();
    return cached ? cached.data : null;
  }

  // ── Server URL cache (userData/config.json, SP-07 S-2) ──

  /**
   * Прочитать кеш адреса сервера. Любая проблема (нет файла, битый JSON) → null:
   * кеш — оптимизация, а не источник истины.
   */
  async loadServerUrlCache(): Promise<ServerUrlCache | null> {
    try {
      const raw = await invoke<string>("read_config_file");
      const parsed = JSON.parse(raw) as ServerUrlCache;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Сохранить адрес, найденный через маяк (best-effort: ошибка не ломает работу). */
  async saveServerUrlCache(cache: ServerUrlCache): Promise<void> {
    try {
      await invoke("write_config_file", { content: JSON.stringify(cache, null, 2) });
    } catch (e) {
      console.warn(`[store] ${CONFIG_FILE} write failed:`, e);
    }
  }

  // ── Degraded mode check ──

  /**
   * Проверить, можно ли работать в degraded/offline режиме.
   * Если кеша нет — лучше заблокировать upload/download,
   * так как нельзя гарантировать актуальные лимиты и баланс.
   */
  hasCachedState(): boolean {
    return this.getCachedAppState() !== null;
  }
}

/** Глобальный экземпляр store */
export const store = new Store();
