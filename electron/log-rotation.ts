/**
 * Ротация и очистка файловых логов клиента (BUG-LOG-ROTATION-001).
 *
 * Инвариант (требование владельца 2026-09-28): максимум 2 файла на лог
 * (активный + одна ротационная копия), размер 5–10 МБ, файлы старше 7 дней
 * удаляются. Ранее ротация была «>5 МБ → .1.log» без prune — старые копии
 * накапливались бесконечно, а «максимум 2 файла» не было явным инвариантом.
 *
 * Best-effort: все ошибки игнорируются — лог не должен ломать приложение.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Порог ротации: 5 МБ (в диапазоне 5–10 МБ; экономнее для RCA-прогонов). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Возраст: файлы старше 7 дней удаляются. */
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ротировать `<dir>/<base>` в одну копию, если он больше `maxBytes`.
 * Максимум 2 файла: `<base>` и `<stem>.1.log` (stem = base без `.log`).
 * При ротации старая `.1.log` перезаписывается rename'ом — больше 2 файлов
 * на лог не накапливается.
 */
export function rotateLogFile(
  dir: string,
  base: string,
  maxBytes: number = LOG_MAX_BYTES,
): void {
  const file = path.join(dir, base);
  try {
    if (fs.statSync(file).size > maxBytes) {
      const stem = base.replace(/\.log$/i, "");
      fs.renameSync(file, path.join(dir, `${stem}.1.log`));
    }
  } catch {
    /* файла ещё нет или stat не удался — это норма */
  }
}

/**
 * Удалить файлы в `dir`, подходящие под `nameRe` и старше `maxAgeMs` (по mtime).
 */
export function pruneOldLogs(
  dir: string,
  nameRe: RegExp,
  maxAgeMs: number = LOG_MAX_AGE_MS,
): void {
  try {
    const entries = fs.readdirSync(dir);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of entries) {
      if (!nameRe.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* каталога может не быть — это норма */
  }
}

/**
 * Все файловые логи клиента: engine-core(.1).log, download-rca(.1).log,
 * bridge(.1).log, auth-flow(.1).log, main-sidecar.log, tdlib.log(.old). Ротационные копии
 * (`.1.log`) и TDLib-архив (`.old`) тоже чистятся по возрасту.
 */
export const CLIENT_LOG_NAME_RE =
  /^(engine-core|download-rca|bridge|auth-flow|main-sidecar|tdlib)(\.\d+)?\.log(\.old)?$/i;
