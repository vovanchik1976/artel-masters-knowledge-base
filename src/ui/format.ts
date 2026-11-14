/**
 * Общие форматтеры байт/скорости/длительности/ETA (Task 2 «взрослого» ETA).
 *
 * Единственное место форматирования — раньше было два расходящихся formatSpeed
 * (Progress.ts до MB/s, DownloadPage.ts до GB/s с другим округлением) и
 * несогласованный formatDuration (ceil для секунд, floor для минут).
 *
 * quantizeEta — квантование ETA в корзины: текст не дёргается на каждом emit
 * (раньше «3 мин 40 с» → «2 мин 05» → «4 мин 12» каждые 200 мс).
 */
import { t } from "../i18n";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Человекочитаемые байты: 0 → "0 B", 1536 → "1.5 KB", 4.61GB → "4.6 GB". */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : digits)} ${BYTE_UNITS[i]}`;
}

/** Скорость байт/с: "500 KB/s", "5.0 MB/s", "1.5 GB/s" (GB/s теперь поддержан). */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
  const i = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bps) / Math.log(1024)),
  );
  const v = bps / Math.pow(1024, i);
  // B/s и KB/s — целые (шум ниже не имеет смысла), MB/s+ — один знак.
  return `${v.toFixed(i <= 1 ? 0 : 1)} ${BYTE_UNITS[i]}/s`;
}

/**
 * Квантование ETA в корзины (с):
 *   <10с → шаг 1с; <60с → шаг 5с; <10мин → шаг 30с; дальше → шаг 60с.
 * Возвращает минимум 1с для положительных значений.
 */
export function quantizeEta(sec: number): number {
  if (!(sec > 0)) return 0;
  if (sec < 10) return Math.max(1, Math.round(sec));
  if (sec < 60) return Math.max(5, Math.round(sec / 5) * 5);
  if (sec < 600) return Math.round(sec / 30) * 30;
  return Math.round(sec / 60) * 60;
}

/**
 * Длительность по i18n-юнитам: "45с", "1 мин 35 с", "1 ч 05 мин".
 * Единое округление — раньше ceil(<60с)/floor(мин) давали скачки «59 с → 1 мин 0 с».
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const sec = s % 60;
  const minTotal = Math.floor(s / 60);
  const min = minTotal % 60;
  const h = Math.floor(minTotal / 60);
  const uSec = t("progress.unit_sec");
  const uMin = t("progress.unit_min");
  const uHour = t("progress.unit_hour");
  if (minTotal === 0) return `${s}${uSec}`;
  if (h === 0) return `${min}${uMin} ${sec}${uSec}`;
  return `${h}${uHour} ${String(min).padStart(2, "0")}${uMin}`;
}

/**
 * ETA-строка для UI:
 *   null / <=0 → null (терминальные состояния рисует сам ProgressUI);
 *   >24ч → честный ключ progress.over_24h (раньше ETA молча скрывался);
 *   иначе → квантованная длительность.
 */
export function formatEta(sec: number | null): string | null {
  if (sec === null || !(sec > 0)) return null;
  if (sec > 86400) return t("progress.over_24h");
  return formatDuration(quantizeEta(sec));
}
