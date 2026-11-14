/**
 * sources — подписи источников сводки (SP-19 S1, `D-087`).
 *
 * Ссылок в тексте сводки не бывает (§4 п.9): клиент рисует их отдельным списком.
 * Источник — либо кликабельный форум-URL карточки ремонта, либо адрес фрагмента
 * в индексе (`kb_v4/case-24:12-40`), либо запись живого знания (`form:{pair_key}`,
 * опыт мастеров: у неё URL нет вовсе — меткой служит первая строка пары).
 *
 * Тип продублирован структурно (НЕ импорт из ../api): tsconfig.tests.json не
 * компилирует src/api.ts (import.meta) — импорт сломал бы test:ui.
 * Структурная совместимость с CardSourcePayload из api.ts.
 */
export interface SourcePayload {
  path: string;
  url: string;
  title?: string;
  score?: number;
}

/** Метка источника: форум-URL → адрес фрагмента → текст живого знания. */
export function sourceLabel(source: SourcePayload): string {
  const url = (source.url || "").trim();
  if (url) return url;
  const path = (source.path || "").trim();
  // Живое знание (`form:{pair_key}`): адрес пары мастеру ничего не говорит —
  // показываем сам совет («Симптом: …»), он и есть источник.
  if (path.startsWith("form:") || path.startsWith("chat:")) {
    const title = (source.title || "").trim();
    if (title) return title;
  }
  return path;
}

/** Источники сводки строками (пусто → [] — блок «Источники» не рисуется). */
export function formatSources(sources?: SourcePayload[] | null): string[] {
  if (!sources || sources.length === 0) return [];
  return sources.map(sourceLabel).filter((label) => label.length > 0);
}
