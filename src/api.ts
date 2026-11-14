import type { ChatNotificationPage } from "../shared/chatAlertPolicy";
import type { CommunityThread, EntryPage, ThreadPage, EntryIntent, PresencePage } from "./community";
/** API клиент для взаимодействия с сервером Contabo */

import type { CatalogTree } from "./search/CatalogTree";
import { isTransportFailure } from "./ui/BeaconPolicy";

// ── Auth ──

/** Ответ POST /desktop/auth/credentials (first-run, Zero Secrets in Binary).
 *
 * Pair-код удалён (2026-09-22): свежая установка получает api_id/api_hash сразу
 * и входит обычной авторизацией Telegram (телефон/QR), как в dev/e2e.
 * Ошибки: client_required | disabled | not_configured | invalid_json | rate_limited. */
export interface DesktopCredentialsResponse {
  ok: boolean;
  error?: string;
  telegram_api_id?: number;
  telegram_api_hash?: string;
}

export interface WidgetLoginStartResponse {
  ok: boolean;
  error?: string;
  attempt_key?: string;
  status?: "requested" | "confirmed" | "failed" | "expired";
  expires_in?: number;
}

export interface WidgetLoginStatusResponse {
  ok: boolean;
  error?: string;
  status?: "requested" | "confirmed" | "failed" | "expired";
  login_status?: "waiting_token" | "link_sent" | "send_failed" | "finished";
  expires_in?: number;
}

/** Источник сводки (SP-19 S1): форум-URL карточки либо `path:start-end`. */
export interface CardSourcePayload {
  path: string;
  url: string;
  title?: string;
  score?: number;
}

/** Соседний файл в блоке «что ещё скачать» под карточкой (SP-19 S1b). */
export interface CardStorageItem {
  id: number;
  brand: string;
  model: string;
  version: string;
  size_bytes: number;
  content_kind: string;
  download_strategy: string;
  /** 1 — та же модель, 2 — то же шасси (решает серверный SQL). */
  /** 1 — та же модель, 2 — то же шасси, 3 — тот же бренд (решает сервер). */
  tier: number;
}

/** Опыт мастера под сводкой (SP-19 S4): «что помогло» + голоса разных мастеров. */
export interface CardFormEntry {
  dm_id: number;
  text: string;
  votes: number;
  verified: boolean;
  mine: boolean;
}


export interface AuthPairResponse {
  success: boolean;
  access_token: string;
  refresh_token: string;
  tg_id: number;
  is_banned?: boolean;
  ban_reason?: string;
  storage_chat_id?: string | null;
  storage_chat_invite_link?: string | null;
  /** Host-Mediation: id бота (user id) для auto-/start — открыть PM и отправить /start. */
  pm_bot_chat_id?: number | null;
  /** Host-Mediation: username бота для TDLib searchPublicChat (BUG-AUTO-START-002). */
  pm_bot_username?: string | null;
}

// ── Upload ──

export interface UploadInitRequest {
  user_tg_id: number;
  brand: string;
  model: string;
  version: string;
  description?: string;
  /** Клас контенту: firmware (default) | documentation | software (SPEC CONTENT_KINDS). */
  content_kind?: string;
  /** software — назва софту (обов'язкове для kind=software). */
  title?: string;
  /** documentation — тип документації. */
  doc_type?: string;
  // Upload form v2 fields (optional — для метаданих)
  category?: string;
  chassis?: string;
  chipset?: string;
  memory_type?: string;
  programmer?: string;
  firmware_type?: string;
  source_status?: string;
  panel_model?: string;
  /** SP-31 (D-165): тип железа original | china_clone (дефолт сервера — original). */
  hardware_type?: string;
  total_parts: number;
  total_size: number;
  manifest_json?: string;
  /** Per-user Pyrogram session_string для MTProto upload от имени пользователя */
  session_string?: string;
  /** Личное хранилище: 'public' (по умолчанию) | 'personal' (остаётся в PM). */
  mode?: "public" | "personal";
}

export interface UploadInitResponse {
  upload_id: string;
  expires_at: string; // ISO date string
  // ── Пре-дедуп (BUG-PRE-DEDUP-001): сервер нашёл такой же файл в каталоге
  //    ДО загрузки байтов. upload_id при этом ОТСУТСТВУЕТ (job не создавался).
  //    Клиент должен остановиться и показать message, НЕ качать файл.
  duplicate?: boolean;
  file_id?: number;
  message?: string;
  mode?: "streaming" | "pipe" | "disk_spool"; // Режим загрузки
  // Direct Upload Gateway (Вариант B)
  upload_token?: string; // Токен для аутентификации прямого upload (nginx /bot-api/)
  bot_api_url?: string; // URL для прямого upload (nginx /bot-api/ endpoint)
  storage_chat_id?: string; // ID чата хранения для sendDocument
  // Host-Mediation (ADR 2026-09-02): если задан — upload идёт в PM с ботом
  // (id бота), а не в storage-чат. Юзер НЕ участник Vault.
  pm_chat_id?: string;
  // ── Host-PM staging (вариант 1, 2026-09-17) ──
  // Присутствует, когда сервер включил скрытый PM user↔Host (HOST_PM_UPLOAD_ENABLED).
  // Клиент обязан сам резолвить chat_id через TDLib `tdlib_resolve_private_chat`
  // (Host — ПОЛЬЗОВАТЕЛЬ, а не бот: Bot-API chat_id здесь неприменим).
  host_chat_id?: number | null;
  host_username?: string | null;
  message_thread_id?: number; // ID топика (brand topic) для sendDocument
  // Fast Lane: прямой URL для data-plane upload (в обход nginx)
  // Используется для A/B тестирования: nginx (8080) vs direct admin (8081)
  upload_url?: string; // URL для PUT запросов частей (streaming режим)
  // Phase 3 — Direct MTProto Upload: размер одного volume в байтах.
  // Desktop-клиент (Rust) режет файл на volumes этого размера.
  // Значение: config.DIRECT_UPLOAD_MAX_VOLUME_BYTES (default 2GB).
  /** part_max_bytes из сервера — макс. размер одной части (snake_case, т.к. from Python dataclass) */
  part_max_bytes?: number;
}


export interface UploadCompleteResponse {
  status: string; // "completed"
  received_parts: number;
  total_parts: number;
  upload_id: string;
  file_id?: number; // DB primary key file.id — создан на сервере при init
  /** Host-Mediation (ADR): true → сервер перенёс файл в Vault; клиенту пора
   *  self-delete своего upload-сообщения в PM (tdlib_delete_messages). */
  vaulted?: boolean;
  parts_meta?: Array<{
    index: number;
    tg_file_id?: string;
    tg_file_unique_id?: string;
    telegram_message_id?: number;
    server_sha256?: string;
    client_sha256?: string;
    size?: number;
  }>; // Метаданные каждой части (pipe-режим)
}

export interface UploadAnchoredPart {
  /** Байтовое окно, УЖЕ лежащее в Vault (skip для Resume). */
  offset: number;
  part_index: number;
  size: number;
  vault_chat_id: number | null;
  vault_message_id: number | null;
}

export interface UploadStatusResponse {
  upload_id: string;
  status: string;
  user_tg_id: number;
  total_parts: number;
  total_size: number;
  /** Skip-множество: заякоренные части (Vault = источник истины). */
  anchored_parts: UploadAnchoredPart[];
  pm_chat_id?: number | null;
  message_thread_id?: number | null;
  archive_path?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  // legacy/backward-compat
  received_parts?: number;
  vault_parts_meta?: any;
}

// ── Download ──

/** MTProto metadata for a single part (Direct Download, Plan B) */
export interface DownloadPartMtprotoMeta {
  /** document_id передаётся строкой, т.к. Python может сериализовать unsigned 64-bit > Number.MAX_SAFE_INTEGER */
  mtproto_document_id: string;
  /** access_hash передаётся строкой — JS number (f64) теряет точность для int64 > 2^53 */
  mtproto_access_hash: string;
  mtproto_file_reference: string; // base64-encoded
  mtproto_dc_id: number;
  /** Chat ID для восстановления file_reference (FILE_REFERENCE_EXPIRED recovery) */
  mtproto_chat_id?: number;
  /** Message ID для восстановления file_reference */
  mtproto_message_id?: number;
}

/**
 * Host-Mediation PM-Lease (BUG-DOWNLOAD-051): координаты delivery-сообщения
 * части в PM юзера. Клиент резолвит document СВОЕЙ сессией (getMessage →
 * getChatHistory) — Vault-якорь (`tg_file_id`) в сессии юзера не резолвится
 * (`getRemoteFile → 400 Invalid remote file identifier`).
 */
export interface DownloadPmDelivery {
  /** PM юзера с ботом С ТОЧКИ ЗРЕНИЯ КЛИЕНТА (id бота). */
  chat_id: number;
  /**
   * bot-side message_id delivery-сообщения. ⚠️ BUG-DOWNLOAD-052: клиентский
   * TDLib видит `message.id` как `real << 20` — Rust пробует id и его сдвиги.
   */
  message_id: number;
  size?: number;
  order?: number;
  /**
   * BUG-DOWNLOAD-052: `tg_file_unique_id` документа доставки — сессионно-
   * независимый ключ части (TDLib `remote.unique_id`). Различает части с
   * ОДИНАКОВЫМ размером и не сбивается посторонними документами в истории PM.
   */
  unique_id?: string;
}

export interface DownloadPartInfo {
  index: number;
  name: string;
  size: number;
  sha256: string;
  tg_file_id: string;
  /** BUG-DOWNLOAD-052: `tg_file_unique_id` документа части (стабильный ключ). */
  unique_id?: string;
  /** MTProto metadata for direct download (optional — only present when server has it) */
  mtproto?: DownloadPartMtprotoMeta;
  /** PM-якорь доставки (только pm_lease) — BUG-DOWNLOAD-051. */
  pm_delivery?: DownloadPmDelivery;
}

export interface DownloadInitResponse {
  download_id: string;
  manifest: any;
  parts: Array<DownloadPartInfo>;
  /** Hint from server: which download backend is recommended */
  download_backend?: "server_transit" | "mtproto_direct";
  /**
   * BUG-DOWNLOAD-010: Явный маркер стратегии скачивания от бэкенда.
   * 'single' — файл до 2GB (одна часть), прямой TDLib downloadFile.
   * 'multi' — файл >2GB, разбит на части, composite download.
   * Фронтенд должен использовать ЭТО поле, а не определять стратегию
   * по количеству remoteParts.length.
   */
  download_strategy: "single" | "multi";
  /**
   * BUG-CROSS-USER-DOWNLOAD-002: invite link для joinChatByInviteLink fallback.
   * Если joinChat не удаётся (Chat not found), клиент пробует присоединиться
   * через invite link. Передаётся из config.STORAGE_CHAT_INVITE_LINK.
   */
  storage_chat_invite_link?: string;
  /**
   * Host-Mediation (ADR PM-Lease): true → активен host-медиационный путь.
   * ВНИМАНИЕ: с 2026-09-06 `init` — ТОЛЬКО подготовка: файл в PM ещё НЕ
   * доставлен, баллы НЕ списаны. Координаты PM-доставки клиент получает из
   * POST /desktop/downloads/{id}/start ПОСЛЕ подтверждения цены.
   */
  host_mediation?: boolean;
  /**
   * Legacy: true → (до split) файл уже доставлен ботом в PM юзера.
   * После split отсутствует в ответе init (заменено на host_mediation).
   */
  host_delivery?: boolean;
  /**
   * Цена для подтверждения ДО `start` (ADR PM-Lease §4.5). При active-lease
   * reuse сервер возвращает cost=0 (повторное списание не выполняется).
   */
  price?: DownloadPriceInfo;
  /** Retry/idempotency: init нашёл активную started-сессию (user,file) и вернул
   *  её download_id (без создания нового job / повторного списания). */
  reused_active_lease?: boolean;
  /** Settlement при выдаче (legacy init-путь; после split — в `start`). */
  billing?: DownloadBillingInfo;
}

/** Цена скачивания (ADR PM-Lease): клиент показывает подтверждение ДО `start`. */
export interface DownloadPriceInfo {
  /** Эффективная стоимость для данного юзера (0 — self/owner/unlimited/reuse). */
  cost: number;
  is_free: boolean;
  note?: string | null;
}

/** Ответ POST /desktop/downloads/{id}/start (charge-then-deliver). */
export interface DownloadStartResponse {
  download_id: string;
  /** "started" | "downloading" (retry reuse). */
  status: string;
  /** Координаты частей для скачивания (host → PM-доставка). */
  parts: Array<DownloadPartInfo>;
  /** true → coords указывают на PM юзера, join чата не нужен. */
  host_delivery?: boolean;
  /** Результат settlement: charged/balance_after/passive_income_credited. */
  billing?: DownloadBillingInfo;
  lease_expires_at?: string | null;
}

/** Результат settlement при выдаче (download/init, host-режим). */
export interface DownloadBillingInfo {
  success: boolean;
  /** 0 — self/free download; иначе стоимость скачивания (списано). */
  charged: number;
  self?: boolean;
  balance_before?: number;
  balance_after?: number;
  passive_income_credited?: number;
  note?: string;
}


// ── Phase 4: Zero-Stitch Download Context ──

/** Volume metadata for direct MTProto download (Zero-Stitch). */
export interface VolumeMeta {
  index: number;
  document_id: string;
  access_hash: string;
  file_reference: string;
  dc_id: number;
  size: number;
}

/** Response from GET /desktop/downloads/context/{file_id} */
export interface DownloadContextResponse {
  file_id: number;
  filename: string;
  total_size: number;
  volumes: VolumeMeta[];
  /** TDLib-compatible tg_file_ids для каждого volume (download) */
  tg_file_ids?: string[];
}

/** Request body for POST /desktop/downloads/refresh-volume/{file_id} */
export interface VolumeRefreshRequest {
  volume_index: number;
  doc_id: string;
  access_hash: string;
}

/** Response from POST /desktop/downloads/refresh-volume/{file_id} */
export interface VolumeRefreshResponse {
  doc_id: string;
  access_hash: string;
  file_reference: string;
  dc_id: number;
}

// ── Retry helper ──

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Обёртка с exponential backoff для сетевых операций.
 * Не применять к идемпотентным операциям (complete).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: { maxRetries?: number; isRetryable?: (err: Error) => boolean },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  const isRetryable =
    options?.isRetryable ??
    ((err: Error) => {
      // Retry только на сетевые ошибки и 5xx
      if (err.message.includes("fetch")) return true;
      if (err.message.startsWith("API 5")) return true;
      return false;
    });

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr!;
}

// ── API Client ──

/**
 * Ответ POST /desktop/tools/geo-unlock/grant (D-150, D-151).
 *
 * `kind` — тип выдачи: `owner` (владелец, без списания), `package` (действующий
 * пакет мастера — цена операции и есть срок пакета, баллы не списываются),
 * `trial` (бесплатная попытка), `paid` (зарезервировано: отдельной цены в баллах нет).
 */
export interface GeoUnlockGrantResponse {
  id: string;
  kind: "owner" | "package" | "trial" | "paid";
  tool: string;
  /** Сколько бесплатных попыток осталось ПОСЛЕ этой выдачи. */
  trial_left: number;
  /** Действующий лимит бесплатных попыток (настройка админки). */
  trial_limit: number;
  /**
   * Сколько разблокировок пакета осталось ПОСЛЕ этой операции (D-173).
   * `null` — выдача не по пакету (owner/trial) либо пакет без ограничения.
   */
  package_unlocks_left: number | null;
}

/**
 * Ответ GET /desktop/tools/geo-unlock/status (D-173).
 *
 * `kind` — состояние доступа БЕЗ выдачи grant'а: `owner` (владелец),
 * `package` (действующий пакет утилиты), `trial` (остались бесплатные попытки),
 * `none` (инструмент закрыт: нужен пакет).
 */
export interface GeoUnlockStatusResponse {
  kind: "owner" | "package" | "trial" | "none";
  /** Остаток разблокировок пакета; `null` — безлимит или это не пакет. */
  unlocks_left: number | null;
  trial_left: number;
  trial_limit: number;
  tool: string;
}

export class ApiClient {
  private baseUrl: string;
  /** Активный trace_id для текущей сессии download — передаётся в X-Trace-Id header */
  private _traceId: string = "";
  private accessToken: string | null = null;

  /**
   * Callback при 401 Unauthorized.
   * Устанавливается из App.init() — при получении 401 принудительно
   * показывает страницу авторизации.
   */
  onUnauthorized: (() => void) | null = null;

  /**
   * Хук «сервер недоступен» (SP-07 S-2, Silent Beacon).
   *
   * Вызывается ТОЛЬКО при сбое ТРАНСПОРТА (fetch не дошёл / таймаут). Если сервер
   * ответил (даже 500), адрес рабочий — переключаться нельзя. Возвращает новый
   * base URL либо `null` (fail-open: остаёмся на прежнем адресе).
   */
  onServerUnreachable: ((failedUrl: string) => Promise<string | null>) | null = null;

  /**
   * Базовый URL backend'а.
   * Дефолт — канонический домен (SP-07/D-009): адрес резолвится через
   * DuckDNS-имя за Caddy, а не через сырой IP. Сырой IP в дефолте делал все
   * установленные клиенты «кирпичом» при смене адреса VPS (без пересборки и
   * релиза адрес не поменять).
   * Переопределяется `VITE_SERVER_URL` (dev-стенды: `.env` / `.env.local`,
   * релиз при необходимости — `.env.production`).
   */
  constructor(baseUrl: string = import.meta.env.VITE_SERVER_URL || "https://tv-firmware.duckdns.org") {
    this.baseUrl = baseUrl;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Переключить адрес сервера (SP-07 S-2: после успешного чтения маяка). */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  setToken(token: string | null) {
    // BUG-AUTH-015: диагностика жизненного цикла токена
    if (token === null) {
      console.debug("[ApiClient] setToken: CLEARED (token=null)");
    } else if (!token) {
      console.warn("[ApiClient] setToken: INVALID token (falsy value)", token);
    } else {
      console.debug("[ApiClient] setToken: OK", `token=${token.slice(0, 20)}...`);
    }
    this.accessToken = token;
  }

  getToken(): string | null {
    return this.accessToken;
  }

  /** Установить trace_id для сквозного логирования (X-Trace-Id header) */
  setTraceId(traceId: string): void {
    this._traceId = traceId;
  }

  /** Сбросить trace_id */
  clearTraceId(): void {
    this._traceId = "";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: any,
    rawBody?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    const hasToken = !!this.accessToken;
    // BUG-AUTH-015: логируем статус токена при каждом запросе (кроме health)
    if (path !== "/health") {
      console.debug("[ApiClient] request", `${method} ${path}`, hasToken ? `token=${this.accessToken!.slice(0, 16)}...` : "NO_TOKEN");
    }
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    if (this._traceId) {
      headers["X-Trace-Id"] = this._traceId;
    }

    // BUG-AUTH-NO-TGID: таймаут на HTTP-запрос. Без него fetch к недоступному
    // серверу (или зависшему nginx/backend) НИКОГДА не резолвится, из-за чего
    // _pairingPromise в _doApiPairing() навсегда остаётся pending и блокирует
    // повторный вход (AWAIT existing). По умолчанию 30с, если caller не передал
    // собственный signal (используется только для длительных download-part).
    // SP-07 S-2: при сбое транспорта — ОДНА повторная попытка на резервном адресе,
    // который вернул хук onServerUnreachable (маяк из описания бота).
    let res: Response;
    try {
      res = await this.fetchOnce(path, method, headers, body, rawBody, signal, timeoutMs);
    } catch (e) {
      const failedUrl = this.baseUrl;
      if (!this.onServerUnreachable || !isTransportFailure(e)) throw e;
      const next = await this.onServerUnreachable(failedUrl).catch((err) => {
        console.warn("[ApiClient] beacon lookup failed:", err);
        return null;
      });
      if (!next || next === failedUrl) throw e;
      console.warn(`[ApiClient] transport failure → switching server url (${failedUrl} → ${next})`);
      this.setBaseUrl(next);
      res = await this.fetchOnce(path, method, headers, body, rawBody, signal, timeoutMs);
    }

    if (!res.ok) {
      // 401 Unauthorized — токен истёк или desktop_sessions очищена
      if (res.status === 401 && this.onUnauthorized) {
        this.onUnauthorized();
      }
      const text = await res.text();
      // status НА ошибка (а не только в тексте): клиент различает 401/429
      // (экран квоты) / 400 / 5xx — иначе всегда generic «Ошибка сети».
      throw Object.assign(new Error(`API ${res.status}: ${text}`), {
        status: res.status,
      });
    }

    // Таймаут/AbortController обеих попыток уже погашены внутри fetchOnce().
    return res.json();
  }

  /**
   * Один HTTP-запрос со своим таймаутом (30с) либо внешним signal.
   *
   * Вынесен из `request`: после сбоя транспорта маяк может дать новый адрес, и
   * повторная попытка обязана идти с ЧИСТЫМ таймаутом и свежим AbortController
   * (прежний к этому моменту уже сработал, повторный fetch с ним падал бы сразу).
   */
  private async fetchOnce(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
    rawBody: boolean | undefined,
    external?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    let timeoutId: number | undefined;
    let abortHandler: (() => void) | undefined;
    if (external) {
      // Уважаем внешний signal (для длительных операций) — без собственного таймаута
      if (external.aborted) controller.abort();
      else {
        abortHandler = () => controller.abort();
        external.addEventListener("abort", abortHandler);
      }
    } else {
      timeoutId = window.setTimeout(() => controller.abort(), timeoutMs ?? 30000);
    }

    const options: RequestInit = { method, headers, body: undefined, signal: controller.signal };
    if (body !== undefined) {
      if (rawBody) {
        options.body = body as BodyInit;
      } else {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
    }

    try {
      return await fetch(`${this.baseUrl}${path}`, options);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (external && abortHandler) external.removeEventListener("abort", abortHandler);
    }
  }

  /** Отправка запроса с ответом в виде ArrayBuffer (для скачивания) */
  private async requestBuffer(
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      signal,
    });
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthorized) {
        this.onUnauthorized();
      }
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    return res.arrayBuffer();
  }

  // ── Auth ──

  /**
   * POST /desktop/auth/credentials — api_id/api_hash для свежей установки.
   *
   * Bearer здесь невозможен: DesktopSession появляется только ПОСЛЕ TDLib-входа.
   * Защита на сервере: client-key в теле + лимит по реальному IP + kill-switch.
   * Единый путь и для dev-стендов (e2e-prod.sh / e2e-prod32.sh), и для релиза.
   */
  async getDesktopCredentials(): Promise<DesktopCredentialsResponse> {
    return this.request<DesktopCredentialsResponse>(
      "POST",
      "/desktop/auth/credentials",
      { client: "fw-cloud-desktop/1" },
    );
  }

  /** Widget fallback: OAuth подтверждает аккаунт, TDLib token принимается телефоном. */
  async widgetLoginStart(phone: string): Promise<WidgetLoginStartResponse> {
    return this.request<WidgetLoginStartResponse>("POST", "/desktop/auth/widget/start", {
      client: "fw-cloud-desktop/1", phone,
    });
  }

  async widgetLoginToken(attemptKey: string, loginToken: string): Promise<{ok: boolean; error?: string}> {
    return this.request("POST", "/desktop/auth/widget/token", {
      client: "fw-cloud-desktop/1", attempt_key: attemptKey, login_token: loginToken,
    });
  }

  async widgetLoginStatus(attemptKey: string): Promise<WidgetLoginStatusResponse> {
    return this.request<WidgetLoginStatusResponse>("POST", "/desktop/auth/widget/status", {
      client: "fw-cloud-desktop/1", attempt_key: attemptKey,
    });
  }

  async widgetLoginFinish(attemptKey: string): Promise<{ok: boolean; error?: string}> {
    return this.request("POST", "/desktop/auth/widget/finish", {
      client: "fw-cloud-desktop/1", attempt_key: attemptKey,
    });
  }

  // ── Upload ──

  async uploadInit(data: UploadInitRequest): Promise<UploadInitResponse> {
    return this.request<UploadInitResponse>(
      "POST",
      "/desktop/uploads/init",
      data,
    );
  }




  /**
   * Завершить upload-сессию.
   *
   * @param uploadId — ID сессии
   * @param options.upload_route — "direct" для MTProto (вызовет /api/uploads/... с document_meta)
   * @param options.document_meta — метаданные MTProto-частей из Rust result
   *
   * Маршрутизация:
   *   upload_route === "direct" → POST /api/uploads/{uploadId}/complete
   *   иначе                   → POST /desktop/uploads/{uploadId}/complete
   */
  async uploadComplete(
    uploadId: string,
    options?: { upload_route?: string; document_meta?: object; original_name?: string },
  ): Promise<UploadCompleteResponse> {
    const endpoint = `/desktop/uploads/${uploadId}/complete`;

    if (options?.document_meta) {
      const body: Record<string, any> = {
        upload_route: options.upload_route || "direct",
        document_meta: options.document_meta,
      };
      if (options.original_name) {
        body.original_name = options.original_name;
      }
      return this.request<UploadCompleteResponse>("POST", endpoint, body);
    }

    // Без document_meta — стандартный resumable
    return this.request<UploadCompleteResponse>("POST", endpoint);
  }

  async uploadStatus(uploadId: string): Promise<UploadStatusResponse> {
    return this.request<UploadStatusResponse>(
      "GET",
      `/desktop/uploads/${uploadId}`,
    );
  }

  async cancelUpload(uploadId: string): Promise<void> {
    await this.request("POST", `/desktop/uploads/${uploadId}/cancel`);
  }

  /** Resume: job → uploading; ответ = статус + skip-множество (anchored_parts). */
  async resumeUpload(uploadId: string): Promise<UploadStatusResponse> {
    return this.request<UploadStatusResponse>(
      "POST",
      `/desktop/uploads/${uploadId}/resume`,
    );
  }

  /**
   * Poll completion status after 202 Accepted from /complete.
   * Returns:
   *   200 → completed result (same shape as UploadCompleteResponse)
   *   202 → still processing { status, upload_id, progress_pct }
   *   500 → failed { status: "failed", error }
   *   404 → not found
   */
  async uploadCompleteStatus(
    uploadId: string,
  ): Promise<UploadCompleteResponse> {
    return this.request<UploadCompleteResponse>(
      "GET",
      `/desktop/uploads/${uploadId}/complete-status`,
    );
  }

  /**
   * Phase 4 (гигиена PM): координаты старого (>48ч) мусора в PM юзера.
   * Бот удалить их уже не может — удаляет клиент (свои сообщения, revoke).
   * null = сервер недоступен/неавторизован — клиент просто пропускает свип.
   */
  async getOldPmCleanup(): Promise<{
    items: Array<{ chat_id: number; message_ids: number[] }>;
    total?: number;
  } | null> {
    try {
      return await this.request<{
        items: Array<{ chat_id: number; message_ids: number[] }>;
        total?: number;
      }>("GET", "/desktop/pm/cleanup");
    } catch {
      return null;
    }
  }

  // ── Download ──

  async downloadInit(fileId: number): Promise<DownloadInitResponse> {
    return this.request<DownloadInitResponse>(
      "POST",
      "/desktop/downloads/init",
      { file_id: fileId },
    );
  }

  /**
   * POST /desktop/downloads/{downloadId}/start — запуск скачивания (ADR PM-Lease).
   *
   * Вызывается ПОСЛЕ выбора пути и подтверждения цены (init вернул price.cost).
   * Сервер: атомарный settlement → host-delivery Vault→PM → job=started,
   * balance_charged=captured, lease_expires_at=now+TTL. Возвращает координаты
   * частей (PM-доставку), которые клиент использует для скачивания.
   *
   * Retry/idempotency: повторный start того же download_id в пределах lease —
   * БЕЗ повторного списания (billing.already_charged=true).
   */
  async downloadStart(downloadId: string): Promise<DownloadStartResponse> {
    return this.request<DownloadStartResponse>(
      "POST",
      `/desktop/downloads/${encodeURIComponent(downloadId)}/start`,
      {},
    );
  }

  /** Phase 4: Zero-Stitch Download Context — получить volumes metadata для прямого MTProto download. */
  async downloadContext(fileId: number): Promise<DownloadContextResponse> {
    return this.request<DownloadContextResponse>(
      "GET",
      `/desktop/downloads/context/${fileId}`,
    );
  }

  /** Phase 2: MTProto Metadata Provider — refresh MTProto metadata via backend. */
  async refreshVolumeMeta(
    fileId: number,
    body: VolumeRefreshRequest,
  ): Promise<VolumeRefreshResponse> {
    return this.request<VolumeRefreshResponse>(
      "POST",
      `/desktop/downloads/refresh-volume/${fileId}`,
      body,
    );
  }

  /** Завершить сессию скачивания на сервере (Control Plane).
   *
   * Вызывается после того, как TDLib завершил download (успешно или с ошибкой).
   * Сервер финализирует DesktopDownloadJob, списывает баллы и т.д.
   */
  async downloadComplete(
    downloadId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { success };
    if (errorMessage) {
      body["error_message"] = errorMessage;
    }
    await this.request("POST", `/desktop/downloads/${downloadId}/complete`, body);
  }

  // ── Server info / Capabilities ──

  /** Интерфейс ответа /api/capabilities */
  async getCapabilities(): Promise<{
    ok: boolean;
    telegram_account_mode: string;
    telegram_part_max_bytes: number;
    telegram_standard_part_max_bytes: number;
    telegram_premium_part_max_bytes: number;
    bot_miniapp_max_upload_bytes: number;
    desktop_large_upload_enabled: boolean;
    /** Feature flags: direct MTProto (Plan B) */
    direct_upload_enabled?: boolean;
    direct_download_enabled?: boolean;
    direct_verify_enabled?: boolean;
    /** Telegram API ID для direct MTProto upload (Plan B) */
    telegram_api_id?: number;
    /**
     * ⚠️ telegram_api_hash не передаётся анонимно (capabilities).
     * Post-auth fallback: GET /api/client-config (Bearer) — см. getClientConfig().
     * Compile-time VITE_TELEGRAM_API_HASH — опциональный dev-fallback,
     * не требуется для CI-билда (Zero Secrets in Binary).
     */
    upload_backend?: string;
    download_backend?: string;
  }> {
    return this.request("GET", "/api/capabilities");
  }


  // ── Runtime client config (post-auth, Zero Secrets in Binary) ──

  /**
   * GET /api/client-config — runtime telegram_api_hash (post-auth).
   * Требует установленный Bearer (см. setToken после authPair).
   */
  async getClientConfig(): Promise<{
    ok: boolean;
    telegram_api_id?: number;
    telegram_api_hash?: string;
  }> {
    return this.request("GET", "/api/client-config");
  }

  // ── App State & Product Config (server-driven) ──

  /** Получить полный app state (с балансом, если есть токен) */
  async getAppState(): Promise<AppStateResponse> {
    return this.request<AppStateResponse>("GET", "/desktop/app-state");
  }

  /** Получить upload form schema (kind: firmware | documentation | software) */
  async getUploadFormSchema(kind: string = "firmware"): Promise<UploadFormSchemaResponse> {
    return this.request<UploadFormSchemaResponse>(
      "GET",
      `/desktop/forms/upload?kind=${encodeURIComponent(kind)}`,
    );
  }

  // ── Search ──

  async search(query: string): Promise<SearchResponse> {
    return this.request<SearchResponse>(
      "GET",
      `/desktop/search?q=${encodeURIComponent(query)}`,
    );
  }

  /**
   * Дерево публичного каталога (A3, kind → brand → model) — «Весь каталог».
   * Источник — SQL по таблице `files` (approved), не Meili: работает и при
   * выключенном/упавшем индексе. Личные (PM) файлы в дерево не входят.
   */
  async catalogTree(): Promise<CatalogTreeResponse> {
    return this.request<CatalogTreeResponse>("GET", "/api/v1/search/public/tree");
  }

  /**
   * Фасетный каталог (Meilisearch, Phase 3): мгновенный поиск с опечатками
   * + фасеты. SEARCH_INDEX_ENABLED=false на сервере → {fallback:"index_disabled"}
   * — вызывающий код обязан откатиться на legacy api.search().
   */
  async catalogSearch(
    query: string,
    filter: string,
    limit: number = 50,
  ): Promise<CatalogSearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (filter) params.set("filter", filter);
    return this.request<CatalogSearchResponse>(
      "GET",
      `/api/v1/search/public?${params.toString()}`,
    );
  }

  /**
   * Фасетный личный каталог (Phase 4): тот же контракт, что catalogSearch,
   * но Bearer-scope: сервер жёстко фильтрует по своему user_tg_id.
   * Пустой query = список ВСЕХ своих файлов (browse, newest сверху).
   */
  async personalCatalogSearch(
    query: string,
    filter: string,
    limit: number = 50,
  ): Promise<CatalogSearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (filter) params.set("filter", filter);
    return this.request<CatalogSearchResponse>(
      "GET",
      `/api/v1/search/personal?${params.toString()}`,
    );
  }

  // ── Личное хранилище (Vault) ──────────────────────────────────────────

  /** Статус entitlement личного хранилища текущего юзера. */
  async vaultStatus(): Promise<VaultStatusResponse> {
    return this.request<VaultStatusResponse>("GET", "/desktop/vault/status");
  }

  /** Личный поиск по своим файлам (пустой q = список). */
  async vaultSearch(query: string): Promise<VaultSearchResponse> {
    return this.request<VaultSearchResponse>(
      "GET",
      `/desktop/vault/search?q=${encodeURIComponent(query)}`,
    );
  }

  // ─── Вложения карточки (SP-20, D-094) ──────────────────────────────────────

  /** Список вложений карточки (публичная — любому авторизованному). */
  async communityNotifications(after=0, maximum?:number, signal?:AbortSignal):Promise<ChatNotificationPage> {
    return this.request("GET", `/desktop/community/notifications?limit=100&after_thread_id=${after}${maximum===undefined?'':`&snapshot_max_thread_id=${maximum}`}`,undefined,false,signal,10000);
  }
  async communityThreadById(id:number):Promise<{thread:CommunityThread}> {
    return this.request("GET", `/desktop/community/threads/${id}`);
  }

  async communityThread(fileId?: number): Promise<{thread: CommunityThread}> {
    return this.request("POST", "/desktop/community/threads", fileId===undefined?{}:{file_id:fileId});
  }
  async communityFeed(offset=0): Promise<ThreadPage> {
    return this.request("GET", `/desktop/community/threads?limit=30&offset=${offset}`);
  }
  async communityHeartbeat(): Promise<unknown> {
    return this.request("POST", "/desktop/community/presence");
  }
  async communityPresence(offset=0): Promise<PresencePage> {
    return this.request("GET", `/desktop/community/presence?limit=50&offset=${offset}`);
  }
  async communityMessages(id: number, before?: number): Promise<EntryPage> {
    return this.request("GET", `/desktop/community/threads/${id}/messages?limit=50${before?`&before_id=${before}`:''}`);
  }
  async communitySend(id: number, intent: EntryIntent): Promise<unknown> {
    return this.request("POST", `/desktop/community/threads/${id}/messages`, intent);
  }
  async communityRead(id: number, lastRead: number): Promise<unknown> {
    return this.request("POST", `/desktop/community/threads/${id}/read`, {last_read_id:lastRead});
  }
  async communityReviews(fileId: number, before?: number): Promise<EntryPage> {
    return this.request("GET", `/desktop/community/files/${fileId}/reviews?limit=20${before?`&before_id=${before}`:''}`);
  }
  async communityReview(fileId: number, intent: EntryIntent): Promise<unknown> {
    return this.request("POST", `/desktop/community/files/${fileId}/reviews`, intent);
  }
  async communityDelete(entryId: number): Promise<unknown> {
    return this.request("DELETE", `/desktop/community/entries/${entryId}`);
  }

  async cardAttachmentList(
    kind: CardMediaKind,
    cardId: number,
  ): Promise<CardAttachmentListResponse> {
    return this.request<CardAttachmentListResponse>(
      "GET",
      `/desktop/cards/${kind}/${cardId}/attachments`,
    );
  }

  /**
   * Старт загрузки вложения: сервер создаёт джобу `content_kind=card_attachment`
   * и отдаёт координаты. Клиент шлёт документ боту своим TDLib (caption
   * `upload_id:<uuid>`) — бот кладёт его в тему карточки (личная — якорем на
   * исходное сообщение) и пишет якорь строки `card_attachments`.
   */
  async cardAttachmentInit(
    kind: CardMediaKind,
    cardId: number,
    attKind: string,
    note: string = "",
  ): Promise<CardAttachmentInitResponse> {
    return this.request<CardAttachmentInitResponse>(
      "POST",
      `/desktop/cards/${kind}/${cardId}/attachments/init`,
      { att_kind: attKind, note },
    );
  }

  /** Итог загрузки вложения: статус джобы + актуальный список вложений. */
  async cardAttachmentComplete(
    kind: CardMediaKind,
    cardId: number,
    uploadId: string,
  ): Promise<CardAttachmentCompleteResponse> {
    return this.request<CardAttachmentCompleteResponse>(
      "POST",
      `/desktop/cards/${kind}/${cardId}/attachments/${encodeURIComponent(uploadId)}/complete`,
    );
  }

  /** Снять вложение (сообщение из темы удаляет сервер). */
  async cardAttachmentDelete(
    kind: CardMediaKind,
    cardId: number,
    attId: number,
  ): Promise<{ ok: boolean; message_removed: boolean }> {
    return this.request<{ ok: boolean; message_removed: boolean }>(
      "DELETE",
      `/desktop/cards/${kind}/${cardId}/attachments/${attId}`,
    );
  }

  /** Абсолютный URL байтов вложения (для `attachmentObjectUrl`). */
  cardAttachmentUrl(kind: CardMediaKind, cardId: number, attId: number): string {
    return `${this.baseUrl}/desktop/cards/${kind}/${cardId}/attachments/${attId}/stream`;
  }

  // ─── Разовая самоправка текста карточки (D-186) ────────────────────────────

  /**
   * Состояние формы «Редагувати»: текущий текст карточки, какие поля доступны
   * этому классу контента, флаг «попытка уже потрачена» и ревизия.
   */
  async cardEditState(kind: CardMediaKind, cardId: number): Promise<CardEditState> {
    return this.request<CardEditState>(
      "GET",
      `/desktop/cards/${kind}/${cardId}/edit`,
    );
  }

  /**
   * Применить единственную самоправку карточки.
   *
   * Ошибки сервера несут `status` в Error (409 — попытка уже потрачена,
   * 400 — невалидный патч): код разбирает `parseCardEditError` в UI-слое,
   * чтобы показать мастеру человеческий текст, а не «API 409: {...}».
   */
  async cardEditPatch(
    kind: CardMediaKind,
    cardId: number,
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<CardEditApplied> {
    const body: Record<string, unknown> = { ...patch };
    if (revision !== undefined) body.revision = revision;
    return this.request<CardEditApplied>(
      "PATCH",
      `/desktop/cards/${kind}/${cardId}/edit`,
      body,
    );
  }

  // ─── Медиа карточки (SP-15 v3, D-069) ──────────────────────────────────────

  /** Список медиа карточки (владелец): якорь + thumb/full URL. */
  async cardMediaList(
    kind: CardMediaKind,
    cardId: number,
  ): Promise<CardMediaListResponse> {
    return this.request<CardMediaListResponse>(
      "GET",
      `/desktop/cards/${kind}/${cardId}/media`,
    );
  }

  /**
   * Старт загрузки медиа: сервер создаёт upload-джобу и отдаёт координаты.
   * Клиент шлёт фото боту (caption `upload_id:<uuid>`) — бот кладёт его
   * в ТУ ЖЕ тему, что прошивка, и пишет якорь.
   */
  async cardMediaInit(
    kind: CardMediaKind,
    cardId: number,
  ): Promise<CardMediaInitResponse> {
    return this.request<CardMediaInitResponse>(
      "POST",
      `/desktop/cards/${kind}/${cardId}/media/init`,
    );
  }

  /** Итог медиа-загрузки: статус джобы + актуальный список медиа карточки. */
  async cardMediaComplete(
    kind: CardMediaKind,
    cardId: number,
    uploadId: string,
  ): Promise<CardMediaCompleteResponse> {
    return this.request<CardMediaCompleteResponse>(
      "POST",
      `/desktop/cards/${kind}/${cardId}/media/${encodeURIComponent(uploadId)}/complete`,
    );
  }

  /** Снять медиа с карточки (сообщение из темы удаляет сервер). */
  async cardMediaDelete(
    kind: CardMediaKind,
    cardId: number,
    mediaId: number,
  ): Promise<{ ok: boolean; message_removed: boolean }> {
    return this.request<{ ok: boolean; message_removed: boolean }>(
      "DELETE",
      `/desktop/cards/${kind}/${cardId}/media/${mediaId}`,
    );
  }

  /**
   * Байты медиа карточки с токеном → `blob:`-адрес для тега `<img>`.
   *
   * Нужно потому, что `<img src>` заголовки не отправляет, а маршрут медиа
   * для НЕпубличной карточки fail-closed требует Bearer (личная карточка —
   * всегда владелец, публичная неодобренная — владелец). Публичные одобренные
   * карточки отдаются без токена — их можно ставить в `src` напрямую.
   *
   * Возвращённый адрес освобождать через `URL.revokeObjectURL` (`MediaAuth`).
   */
  async mediaObjectUrl(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthorized) this.onUnauthorized();
      throw new Error(`media ${res.status}`);
    }
    return URL.createObjectURL(await res.blob());
  }

  /**
   * Байты вложения карточки → `blob:`-адрес (SP-20, D-094).
   *
   * Тот же приём, что у медиа: `<a href>` заголовки не отправляет, а маршрут
   * вложения для НЕпубличной карточки fail-closed требует Bearer. Освобождать
   * результат через `URL.revokeObjectURL`.
   */
  async attachmentObjectUrl(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthorized) this.onUnauthorized();
      throw new Error(`attachment ${res.status}`);
    }
    return URL.createObjectURL(await res.blob());
  }

  /** Список своих личных файлов. */
  async vaultFiles(): Promise<VaultFilesResponse> {
    return this.request<VaultFilesResponse>("GET", "/desktop/vault/files");
  }

  /** mtproto-meta для скачивания своего личного файла из своего PM. */
  async vaultDownloadInit(pfId: number): Promise<VaultDownloadMeta> {
    return this.request<VaultDownloadMeta>(
      "POST",
      `/desktop/vault/files/${pfId}/download/init`,
    );
  }

  /**
   * Удалить свой личный файл (реестр is_deleted).
   * Ответ содержит pm_delete { chat_id, message_ids } — координаты своего
   * PM-сообщения для self-delete клиентом (tdlib_delete_messages).
   */
  async vaultDelete(pfId: number): Promise<VaultDeleteResponse> {
    return this.request<VaultDeleteResponse>(
      "POST",
      `/desktop/vault/files/${pfId}/delete`,
    );
  }

  /**
   * Справочник зарегистрированных пользователей ARTEL (выбор получателя).
   * Наружу отдаётся только отображаемое имя + непрозрачный `user_ref`.
   */
  async vaultDirectory(q = ""): Promise<VaultDirectoryResponse> {
    return this.request<VaultDirectoryResponse>(
      "GET",
      `/desktop/vault/directory?q=${encodeURIComponent(q)}`,
    );
  }

  /** Отправить свой личный файл другому мастеру (срок жизни ссылки — 72 ч). */
  async vaultShare(pfId: number, recipientRef: string): Promise<VaultShareResponse> {
    return this.request<VaultShareResponse>(
      "POST",
      `/desktop/vault/files/${pfId}/share`,
      { recipient_ref: recipientRef },
    );
  }

  /** Входящие передачи, ждущие приёма. */
  async vaultIncomingShares(): Promise<VaultIncomingSharesResponse> {
    return this.request<VaultIncomingSharesResponse>(
      "GET",
      "/desktop/vault/shares/incoming",
    );
  }

  /** «Принять»: файл зачисляется в личное хранилище получателя. */
  async vaultAcceptShare(shareId: number): Promise<VaultAcceptShareResponse> {
    return this.request<VaultAcceptShareResponse>(
      "POST",
      `/desktop/vault/shares/${shareId}/accept`,
    );
  }

  /** «Отклонить»: передача закрывается, копия со склада удаляется. */
  async vaultDeclineShare(shareId: number): Promise<{ ok: boolean; status: string }> {
    return this.request<{ ok: boolean; status: string }>(
      "POST",
      `/desktop/vault/shares/${shareId}/decline`,
    );
  }

  /** Массовая публикация личных файлов в общий каталог. */
  async vaultPublish(pfIds: number[]): Promise<VaultPublishResponse> {
    return this.request<VaultPublishResponse>(
      "POST",
      "/desktop/vault/publish",
      { ids: pfIds },
    );
  }

  // «Отозвать из общего» удалён (2026-09-08): если файл опубликован в общий
  // каталог, юзер не может его отозвать — публикация остаётся (удалить File
  // может только админ). Юзер может удалить только свою личную копию.

  // ── Owner-backdoor (Vault, только OWNER_ID; SPEC §6.1, T6.4) ───────────

  /** Список юзеров с личным хранилищем (+entitlement + count файлов). q — фильтр. */
  async vaultOwnerUsers(q = ""): Promise<VaultOwnerUsersResponse> {
    return this.request<VaultOwnerUsersResponse>(
      "GET",
      `/desktop/vault/owner/users?q=${encodeURIComponent(q)}`,
    );
  }

  /** Список личных файлов целевого юзера (owner-backdoor, audit). */
  async vaultOwnerFiles(targetTg: number): Promise<VaultOwnerFilesResponse> {
    return this.request<VaultOwnerFilesResponse>(
      "GET",
      `/desktop/vault/owner/${targetTg}/files`,
    );
  }

  /** Поиск по личному хранилищу целевого юзера (owner-backdoor, audit). */
  async vaultOwnerSearch(targetTg: number, q: string): Promise<VaultOwnerSearchResponse> {
    return this.request<VaultOwnerSearchResponse>(
      "GET",
      `/desktop/vault/owner/${targetTg}/search?q=${encodeURIComponent(q)}`,
    );
  }

  /**
   * Скачать личный файл целевого юзера (owner-backdoor, audit).
   * Сервер: host-copy PM(юзера) → PM(владельца); ответ — delivery-координаты
   * (owner_pm_chat_id — PM владельца с Host-ботом как видит клиент, delivery_message_id).
   */
  async vaultOwnerDownload(targetTg: number, pfId: number): Promise<VaultOwnerDownloadResponse> {
    return this.request<VaultOwnerDownloadResponse>(
      "POST",
      `/desktop/vault/owner/${targetTg}/files/${pfId}/download`,
    );
  }

  /** Удалить личный файл целевого юзера (owner-backdoor, audit). */
  async vaultOwnerDelete(targetTg: number, pfId: number): Promise<VaultOwnerDeleteResponse> {
    return this.request<VaultOwnerDeleteResponse>(
      "POST",
      `/desktop/vault/owner/${targetTg}/files/${pfId}/delete`,
    );
  }

  /** Опубликовать личные файлы целевого юзера в общий каталог (owner, audit). */
  async vaultOwnerPublish(targetTg: number, pfIds: number[]): Promise<VaultOwnerPublishResponse> {
    return this.request<VaultOwnerPublishResponse>(
      "POST",
      `/desktop/vault/owner/${targetTg}/publish`,
      { ids: pfIds },
    );
  }

  async checkServer(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── GEO_Unlock (D-150, счётчик — D-173): grant и остаток разблокировок ──

  /**
   * POST /desktop/tools/geo-unlock/grant — разрешение на платную операцию.
   *
   * Рендерер спрашивает grant ТОЛЬКО когда скан дампа вернул `needsGrant`
   * (дамп раздела eMMC). Владельцу сервер отвечает `kind: "owner"` без
   * списания, мастеру с пакетом — `kind: "package"` (каждая операция списывает
   * одну разблокировку), остальным — ограниченное число пробных попыток; когда
   * не осталось ничего — 402 «нужен пакет».
   */
  async geoUnlockGrant(tool: string = "samsung_p31"): Promise<GeoUnlockGrantResponse> {
    return this.request<GeoUnlockGrantResponse>("POST", "/desktop/tools/geo-unlock/grant", {
      tool,
    });
  }

  /**
   * GET /desktop/tools/geo-unlock/status — остаток разблокировок БЕЗ выдачи grant'а.
   *
   * Нужен для счётчика в карточке утилиты: спрашивать остаток через grant нельзя —
   * выдача списывает разблокировку, то есть открытие вкладки стоило бы операции.
   */
  async geoUnlockStatus(): Promise<GeoUnlockStatusResponse> {
    return this.request<GeoUnlockStatusResponse>("GET", "/desktop/tools/geo-unlock/status");
  }

  // ── Desktop Points API (замена WorkerApiBridge) ──

  /**
   * Проверить доступ к файлу для текущего пользователя.
   * Аутентификация через Bearer-токен (DesktopSession).
   * GET /desktop/points/check-access/{file_id}
   */
  async checkAccess(fileId: number): Promise<{
    allow: boolean;
    reason?: string;
    balance?: number;
    is_self?: boolean;
    is_unlimited?: boolean;
  }> {
    return this.request("GET", `/desktop/points/check-access/${fileId}`);
  }

  /**
   * Списать баллы с текущего пользователя за скачивание.
   * Аутентификация через Bearer-токен (DesktopSession).
   * POST /desktop/points/charge
   */
  async chargePoints(fileId: number, force?: boolean): Promise<{
    success: boolean;
    balance_before: number;
    balance_after: number;
    charged: number;
    passive_income_credited: number;
    error?: string;
    note?: string;
  }> {
    return this.request("POST", "/desktop/points/charge", { file_id: fileId, force: force ?? false });
  }

  /**
   * Начислить баллы текущему пользователю за успешную загрузку файла.
   * Аутентификация через Bearer-токен (DesktopSession).
   * POST /desktop/points/credit
   */
  async creditPoints(fileId: number, bonus?: number): Promise<{
    success: boolean;
    balance_before: number;
    balance_after: number;
    credited: number;
    error?: string;
  }> {
    return this.request("POST", "/desktop/points/credit", { file_id: fileId, bonus: bonus ?? null });
  }

  // ══════════════════════════════════════════════════════════════════
  // SP-13: десктоп-чаты (D-052) — RAG-автоответ, ИИ-чат, треды, лента
  // ══════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/files/{id}/card — сводка по файлу + «что ещё скачать» (SP-19).
   *
   * S1 (D-087): сводка строится ФОНОМ на сервере, здесь только чтение кеша —
   * поэтому длинный AI-таймаут (180 с, для живого чата) этому запросу больше не
   * нужен: карточка обязана отвечать секундой (§4 п.1).
   * S1b: `storage[]` — соседние файлы того же аппарата (список строит SQL).
   */
  async chatCard(fileId: number): Promise<{
    file_id: number;
    rag_summary: string | null;
    summary_status: string;
    summary_sources: CardSourcePayload[];
    storage: CardStorageItem[];
    form: CardFormEntry[];
    /** D-134: «кто скачал» из книги учёта (спойлер под сводкой). */
    downloaders?: { total: number; users: { name: string; mine?: boolean }[] } | null;
  }> {
    return this.request("GET", `/api/v1/files/${fileId}/card`);
  }

  /** D-135: строка файла для прыжка «из чата в карточку» (`GET /api/v1/files/{id}`). */
  async fileById(fileId: number): Promise<SearchResultItem> {
    return this.request("GET", `/api/v1/files/${fileId}`);
  }

  /**
   * POST /api/v1/files/{id}/summary/feedback — опыт мастера под сводкой (SP-19 S4).
   *
   * `helped=true` требует текст (сервер вернёт 400 на пустой): пустая отметка
   * бесполезна и другим мастерам, и датасету. `verified` считает СЕРВЕР по числу
   * РАЗНЫХ мастеров (≥2 = «Проверено»), клиент пороги не повторяет.
   */
  async summaryFeedback(
    fileId: number,
    helped: boolean,
    text: string,
  ): Promise<{
    status: string;
    dm_id: number;
    votes: number;
    verified: boolean;
    helped: boolean;
  }> {
    return this.request("POST", `/api/v1/files/${fileId}/summary/feedback`, {
      helped,
      text,
    });
  }


  /** Зарегистрировать DesktopSession после Grammers-авторизации.
   *  BUG-PROD-SYNC-002: передаём профиль (username/first_name) — сервер создаст/
   *  обогатит строку users, иначе desktop-юзер не появляется в админке с именем. */
  async authPair(
    tg_id: number,
    profile?: { username?: string | null; first_name?: string | null },
  ): Promise<AuthPairResponse> {
    return this.request<AuthPairResponse>(
      "POST",
      "/desktop/auth/pair",
      {
        tg_id,
        username: profile?.username ?? null,
        first_name: profile?.first_name ?? null,
      },
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Monobank Billing
  // ══════════════════════════════════════════════════════════════════

  /** GET /api/v1/billing/packages — список пакетов баллов + ревизия набора */
  async listPackages(): Promise<{
    packages: BillingPackage[];
    count: number;
    revision: number;
  }> {
    return this.request("GET", "/api/v1/billing/packages");
  }

  /** POST /api/v1/billing/create-invoice — создание Monobank инвойса */
  async createInvoice(tg_id: number, package_id: string): Promise<CreateInvoiceResponse> {
    return this.request<CreateInvoiceResponse>(
      "POST",
      "/api/v1/billing/create-invoice",
      { tg_id, package_id },
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // FAQ (справка клиента)
  // ══════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/faq?lang=uk|ru|en — публичная справка (без авторизации).
   *
   * Серверная цепочка языков: запрошенный → UK → RU, поэтому при пустом
   * переводе ответ приходит с `fallback_used` = фактически отданный язык.
   * Спецификация: docs/FAQ_ARCHITECTURE.md.
   */
  async getFaq(lang: string): Promise<FaqResponse> {
    return this.request<FaqResponse>("GET", `/api/v1/faq?lang=${encodeURIComponent(lang)}`);
  }

}

// ── Monobank Billing Types ──

export interface BillingPackage {
  id: string;
  name: string;
  description: string;
  price_uah: number;
  points: number;
  popular: boolean;
  // Личное хранилище (Vault)
  grants_vault_bonus_days?: number;  // бонус дней при покупке (0 = нет)
  is_vault_standalone?: boolean;     // пакет продаёт ТОЛЬКО хранилище
  vault_days?: number;               // срок standalone-предложения (дни)
  // GEO_Unlock — standalone количество разблокировок утилит, независимое от хранилища (vault_days).
  // 0 = пакет утилиту не открывает.
  geo_unlock_count?: number;
}

export interface CreateInvoiceResponse {
  pay_url: string;
  payment_code: string;
}

// ── FAQ Types (справка клиента) ──

/** Раздел публичной справки (уже локализован сервером). */
export interface FaqSection {
  id: string;
  icon: string;
  title: string;
  body: string;
}

/** Ответ GET /api/v1/faq — плоский локализованный документ. */
export interface FaqResponse {
  revision: number;
  /** Запрошенный язык (uk/ru/en). */
  lang: string;
  /** Фактически отданный язык, если он отличается от запрошенного (иначе null). */
  fallback_used: string | null;
  sections: FaqSection[];
}

// ── App State & Upload Form Schema Types ──

export interface AppStateUser {
  tg_id: number;
  username: string | null;
  first_name: string | null;
  balance: number;
  is_unlimited: boolean;
  is_banned: boolean;
  ban_reason?: string | null;
  is_owner: boolean;
  roles: string[];
}

export interface AppStateLimits {
  telegram_account_mode: string;
  telegram_part_max_bytes: number;
  telegram_standard_part_max_bytes: number;
  telegram_premium_part_max_bytes: number;
  bot_miniapp_max_upload_bytes: number;
  max_telegram_download_bytes: number;
  resumable_chunk_size_bytes: number;
  resumable_max_file_size_bytes: number;
  multipart_part_size_bytes: number;
  min_disk_free_bytes: number;
  ai_archive_analysis_max_bytes: number;
  upload_fields_max_length: Record<string, number>;
}

export interface AppStateFeatures {
  desktop_enabled: boolean;
  miniapp_enabled: boolean;
  desktop_upload_enabled: boolean;
  desktop_large_upload_enabled: boolean;
  desktop_download_enabled: boolean;
  ai_moderation_enabled: boolean;
  ai_classification_enabled: boolean;
  subscriptions_enabled: boolean;
  telegram_payments_enabled: boolean;
  referral_system_enabled: boolean;
}

export interface AppStatePricing {
  currency: string;
  download_cost: number;
  upload_reward: number;
  base_signup_bonus: number;
  referral_reward: number;
}

export interface AppStatePaymentProduct {
  id: string;
  type: string;
  points?: number;
  duration_days?: number;
  price: number | null;
  enabled: boolean;
}

export interface AppStatePayments {
  enabled: boolean;
  provider: string;
  supported_providers: string[];
  currency: string;
  products: AppStatePaymentProduct[];
}

export interface AppStateBanner {
  id: string;
  text: string;
  severity: string;
  platforms: string[];
  active: boolean;
}

export interface AppStateUiWarnings {
  [key: string]: string;
}

export interface AppStateUi {
  banners: AppStateBanner[];
  warnings: AppStateUiWarnings;
}

export interface AppStateResponse {
  ok: boolean;
  schema_version: number;
  min_desktop_schema_version: number;
  min_miniapp_schema_version: number;
  features: AppStateFeatures;
  limits: AppStateLimits;
  pricing: AppStatePricing;
  payments: AppStatePayments;
  ui: AppStateUi;
  user: AppStateUser | null;
  /** Ревизия набора пакетов магазина — polling fallback для packages_update (Phase 7) */
  billing_packages_revision: number;
}

// ── Upload Form Schema Types ──

export interface UploadFormField {
  name: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  type: string;
  max_length: number;
  order: number;
  section?: string;
  // i18n: опциональные ключи локализации (рендер вызывает t()).
  // Серверная схема может слать обычные label/placeholder — тогда
  // UploadPage резолвит ключ по field.name, иначе использует label as-is.
  labelKey?: string;
  placeholderKey?: string;
  // SP-35 (D-185): `scopes` — режимы, где класс контента разрешён
  // ("public"/"personal"). Нет поля = доступен в обоих (легасі-схема).
  options?: Array<{ value: string; label?: string; labelKey?: string; scopes?: string[] }>;
}

export interface UploadFormSchemaLimits {
  bot_miniapp_max_upload_bytes: number;
  max_file_size_bytes: number;
  max_fields_length: Record<string, number>;
  max_files_per_upload: number;
}

export interface UploadFormSchemaWarning {
  id: string;
  text: string;
  condition?: string;
  severity: string;
}

export interface UploadFormSchemaResponse {
  ok: boolean;
  schema_version: number;
  /** Клас контенту этой схемы (firmware/documentation/software). */
  content_kind?: string;
  fields: UploadFormField[];
  limits: UploadFormSchemaLimits;
  warnings: UploadFormSchemaWarning[];
}

// ── Медиа карточки (SP-15 v3, D-069) ──

/** Владелец карточки: публичный файл каталога или личный файл Vault. */
export type CardMediaKind = "file" | "personal";

// ── Разовая самоправка текста карточки (D-186, миграция 081) ──

/** Текст карточки, который вообще может меняться самоправкой. */
export interface CardEditCard {
  brand: string;
  model: string;
  version: string;
  description: string | null;
  properties: Record<string, string>;
}

/**
 * Ответ `GET /desktop/cards/{kind}/{card_id}/edit`.
 *
 * `editable_scalars` / `editable_property_keys` приходят с СЕРВЕРА: набор
 * полей зависит от класса контента (прошивка ≠ документация ≠ софт), и клиент
 * не имеет права угадывать его сам — иначе форма покажет поля, которые сервер
 * отвергнет (`field_not_editable`).
 */
export interface CardEditState {
  ok: boolean;
  card_kind: CardMediaKind;
  card_id: number;
  content_kind: string;
  card: CardEditCard;
  editable_scalars: string[];
  editable_property_keys: string[];
  required_property_keys: string[];
  can_edit: boolean;
  used_at: string | null;
  revision: number;
}

/** Ответ `PATCH /desktop/cards/{kind}/{card_id}/edit` (правка применена). */
export interface CardEditApplied {
  ok: boolean;
  card_kind: CardMediaKind;
  card_id: number;
  content_kind: string;
  card: CardEditCard;
  changed: string[];
  /** Парная копия, до которой доехала правка: `file:12` / `personal:7`. */
  synced: string | null;
  revision: number;
  used_at: string;
}

/** Элемент медиа карточки (в документе поиска или в ответе API). */
export interface CardMediaItem {
  id: number;
  media_kind?: string;
  mime?: string;
  width?: number | null;
  height?: number | null;
  has_thumb?: boolean;
  thumb_url?: string;
  full_url?: string;
  sort_order?: number;
  /** Якорь: Desktop резолвит медиа сам по TDLib (как прошивку). */
  tg_chat_id?: number;
  tg_message_id?: number;
  tg_file_id?: string | null;
  tg_file_unique_id?: string | null;
}

export interface CardMediaListResponse {
  ok: boolean;
  card_kind: CardMediaKind;
  card_id: number;
  media: CardMediaItem[];
}

export interface CardMediaInitResponse {
  ok: boolean;
  upload_id: string;
  mode: "public" | "personal";
  vault_chat_id: number;
  topic_id: number | null;
  /** PM бота (host-mediation): куда клиент шлёт фото своим TDLib. */
  pm_chat_id: number | null;
  caption_hint: string;
  max_media: number;
}

export interface CardMediaCompleteResponse {
  ok: boolean;
  status: string;
  error: string | null;
  media: CardMediaItem[];
}

// ── Вложения карточки (SP-20, D-094) ──

/** Одно вложение — поле `attachments[]` из API (`_row_to_dict` сервиса). */
export interface CardAttachmentItemResponse {
  id: number;
  att_kind: string;
  note: string;
  mime: string;
  size_bytes: number;
  original_name: string;
  author_tg_id: number;
  created_at: string | null;
  has_anchor: boolean;
}

export interface CardAttachmentListResponse {
  ok: boolean;
  card_kind: CardMediaKind;
  card_id: number;
  attachments: CardAttachmentItemResponse[];
  max_attachments?: number;
}

export interface CardAttachmentInitResponse {
  ok: boolean;
  upload_id: string;
  mode: "public" | "personal";
  vault_chat_id: number;
  topic_id: number | null;
  /** PM бота (host-mediation): куда клиент шлёт документ своим TDLib. */
  pm_chat_id: number | null;
  caption_hint: string;
  max_attachments: number;
}

export interface CardAttachmentCompleteResponse {
  ok: boolean;
  status: string;
  error: string | null;
  attachments: CardAttachmentItemResponse[];
}

// ── Search ──

export interface SearchResultItem {
  id: number;
  /** Клас контенту: firmware | documentation | software. */
  content_kind?: string;
  brand: string;
  model: string;
  version: string;
  description: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  /**
   * Медиа карточки (SP-15 v3, D-069): превьюшки в описании.
   * Приходит из индекса поиска; поле опциональное — старые индексы без него.
   */
  media?: CardMediaItem[];
  uploader?: {
    id?: number;
    tg_id?: number;
    first_name: string | null;
    username: string | null;
  };
  // Upload form v2 fields — отображаются в карточке результата поиска
  device_category?: string;
  chassis?: string;
  chipset?: string;
  memory_type?: string;
  firmware_type?: string;
  source_status?: string;
  programmer?: string;
  panel_model?: string;
  // Content kind-специфічні: doc_type (documentation), title (software)
  doc_type?: string;
  title?: string;
}

export interface SearchResponse {
  ok: boolean;
  query: string;
  results: SearchResultItem[];
  total: number;
}

// ── Фасетный каталог (Meilisearch proxy, /api/v1/search/public) ──

export type FacetDistribution = Record<string, Record<string, number>>;

export interface CatalogSearchResponse {
  ok: boolean;
  query: string;
  results: SearchResultItem[];
  total: number;
  facets?: FacetDistribution;
  /** SEARCH_INDEX_ENABLED=false → "index_disabled" (откат на legacy search). */
  fallback?: "index_disabled";
  /** 503 → search_unavailable (Meili недоступен). */
  error?: string;
}

/**
 * Дерево публичного каталога (A3, «Весь каталог»):
 * GET /api/v1/search/public/tree → {ok, tree}. Форма зеркалит
 * /vault/api/tree (build_vault_tree): kind → brand → model; у software
 * папка = title, файлы лежат в ней (ids на уровне папки, models пуст).
 */
export interface CatalogTreeResponse {
  ok: boolean;
  tree: CatalogTree;
}


// ── Личное хранилище (Vault, SPEC docs/ARCHITECTURE_VAULT_STORAGE.md) ──

export interface VaultStatusResponse {
  ok: boolean;
  user_tg_id: number;
  vault: {
    user_tg_id: number;
    is_active: boolean;
    expires_at: string | null;
    source: string | null;
    package_key: string | null;
  };
}

/** Личный файл хранилища (personal_files карточка; flattened properties). */
export interface VaultFileItem {
  id: number;
  /** Клас контенту: firmware | documentation | software. */
  content_kind?: string;
  brand: string;
  model: string;
  version: string;
  description: string;
  original_name: string;
  size_bytes: number;
  created_at: string;
  published_file_id: number | null;
  // Upload form v2 fields (flattened из properties)
  device_category?: string;
  chassis?: string;
  chipset?: string;
  memory_type?: string;
  firmware_type?: string;
  source_status?: string;
  programmer?: string;
  panel_model?: string;
  // Content kind-специфічні: doc_type (documentation), title (software)
  doc_type?: string;
  title?: string;
}

export interface VaultSearchResponse {
  ok: boolean;
  query: string;
  results: VaultFileItem[];
  total: number;
}

export interface VaultFilesResponse {
  ok: boolean;
  files: VaultFileItem[];
  count: number;
}

export interface VaultPublishItem {
  personal_file_id: number;
  file_id: number | null;
  duplicate: boolean;
  error: string | null;
  /** SP-34/D-184: машинний код причини («personal_anchor_pending|_lost»). */
  error_code?: string | null;
}

export interface VaultPublishResponse {
  ok: boolean;
  results: VaultPublishItem[];
}

/** Координаты своего PM-сообщения личного файла (для self-delete клиентом). */
export interface VaultPmDelete {
  chat_id: number;
  message_ids: number[];
}

export interface VaultDeleteResponse {
  ok: boolean;
  deleted: boolean;
  /** BUG-PERSONAL-DELETE-001: «уже удалено» (идемпотентный повтор/призрак индекса). */
  already_deleted?: boolean;
  pm_delete?: VaultPmDelete;
}

// ── Передача личного файла другому мастеру (SP-33, D-175) ─────────────────

/**
 * Пользователь ARTEL из справочника (выбор получателя).
 * `user_ref` — непрозрачный внутренний идентификатор: сырой tg_id наружу
 * не отдаётся (D-175, R1).
 */
export interface VaultDirectoryItem {
  user_ref: string;
  display_name: string;
  username?: string | null;
  /** У получателя активно личное хранилище (сервер отдаёт только таких). */
  vault_active?: boolean;
}

export interface VaultDirectoryResponse {
  ok: boolean;
  items: VaultDirectoryItem[];
  count: number;
}

/** Ответ на отправку своего файла другому мастеру (срок жизни — 72 ч). */
export interface VaultShareResponse {
  ok: boolean;
  share_id: number;
  expires_at: string;
  recipient_name?: string | null;
  duplicate?: boolean;
}

/** Входящая передача (ждёт приёма получателем). */
export interface VaultIncomingShare {
  share_id: number;
  sender_tg_id: number;
  sender_name: string;
  file_name: string;
  size_bytes: number;
  expires_at: string | null;
  /** Сколько часов осталось до истечения ссылки. */
  expires_in_hours: number;
  parts_count: number;
  created_at?: string | null;
}

export interface VaultIncomingSharesResponse {
  ok: boolean;
  items: VaultIncomingShare[];
  count: number;
}

/** Результат приёма передачи: файл зачислен в личное хранилище получателя. */
export interface VaultAcceptShareResponse {
  ok: boolean;
  personal_file_id: number;
  name: string;
  size_bytes: number;
  download_ready: boolean;
}

/** mtproto-meta для скачивания своего личного файла из своего PM. */
export interface VaultDownloadMeta {
  ok: boolean;
  personal_file_id: number;
  name: string;
  /** Тип бандла: "firmware_bundle" (папка→.zip) | "firmware_file" (BUG-PERSONAL-BUNDLE-001). */
  type?: string;
  size_bytes: number;
  download_strategy: "single" | "multi";
  host_mediation: boolean;
  is_free: boolean;
  parts: Array<{
    index: number;
    name: string;
    size: number;
    sha256: string;
    tg_file_id: string;
    /**
     * SP-33/D-175: файл, ПРИНЯТЫЙ от другого мастера, доставлен ботом в PM
     * получателя — клиентского `tg_file_id` у него нет. Скачивание идёт по
     * PM-якорю (chat_id + message_id + unique_id): клиент резолвит документ
     * в своём чате по уникальному ключу (BUG-DOWNLOAD-051/052).
     */
    pm_delivery?: {
      chat_id?: number | null;
      message_id?: number | null;
      size?: number | null;
      order?: number | null;
      unique_id?: string | null;
    } | null;
    /** Сессионно-независимый ключ документа (TDLib remote.unique_id). */
    unique_id?: string | null;
    mtproto?: {
      mtproto_document_id?: string;
      mtproto_access_hash?: string;
      mtproto_file_reference?: string;
      mtproto_dc_id?: number;
      mtproto_chat_id?: number;
      mtproto_message_id?: number;
    };
  }>;
}

// ── Owner-backdoor (Vault; только OWNER_ID; SPEC §6.1, T6.4) ─────────────

/** Юзер с личным хранилищем в owner-каталоге. */
export interface VaultOwnerUser {
  tg_id: number;
  username: string | null;
  first_name: string | null;
  is_banned: boolean;
  entitlement?: {
    user_tg_id: number;
    is_active: boolean;
    expires_at: string | null;
    source: string | null;
    package_key: string | null;
  };
  files_count: number;
}

export interface VaultOwnerUsersResponse {
  ok: boolean;
  users: VaultOwnerUser[];
  count: number;
}

export interface VaultOwnerFilesResponse {
  ok: boolean;
  target_user_tg_id: number;
  files: VaultFileItem[];
  count: number;
}

export interface VaultOwnerSearchResponse {
  ok: boolean;
  target_user_tg_id: number;
  query: string;
  files: VaultFileItem[];
  count: number;
}

/**
 * Результат owner-download: сервер скопировал документ PM(юзера) → PM(владельца).
 * owner_pm_chat_id — PM владельца с Host-ботом С ТОЧКИ ЗРЕНИЯ КЛИЕНТА (id бота);
 * delivery_message_id — сообщение-документ в PM владельца (качает своя TDLib-сессия).
 */
export interface VaultOwnerDownloadPart {
  index: number;
  name?: string | null;
  size?: number | null;
  unique_id?: string | null;
  /** Клиентский remote id части (для чужой TDLib-сессии невалиден — резолв по pm_delivery). */
  tg_file_id?: string | null;
  pm_delivery?: {
    chat_id?: number | null;
    message_id?: number | null;
    size?: number | null;
    order?: number | null;
    unique_id?: string | null;
  } | null;
}

export interface VaultOwnerDownloadResponse {
  ok: boolean;
  personal_file_id: number;
  owner_pm_chat_id: number;
  delivery_message_id: number;
  /** BUG-DOWNLOAD-052: стабильный ключ документа доставки (TDLib `remote.unique_id`). */
  delivery_unique_id?: string | null;
  /** BUG-DOWNLOAD-052 (фаза 3): per-part доставка multi-файла (>2GB). */
  parts?: VaultOwnerDownloadPart[] | null;
  name: string;
  size_bytes: number;
  download_strategy: string;
  tg_file_id?: string | null;
}

export interface VaultOwnerDeleteResponse {
  ok: boolean;
  deleted: boolean;
  /** BUG-PERSONAL-DELETE-001: «уже удалено» (идемпотентный повтор/призрак индекса). */
  already_deleted?: boolean;
}

export interface VaultOwnerPublishItem {
  personal_file_id: number;
  file_id: number | null;
  duplicate: boolean;
  error: string | null;
}

export interface VaultOwnerPublishResponse {
  ok: boolean;
  results: VaultOwnerPublishItem[];
}

/** Глобальный экземпляр API */
export const api = new ApiClient();

