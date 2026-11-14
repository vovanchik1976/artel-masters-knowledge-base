/**
 * Лайтбокс медиа карточки (SP-15 v3, D-069): увеличение ОРИГИНАЛА без потерь.
 *
 * «Без потерь» = показываем сам файл (`full`), а масштабирует движок отрисовки
 * (GPU-трансформ от исходного битмапа). Никаких тайлов и серверных превью-пирамид —
 * CPU/диск VPS не тратятся.
 *
 * Математика зума/панорамирования вынесена в чистые функции (тесты без DOM).
 */

import { revokeObjectUrls } from "./MediaAuth";

export interface ZoomState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;

export interface LightboxItem {
  fullUrl: string;
  thumbUrl?: string;
  width: number | null;
  height: number | null;
  /**
   * Ленивый резолвер ОРИГИНАЛА для защищённых медиа (`blob:` с токеном).
   * Пока он грузится, показываем превью; отказ — тихий (остаётся превью).
   */
  resolveFull?: () => Promise<string>;
}

/**
 * Гвардия поколения показа: ответ «медленного» резолвера применяется, только
 * если показ не переключился на другое фото (иначе старое фото перетирает новое).
 */
export function createShowGuard(): { begin: () => number; isCurrent: (token: number) => boolean } {
  let token = 0;
  return {
    begin: () => {
      token += 1;
      return token;
    },
    isCurrent: (value: number) => value === token,
  };
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Нормализация `-0` → `0` (иначе трансформ получает «минус ноль»). */
function normZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Зум вокруг точки (курсор/палец): точка под курсором остаётся на месте. */
export function zoomAt(
  state: ZoomState,
  factor: number,
  point: { x: number; y: number },
): ZoomState {
  const next = clampScale(state.scale * factor);
  if (next === state.scale) return { ...state };
  const ratio = next / state.scale;
  return {
    scale: next,
    offsetX: normZero(point.x - (point.x - state.offsetX) * ratio),
    offsetY: normZero(point.y - (point.y - state.offsetY) * ratio),
  };
}

/** Границы панорамирования: картинка не уезжает целиком за пределы вьюпорта. */
export function clampPan(
  state: ZoomState,
  viewport: { w: number; h: number },
  image: { w: number; h: number },
): ZoomState {
  const scaledW = Math.max(0, image.w * state.scale);
  const scaledH = Math.max(0, image.h * state.scale);
  const maxX = Math.max(0, (scaledW - viewport.w) / 2);
  const maxY = Math.max(0, (scaledH - viewport.h) / 2);
  return {
    scale: state.scale,
    offsetX: normZero(Math.min(maxX, Math.max(-maxX, state.offsetX))),
    offsetY: normZero(Math.min(maxY, Math.max(-maxY, state.offsetY))),
  };
}

/** Следующий индекс с заворотом (стрелки ←/→). */
export function stepIndex(current: number, delta: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return ((current + delta) % total + total) % total;
}

/** Двойной клик: 1× ↔ 2×. */
export function toggleScale(scale: number): number {
  return scale > MIN_SCALE ? MIN_SCALE : Math.min(2, MAX_SCALE);
}

/**
 * Открыть лайтбокс поверх окна (клик по превью в карточке).
 *
 * Зум — колесо/пинч, панорамирование — drag, двойной клик — 1×↔2×, стрелки —
 * переход между фото, Esc/клик по фону — закрыть. Грузим ОРИГИНАЛ (`fullUrl`).
 */
export function openMediaLightbox(items: LightboxItem[], startIndex = 0): void {
  if (!items.length || typeof document === "undefined") return;
  let index = Math.min(Math.max(0, startIndex), items.length - 1);
  let state: ZoomState = { scale: MIN_SCALE, offsetX: 0, offsetY: 0 };
  let dragging = false;
  let dragFrom = { x: 0, y: 0 };
  // Оригиналы защищённых медиа тянем лениво и один раз на фото (blob-адреса
  // освобождаем при закрытии — иначе утечка до перезапуска окна).
  const guard = createShowGuard();
  const resolved = new Map<number, string>();
  const createdBlobs: string[] = [];

  const overlay = document.createElement("div");
  overlay.className = "media-lightbox";
  overlay.innerHTML = `
    <div class="media-lightbox-stage"><img class="media-lightbox-img" alt="" /></div>
    <button type="button" class="media-lightbox-close" title="Esc">×</button>
    <button type="button" class="media-lightbox-prev" title="←">‹</button>
    <button type="button" class="media-lightbox-next" title="→">›</button>
    <div class="media-lightbox-hint"></div>`;
  const stage = overlay.querySelector<HTMLElement>(".media-lightbox-stage")!;
  const img = overlay.querySelector<HTMLImageElement>(".media-lightbox-img")!;
  const hint = overlay.querySelector<HTMLElement>(".media-lightbox-hint")!;

  const apply = (): void => {
    img.style.transform = `translate(${state.offsetX}px, ${state.offsetY}px) scale(${state.scale})`;
    hint.textContent = `${index + 1} / ${items.length}  ·  ${state.scale.toFixed(1)}×`;
  };

  const show = (next: number): void => {
    index = stepIndex(next, 0, items.length);
    state = { scale: MIN_SCALE, offsetX: 0, offsetY: 0 };
    const item = items[index];
    const token = guard.begin();
    const cached = resolved.get(index);
    // Превью — сразу; оригинал защищённых медиа подменяем, когда он скачан
    // (незащищённые грузит сам тег — как раньше).
    if (cached) img.src = cached;
    else if (item.resolveFull) img.src = item.thumbUrl || item.fullUrl;
    else img.src = item.fullUrl;
    apply();
    if (!item.resolveFull || cached) return;
    const at = index;
    void item
      .resolveFull()
      .then((url) => {
        if (!url) return;
        resolved.set(at, url);
        if (url.startsWith("blob:")) createdBlobs.push(url);
        if (!guard.isCurrent(token)) return; // показали уже другое фото
        img.src = url;
      })
      .catch(() => {
        /* нет оригинала — остаётся превью (fail-open) */
      });
  };

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    revokeObjectUrls(createdBlobs);
    createdBlobs.length = 0;
    overlay.remove();
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
    else if (ev.key === "ArrowLeft") show(index - 1);
    else if (ev.key === "ArrowRight") show(index + 1);
  };

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay || ev.target === stage) close();
  });
  overlay.querySelector(".media-lightbox-close")!.addEventListener("click", close);
  overlay.querySelector(".media-lightbox-prev")!.addEventListener("click", () => show(index - 1));
  overlay.querySelector(".media-lightbox-next")!.addEventListener("click", () => show(index + 1));

  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    state = zoomAt(state, factor, { x: ev.clientX - rect.left - rect.width / 2, y: ev.clientY - rect.top - rect.height / 2 });
    state = clampPan(state, { w: rect.width, h: rect.height }, { w: img.clientWidth || 1, h: img.clientHeight || 1 });
    apply();
  }, { passive: false });

  stage.addEventListener("mousedown", (ev) => {
    if (state.scale <= MIN_SCALE) return;
    dragging = true;
    dragFrom = { x: ev.clientX - state.offsetX, y: ev.clientY - state.offsetY };
  });
  window.addEventListener("mouseup", () => { dragging = false; });
  stage.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    state = clampPan(
      { ...state, offsetX: ev.clientX - dragFrom.x, offsetY: ev.clientY - dragFrom.y },
      { w: rect.width, h: rect.height },
      { w: img.clientWidth || 1, h: img.clientHeight || 1 },
    );
    apply();
  });
  stage.addEventListener("dblclick", () => {
    state = { ...state, scale: toggleScale(state.scale), offsetX: 0, offsetY: 0 };
    apply();
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  show(index);
}

