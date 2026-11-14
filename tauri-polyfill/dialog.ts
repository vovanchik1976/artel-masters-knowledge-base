/**
 * Полифилл @tauri-apps/plugin-dialog → window.fwCloud (Electron dialog в main).
 *
 * mainline UI использует:
 *   open({multiple, directory, title})      → путь/массив/null  (выбор файла/папки)
 *   save({title, defaultPath})              → путь/null          (сохранить как)
 *   ask(message, {title, kind, okLabel, cancelLabel})  → boolean
 *   message(message, {title, kind, okLabel})            → void
 *
 * Все четыре реализуются командами моста: window.showOpenDialog /
 * window.showSaveDialog / window.showMessageBox (ask=buttons [Отмена, OK],
 * message=только OK).
 */

interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface SaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

type InvokeFn = <R = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<R>;

function bridge(): InvokeFn {
  const api = (window as unknown as { fwCloud?: { invoke: InvokeFn } }).fwCloud;
  if (!api) throw new Error("fwCloud bridge недоступен");
  return api.invoke.bind(api);
}

/** Аналог dialog.open(): выбор файла или папки. */
export async function open(options?: OpenOptions): Promise<string | string[] | null> {
  const multiple = !!options?.multiple;
  const directory = !!options?.directory;
  // properties для Electron dialog.showOpenDialog:
  //   directory без файлов → только openDirectory;
  //   directory + file      → openFile + openDirectory;
  //   иначе                 → openFile.
  const props: string[] = [];
  if (directory && !multiple) props.push("openDirectory");
  else {
    props.push("openFile");
    if (directory) props.push("openDirectory");
    if (multiple) props.push("multiSelections");
  }

  const res = await bridge()<{ canceled: boolean; filePaths: string[] }>("window.showOpenDialog", {
    title: options?.title,
    defaultPath: options?.defaultPath,
    properties: props,
    // Фильтр типов файлов (SP-15: выбор фото карточки) — Electron dialog.filters.
    filters: options?.filters,
  });
  if (res.canceled) return null;
  if (multiple) return res.filePaths;
  return res.filePaths[0] ?? null;
}

/** Аналог dialog.save(): выбор пути сохранения. */
export async function save(options?: SaveOptions): Promise<string | null> {
  const res = await bridge()<{ canceled: boolean; filePath: string | null }>("window.showSaveDialog", {
    title: options?.title,
    defaultPath: options?.defaultPath,
  });
  return res.canceled ? null : res.filePath;
}

/** Аналог dialog.ask(): вопрос с кнопками [cancelLabel, okLabel]. */
export async function ask(message: string, options?: ConfirmOptions): Promise<boolean> {
  const res = await bridge()<{ response: number }>("window.showMessageBox", {
    message,
    title: options?.title,
    kind: options?.kind,
    buttons: [options?.cancelLabel ?? "Cancel", options?.okLabel ?? "OK"],
    defaultId: 1,
    cancelId: 0,
  });
  // index 1 = OK
  return res.response === 1;
}

/** Аналог dialog.message(): информационное сообщение. */
export async function message(message: string, options?: ConfirmOptions): Promise<void> {
  await bridge()<{ response: number }>("window.showMessageBox", {
    message,
    title: options?.title,
    kind: options?.kind,
    buttons: [options?.okLabel ?? "OK"],
    defaultId: 0,
  });
}
