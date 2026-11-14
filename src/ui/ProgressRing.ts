/**
 * Кольцо прогресса (SP-15 срез 3b) — SVG-индикатор передачи ОДНОГО фото.
 *
 * Зачем: галерея превью показывает состояние карточки, а сам процесс отправки
 * (init → TDLib-передача → пост бота в тему) для пользователя иначе невидим
 * дольше минуты на крупных кадрах. Кольцо — «этот файл сейчас уходит».
 *
 * Геометрия — чистая функция (тестируется без DOM). `progress === null` —
 * неопределённое состояние (передача ещё не отдала байты): кольцо крутится.
 */

export interface RingGeometry {
  radius: number;
  circumference: number;
  dashOffset: number;
}

/** Радиус/длина окружности/смещение штриха для прогресса 0..1 (`null` — спиннер). */
export function ringGeometry(progress: number | null, size = 32, stroke = 3): RingGeometry {
  const clampedStroke = Number.isFinite(stroke) && stroke > 0 ? stroke : 3;
  const radius = Math.max(1, ((Number.isFinite(size) && size > 0 ? size : 32) - clampedStroke) / 2);
  const circumference = 2 * Math.PI * radius;
  const finite = progress !== null && Number.isFinite(progress as number);
  const ratio = finite ? Math.min(1, Math.max(0, progress as number)) : 0;
  // Спиннер: виден сегмент в четверть окружности (иначе пустое кольцо «залипло» бы).
  const offset = finite ? circumference * (1 - ratio) : circumference * 0.75;
  return { radius, circumference, dashOffset: Number(offset.toFixed(3)) };
}

export function ringIsIndeterminate(progress: number | null): boolean {
  return progress === null || !Number.isFinite(progress as number);
}

/** Разметка кольца (вставляется в шаблон элемента очереди). */
export function renderProgressRingHtml(progress: number | null = null, size = 32): string {
  const stroke = 3;
  const geo = ringGeometry(progress, size, stroke);
  const center = size / 2;
  const cls = ringIsIndeterminate(progress) ? "fw-ring fw-ring--spin" : "fw-ring";
  return (
    `<svg class="${cls}" data-ring width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="status">` +
    `<circle class="fw-ring-track" cx="${center}" cy="${center}" r="${geo.radius.toFixed(3)}" ` +
    `fill="none" stroke-width="${stroke}"></circle>` +
    `<circle class="fw-ring-value" cx="${center}" cy="${center}" r="${geo.radius.toFixed(3)}" ` +
    `fill="none" stroke-width="${stroke}" stroke-dasharray="${geo.circumference.toFixed(3)}" ` +
    `stroke-dashoffset="${geo.dashOffset}" ` +
    `transform="rotate(-90 ${center} ${center})"></circle>` +
    `</svg>`
  );
}

/**
 * Обновить кольцо внутри `host` (перерисовка бегущей передачи без пересборки DOM:
 * тег `<img>`/`<svg>` не перезагружаем, иначе мелькание и потеря анимации).
 */
export function setProgressRing(host: HTMLElement | null, progress: number | null): void {
  const svg = host?.querySelector<SVGSVGElement>("svg[data-ring]");
  if (!svg) return;
  const arc = svg.querySelector<SVGCircleElement>(".fw-ring-value");
  const indeterminate = ringIsIndeterminate(progress);
  svg.classList.toggle("fw-ring--spin", indeterminate);
  if (arc) arc.setAttribute("stroke-dashoffset", String(ringGeometry(progress).dashOffset));
}
