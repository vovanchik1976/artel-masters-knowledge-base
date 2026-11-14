/**
 * Подписи вкладок: равные ширины, полный текст без многоточия, полный доступ.
 *
 * История: 2026-11-01 — «вкладки сжимаются, длинная подпись заканчивается
 * многоточием, полное название в тултипе». 2026-11-04 (D-170) владелец
 * уточнил: ширины вкладок должны быть РАВНЫМИ, многоточие не устраивает,
 * переполнение — горизонтальный скролл. Теперь `layoutTabStrip()` меряет
 * самую широкую подпись и задаёт всем вкладкам одну ширину (`--tab-w`):
 * влезают — растянуты на всю панель, не влезают — панель скроллится.
 * Тултип/`aria-label` с полным названием остаются (T7), обрезки нет.
 *
 * Модуль не тянет DOM на импорте: `syncTabTitles()`/`layoutTabStrip()`/
 * `enableTabStripWheelScroll()` терпят окружение без `document` (юнит-тесты),
 * `tabA11y()`/`equalTabWidth()`/`wheelScrollDelta()` — чистые функции.
 */

export interface TabA11y {
  /** Нативный тултип: показывается при наведении на обрезанную подпись. */
  title: string;
  /** Доступное имя вкладки для скринридера. */
  ariaLabel: string;
}

/**
 * Подпись вкладки → атрибуты доступности. Пустая/отсутствующая подпись
 * (вкладка ещё не локализована) ничего не перетирает: `null`.
 */
export function tabA11y(label: string | null | undefined): TabA11y | null {
  const text = (label ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { title: text, ariaLabel: text };
}

/**
 * Разложить подписи по вкладкам текущего документа. Вызывать ПОСЛЕ
 * `applyStaticI18n()` — иначе в тултип попадёт текст другого языка.
 */
export function syncTabTitles(doc: Document | null = typeof document === "undefined" ? null : document): void {
  if (!doc) return;
  doc.querySelectorAll<HTMLElement>(".tab").forEach((button) => {
    const label = button.querySelector<HTMLElement>(".tab-label");
    const a11y = tabA11y(label?.textContent);
    if (!a11y) return;
    button.title = a11y.title;
    button.setAttribute("aria-label", a11y.ariaLabel);
  });
}

/**
 * Равная ширина вкладки (D-170): максимум из «доля окна» и «минимум по самой
 * широкой подписи». Когда доли хватает — вкладки растягиваются ровно на всю
 * панель; когда не хватает — панель едет горизонтально (решение владельца
 * 2026-11-04: многоточие и перенос строк отклонены, переполнение — скролл).
 * Чистая функция — покрыта юнит-тестами (tabs-overflow T8).
 */
export function equalTabWidth(
  availablePx: number,
  gapPx: number,
  count: number,
  minPx: number,
): number {
  if (count <= 0) return Math.max(0, Math.ceil(minPx));
  const usable = availablePx - gapPx * (count - 1);
  if (usable <= 0) return Math.max(0, Math.ceil(minPx));
  return Math.max(Math.ceil(minPx), Math.floor(usable / count));
}

/**
 * Сколько пикселей прокрутить панель вкладок колесом мыши (D-170).
 *
 * Чистая функция для юнит-тестов: колесо над панелью едет ГОРИЗОНТАЛЬНО,
 * только когда панели есть что скроллить; вертикально-доминантное движение
 * берём из `deltaY`, горизонтальное (тачпад/Shift+колесо) — из `deltaX`.
 * `null` — перехватывать событие не нужно (нет переполнения): страница
 * скроллится как обычно, колесо не «запирается».
 */
export function wheelScrollDelta(
  deltaX: number,
  deltaY: number,
  hasHorizontalOverflow: boolean,
): number | null {
  if (!hasHorizontalOverflow) return null;
  return Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
}

/**
 * Колесо мыши над панелью вкладок скроллит её по горизонтали (D-170,
 * дополнение владельца). Вешается ОДИН раз (гард по data-атрибуту — вызов
 * идемпотентен). `passive: false` обязателен: без preventDefault панель
 * скроллилась бы И страница одновременно.
 */
export function enableTabStripWheelScroll(
  doc: Document | null = typeof document === "undefined" ? null : document,
): void {
  if (!doc) return;
  const strip = doc.querySelector<HTMLElement>(".tabs");
  if (!strip || strip.dataset.wheelScroll === "1") return;
  strip.dataset.wheelScroll = "1";
  strip.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      const delta = wheelScrollDelta(
        event.deltaX,
        event.deltaY,
        strip.scrollWidth > strip.clientWidth,
      );
      if (delta === null || delta === 0) return;
      event.preventDefault();
      // Прямое присваивание scrollLeft — мгновенный отклик; smooth-анимация
      // на частых дельтах колеса даёт «резиновый» лаг (поэтому в CSS .tabs
      // scroll-behavior: smooth не ставится).
      strip.scrollLeft += delta;
    },
    { passive: false },
  );
}

/**
 * Равные ширины вкладок (D-170). Меряет самую широкую подпись (полный текст,
 * без многоточия) и ставит на `.tabs` переменную `--tab-w`:
 *   - все вкладки получают ОДНУ ширину;
 *   - если сумма равных ширин влезает в панель — они растягиваются ровно на
 *     всю её ширину;
 *   - если нет — ширина равна минимуму по подписи, панель скроллится по
 *     горизонтали (CSS: `overflow-x: auto` + тонкий скроллбар в стиле темы).
 *
 * Задел на будущее: количество вкладок и самая широкая подпись берутся из DOM
 * на каждом вызове — новая вкладка (или новый язык/тема с другим
 * letter-spacing) не требуют правок CSS/JS. Вызывать после смены языка,
 * темы, при resize и после загрузки шрифтов (см. App.ts).
 */
export function layoutTabStrip(
  doc: Document | null = typeof document === "undefined" ? null : document,
): void {
  if (!doc) return;
  const strip = doc.querySelector<HTMLElement>(".tabs");
  if (!strip) return;
  // Скрытые вкладки (например, «Владелец» для не-владельца) не участвуют:
  // и в замере, и в количестве — иначе N завышается и все ширины уезжают.
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".tab")).filter(
    (tab) => tab.offsetParent !== null,
  );
  if (tabs.length === 0) return;

  // Самая широкая подпись задаёт минимальную ширину вкладки. Меряем через
  // Range — точная ширина ТЕКСТА независимо от того, обрезан ли он сейчас
  // (scrollWidth у обрезанной подписи врёт на пару пикселей).
  let maxLabelPx = 0;
  for (const tab of tabs) {
    const label = tab.querySelector<HTMLElement>(".tab-label");
    if (!label) continue;
    const range = doc.createRange();
    range.selectNodeContents(label);
    maxLabelPx = Math.max(maxLabelPx, range.getBoundingClientRect().width);
  }

  const tabStyle = getComputedStyle(tabs[0]);
  const tabPadH =
    (parseFloat(tabStyle.paddingLeft) || 0) + (parseFloat(tabStyle.paddingRight) || 0);
  const tabBorderH =
    (parseFloat(tabStyle.borderLeftWidth) || 0) + (parseFloat(tabStyle.borderRightWidth) || 0);
  const minPx = maxLabelPx + tabPadH + tabBorderH;

  const stripStyle = getComputedStyle(strip);
  const gapPx = parseFloat(stripStyle.columnGap) || 0;
  const stripPadH =
    (parseFloat(stripStyle.paddingLeft) || 0) + (parseFloat(stripStyle.paddingRight) || 0);
  const availablePx = strip.clientWidth - stripPadH;

  strip.style.setProperty(
    "--tab-w",
    `${equalTabWidth(availablePx, gapPx, tabs.length, minPx)}px`,
  );
}
