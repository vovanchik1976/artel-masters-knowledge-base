/**
 * SidecarManager — управление дочерним процессом Rust-бинаря engine-core.
 *
 * Отвечает за:
 *  - spawn engine-core с stdio (stdin/stdout — framed JSON-RPC, stderr — логи);
 *  - фреймирование: длина кадра = 4 байта Big-Endian + UTF-8 JSON;
 *  - корреляцию запрос/ответ по `id` (Promise per request);
 *  - watchdog: перезапуск при неожиданном завершении (R-5 в плане).
 *
 * Протокол (v0, M0):
 *   request : { "jsonrpc":"2.0", "id":<u32>, "method":<string>, "params":{...} }
 *   response: { "jsonrpc":"2.0", "id":<u32>, "result":{...} | "error":{...} }
 *
 * Позже (M1+) в этом же канале пойдут потоковые события auth/progress/health —
 * они будут помечаться без `id` или с методом-событием; парсер уже отделяет
 * ответы (есть id и он ждётся) от событий.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { rotateLogFile } from "./log-rotation";

const FRAME_HDR = 4; // длина = 4 байта BE

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** null — запрос без таймаута (долгие операции: wait_upload, multi-upload/download). */
  timer: NodeJS.Timeout | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** `request(..., NO_TIMEOUT)` — не обрывать долгую операцию (mainline: до 2ч). */
export const NO_TIMEOUT_MS = 0;
/** Предел накопления незавершённой строки stderr (см. writeLogLine): мусор без
 *  переводов строк не должен расти в памяти бесконечно. */
const MAX_PENDING_LOG_CHARS = 64 * 1024;

/** Колбэк потокового события от sidecar (name, payload). */
export type SidecarEventCb = (name: string, payload: unknown) => void;

/** Читает кадр из потока: возвращает имя исполняемого sidecar (с учётом .exe на Windows). */
function binName(): string {
  return process.platform === "win32" ? "engine-core.exe" : "engine-core";
}

export class SidecarManager {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Неполный входной кадр накапливаем между чанками. */
  private buf = Buffer.alloc(0);
  /** Подписчики на потоковые события sidecar (auth/progress/...). */
  private readonly eventCbs = new Set<SidecarEventCb>();
  /** Файл-лог stderr sidecar (переживает закрытие терминала — нужен для разбора
   *  падений/паник воркеров, которые иначе теряются вместе с консолью). */
  private logStream: fs.WriteStream | null = null;
  /** Незавершённый хвост stderr (без `\n`): Rust `stderr` небуферизован и одна
   *  логическая строка приходит несколькими `write`/chunk'ами. Без сборки строк
   *  timestamp попадал в середину JSON — RCA-лог не распарсить
   *  (BUG-RCA-LOG-FRAG-001, live 2026-09-28). */
  private logPending = "";
  /**
   * Последняя ошибка жизненного цикла sidecar (говорящий релиз, 2026-09-22):
   * spawn-error / ранний exit / stderr-хвост. Читается UI через
   * `engine.sidecarStatus` — вместо голого «sidecar not running» пользователь
   * видит код выхода + хвост stderr + путь к бинарю.
   */
  private lastError: string | null = null;
  /** Код/сигнал последнего завершения процесса (null — процесс жив/не стартовал). */
  private lastExit: { code: number | null; signal: string | null } | null = null;
  /** true между stdin.end() и exit в stop() — штатное завершение не должно
   *  выглядеть в UI как «неожиданная смерть» sidecar. */
  private stopping = false;

  /** Последняя ошибка жизненного цикла (для UI/диагностики). */
  lastLifecycleError(): string | null {
    return this.lastError;
  }

  /** Говорящий релиз (2026-09-22): «sidecar not running» с причиной и путём к
   *  логам — вместо голой строки, по которой нечего разбирать. */
  private describeNotRunning(base = "sidecar not running"): string {
    const parts: string[] = [base];
    if (this.lastError) parts.push(`причина: ${this.lastError}`);
    if (this.lastExit) {
      const c = this.lastExit.code === null ? "?" : String(this.lastExit.code);
      const s = this.lastExit.signal ? `, signal=${this.lastExit.signal}` : "";
      parts.push(`последнее завершение: code=${c}${s}`);
    }
    if (this.logDir) {
      parts.push(`логи: ${path.join(this.logDir, "engine-core.log")} и main-sidecar.log`);
    }
    return parts.join("; ");
  }

  /** Жив ли процесс прямо сейчас (для `engine.sidecarStatus`). */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Путь к бинарю sidecar (передаётся из dev7.sh / конфига).
   * `logDir` — каталог для `engine-core.log`; если не задан, файл-лог выключен
   * (используется в тестах/утилитах, где каталога нет).
   */
  constructor(
    private readonly binPath: string,
    private readonly logDir?: string,
  ) {}

  /** Файл-лог sidecar: `<logDir>/engine-core.log` (best-effort, ошибки не фатальны). */
  private ensureLogStream(): fs.WriteStream | null {
    if (this.logStream) return this.logStream;
    if (!this.logDir) return null;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const file = path.join(this.logDir, "engine-core.log");
      // Ротация: максимум 2 файла (engine-core.log + engine-core.1.log), >5 МБ
      // (BUG-LOG-ROTATION-001). Prune файлов старше 7 дней — в main.ts при старте.
      rotateLogFile(this.logDir, "engine-core.log");
      const stream = fs.createWriteStream(file, { flags: "a" });
      stream.on("error", () => {
        this.logStream = null;
      });
      this.logStream = stream;
      return stream;
    } catch {
      return null;
    }
  }

  /**
   * Дублировать строку лога sidecar в файл (stderr остаётся источником для консоли).
   *
   * Chunk'и stderr НЕ совпадают с логическими строками: Rust `stderr`
   * небуферизован, `eprintln!`/`write_fmt` делает отдельный `write` на каждый
   * фрагмент форматирования (serde_json Display — десятки мелких `write`), а
   * каждый `write` приходит сюда отдельным `data`-событием. Поэтому собираем
   * логические строки сами: `\n` — граница строки, хвост без `\n` держим до
   * следующего chunk'а. Ранее timestamp навешивался на каждый chunk и попадал
   * в середину JSON (BUG-RCA-LOG-FRAG-001).
   */
  private writeLogLine(text: string): void {
    const stream = this.ensureLogStream();
    if (!stream) return;
    try {
      const combined = this.logPending + text;
      const lastNl = combined.lastIndexOf("\n");
      if (lastNl === -1) {
        // Логическая строка ещё не завершена — ждём продолжения. Ограничение
        // против неограниченного роста, если поток шлёт мусор без переводов строк.
        this.logPending =
          combined.length > MAX_PENDING_LOG_CHARS ? "" : combined;
        return;
      }
      this.logPending = combined.slice(lastNl + 1);
      const stamp = new Date().toISOString();
      const body = combined
        .slice(0, lastNl)
        .split("\n")
        // Пустые сегменты не метим (иначе мусорные «[ts] » строки).
        .map((l) => (l.length > 0 ? `[${stamp}] ${l}` : l))
        .join("\n");
      stream.write(`${body}\n`);
    } catch {
      /* best-effort — лог не должен ломать приложение */
    }
  }

  /** Дописать незавершённый хвост stderr (выход sidecar: `\n` может не прийти). */
  private flushLogPending(): void {
    if (this.logPending.length === 0) return;
    const stream = this.ensureLogStream();
    if (!stream) return;
    try {
      stream.write(`[${new Date().toISOString()}] ${this.logPending}\n`);
    } catch {
      /* best-effort */
    }
    this.logPending = "";
  }

  /** Подписка на события sidecar. Возвращает unlisten. */
  onEvent(cb: SidecarEventCb): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Запускает engine-core. Если процесс падает — логируем и (по желанию)
   * watchdog с ограниченным числом рестартов.
   */
  async start(): Promise<void> {
    if (this.running) return;
    // Говорящий релиз (2026-09-22): причина обязана попасть и в файл-лог
    // (в пакете нет консоли), и в lastError (читает UI через sidecarStatus).
    if (!fs.existsSync(this.binPath)) {
      const msg =
        `Sidecar binary not found: ${this.binPath}. ` +
        `Проверьте: 1) файлы в <install>/resources/engine-core/ на месте ` +
        `(engine-core.exe + DLL); 2) карантин антивируса; 3) арку (ia32/x64). ` +
        `Сначала соберите: cargo build в engine-core/`;
      this.lastError = msg;
      this.lastExit = { code: null, signal: null };
      this.writeLogLine(`[sidecar-manager] FATAL: ${msg}\n`);
      throw new Error(`Sidecar binary not found: ${this.binPath}. Сначала соберите: cargo build в engine-core/`);
    }
    // e2e-профиль 32-бит: sidecar = Windows engine-core.exe, который Linux
    // нативно не выполнит — прогоном правит wine (FW_ELECTRON_SIDECAR_WRAPPER).
    // Разделяем пробелами (простые случаи: "wine", "wine64", "wine /tmp/x").
    // Новый запуск - старые ошибки не должны вводить UI в заблуждение.
    this.lastError = null;
    this.lastExit = null;
    this.stopping = false;
    const wrapperCmd = process.env.FW_ELECTRON_SIDECAR_WRAPPER;
    const argv = wrapperCmd
      ? [...wrapperCmd.split(/\s+/), this.binPath]
      : [this.binPath];
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // stderr — только логи sidecar, не трогаем framing stdout.
      const text = chunk.toString();
      process.stderr.write(`[engine-core:stderr] ${text}`);
      // Дубль в файл: паника воркера/падение sidecar должны оставаться
      // доступными после закрытия терминала (разбор инцидента задним числом).
      this.writeLogLine(text);
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
      // reject все висящие запросы
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`sidecar exited (code=${code})`));
      }
      this.pending.clear();
      this.child = null;
      this.lastExit = { code, signal: signal ?? null };
      if (!this.stopping) {
        this.lastError = `sidecar exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ""})`;
      }
      const line =
        `[sidecar-manager] engine-core exited with code ${code}` +
        `${signal ? ` (signal ${signal})` : ""}${this.stopping ? " (штатно, по stop())" : ""}\n`;
      process.stderr.write(line);
      // Незавершённый хвост stderr дописываем ДО строки выхода — порядок в логе
      // сохраняется, хвост не теряется (BUG-RCA-LOG-FRAG-001).
      this.flushLogPending();
      this.writeLogLine(line);
    };
    child.on("exit", onExit);
    child.on("error", (err) => {
      const line = `[sidecar-manager] spawn error: ${err.message}\n`;
      process.stderr.write(line);
      this.writeLogLine(line);
      this.lastError = `spawn error: ${err.message}`;
      onExit(null);
    });

    // Ждём готовности через ping (до 10 попыток по 250 мс).
    for (let i = 0; i < 10; i++) {
      try {
        await this.request("ping", {}, 2500);
        return;
      } catch {
        // ещё не готов — подождём
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(
      this.describeNotRunning("sidecar not responding to ping after startup"),
    );
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    // мягко просим выйти
    try {
      child.stdin?.end();
    } catch {
      /* noop */
    }
    // принудительно
    const killer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await new Promise<void>((resolve) => child.once("exit", () => { clearTimeout(killer); resolve(); }));
    this.child = null;
  }

  /** Выполнить RPC-запрос к sidecar и дождаться ответа по id. */
  request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || !this.child.stdin?.writable) {
      return Promise.reject(new Error(this.describeNotRunning()));
    }
    const id = this.nextId++;
    const payload: RpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };
    const frame = encodeFrame(payload);

    return new Promise<unknown>((resolve, reject) => {
      // timeoutMs <= 0 (NO_TIMEOUT_MS) — ждать сколько нужно: upload/wait могут
      // идти часами, а дефолтные 30с их бы обрывали.
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`RPC timeout: ${method} (id=${id})`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Разбор входящего stdout: нарезаем на кадры и маршрутизируем. */
  private onStdout(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= FRAME_HDR) {
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > 64 * 1024 * 1024) {
        // Протоколная ошибка — кадр слишком большой/нулевой. Отбрасываем 1 байт
        // и продолжаем (устойчивость к рассинхрону) — но логируем.
        process.stderr.write(`[sidecar-manager] bad frame length=${len}; resyncing\n`);
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < FRAME_HDR + len) break; // ждём остаток
      const frameBuf = this.buf.subarray(FRAME_HDR, FRAME_HDR + len);
      this.buf = this.buf.subarray(FRAME_HDR + len);
      this.handleFrame(frameBuf.toString("utf8"));
    }
  }

  private handleFrame(text: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(text) as RpcResponse;
    } catch (e) {
      process.stderr.write(`[sidecar-manager] non-JSON on stdout, ignoring: ${text.slice(0, 80)}\n`);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return; // поздний ответ/событие без ожидающего
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`sidecar error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (typeof msg === "object" && msg && "event" in msg) {
      // Потоковое событие: {"jsonrpc":"2.0","event":name,"params":{...}}
      const name = String((msg as { event: unknown }).event);
      const params = (msg as { params?: unknown }).params;
      for (const cb of this.eventCbs) cb(name, params);
    } else {
      process.stderr.write(`[sidecar-manager] unrecognized message: ${text.slice(0, 200)}\n`);
    }
  }
}

/** Кодирует объект в фрейм: 4 байта BE длины + UTF-8 JSON. */
export function encodeFrame(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.alloc(FRAME_HDR + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, FRAME_HDR);
  return frame;
}

export { binName };
