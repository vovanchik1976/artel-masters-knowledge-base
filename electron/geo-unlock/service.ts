/**
 * GEO_Unlock — сервисный слой main-процесса: валидация входа + платный гейт.
 *
 * Зачем отдельный слой, а не прямой вызов ядер из IPC-диспетчера:
 *   1. ядра (`samsung.ts` / `lg.ts`) должны остаться «чистыми» портами апстрима —
 *      любая проверка в них сломала бы 1:1-соответствие и усложнила бы сверку;
 *   2. рендерер — НЕдоверенный код: он не должен иметь возможности попросить
 *      запись «в тот же файл» (in-place), отрицательный регион или путь без
 *      проверки. Всё это отсекается здесь, до открытия файлов;
 *   3. платный доступ проверяется в ОДНОМ месте (`requireGrant`), поэтому
 *      забыть гейт на новой команде нельзя — без grant патч просто не начнётся.
 *
 * 💰 ЧТО ПЛАТНОЕ, А ЧТО НЕТ (решение владельца 2026-11-01, D-148 + D-149):
 *   * ПЛАТНО — только правка ЖУРНАЛЬНОГО МАССИВА в NVRAM-пуле раздела eMMC
 *     (`/dev/mmcblk0p31`: 256 записей × 512 Б, parity + 3×CRC32C). Это
 *     {@link PAID_TOOL}, единственная живая копия (драйвер `tztv-eeprom` читает
 *     регион именно оттуда) и единственная операция, которая зовёт
 *     `requireGrant`. Ядро помечает такие копии `kind: "record"`.
 *   * БЕСПЛАТНО — дамп микросхемы NVM Samsung (24C512): плоский образ 64 КиБ,
 *     причём файл РОВНО 64 КиБ и образ начинается с нуля файла (`kind: "image"`).
 *   * БЕСПЛАТНО — LG NVM (24C256) «Area Option»: разблокировка старых
 *     моделей через правку NVM не тарифицируется. Патч LG намеренно НЕ требует
 *     grant'а, чтобы мастеру не нужен был ни баланс, ни интернет.
 *   * БЕСПЛАТНО — все сканы и `checkOnly` (только отчёт, ничего не пишут).
 *   * БЕСПЛАТНО владельцу (OWNER_ID): сервер выдаёт grant `kind: "owner"`,
 *     списания нет; тариф дампа при этом остаётся `paid` (это тариф, а не факт
 *     списания).
 *
 * ⛔ ТЕОРИИ «GPP1» БОЛЬШЕ НЕТ (D-150, 2026-11-01). Решение владельца: это была
 * ошибочная гипотеза стадии разбора дампа ТВ, поэтому отдельного «плоского»
 * класса дампов в инструменте не существует. Дамп либо микросхема NVM 24C512,
 * либо дамп раздела eMMC: всё, что не опознано как 64 КиБ-образ микросхемы,
 * считается дампом раздела (платно). Вердикт даёт {@link classifySamsungDump},
 * отказов «такой дамп не поддерживается» больше нет.
 *
 * Тариф решается СОДЕРЖИМЫМ дампа ({@link classifySamsungDump}), а не именем
 * команды: один и тот же `geo_samsung_patch` бесплатен на 64 КиБ-дампе
 * микросхемы и платный на дампе раздела eMMC с журналом.
 *
 * ⚠️ ЧЕСТНО О ГРАНИЦЕ ЗАЩИТЫ: сервер считает бесплатные попытки и списывает
 * баллы, но ЛОКАЛЬНЫЙ офлайн-файл всё равно остаётся у пользователя. Клиентский
 * гейт — организационный барьер, а не DRM: он делает платный поток обязательным
 * (без обращения к серверу UI не получит grant), но не защищает байты дампа от
 * копирования. Криптоподпись grant'а сервером — следующий шаг, он снимает и
 * обход IPC напрямую.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { AreaNotFound, NotLgNvm, patchLg, scanLg } from "./lg";
import type { LgPatchResult, LgScanResult } from "./lg";
import { IMG_SIZE, patchSamsung, scanSamsung } from "./samsung";
import type { CopyInfo, ImageCrcMode, SamsungPatchResult, SamsungScanResult } from "./samsung";

/** Ошибка «нет права на платную операцию» (рендерер показывает форму оплаты). */
export class LicenseRequired extends Error {
  constructor(message = "LICENSE_REQUIRED") {
    super(message);
    this.name = "LicenseRequired";
  }
}

/** Ошибка валидации входа (путь/значение/режим). */
export class BadInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadInput";
  }
}

/**
 * Единственная платная операция GEO_Unlock — правка журнального массива в
 * NVRAM-пуле раздела eMMC (`/dev/mmcblk0p31`), т.е. копий `kind: "record"`.
 *
 * Имя используется и сервером (`POST /desktop/tools/geo-unlock/grant`), и
 * рендерером: UI спрашивает grant ТОЛЬКО когда скан показал журнальные копии, а
 * плоский образ и LG-патч идут напрямую. Новых платных операций без решения
 * владельца не заводить.
 */
export const PAID_TOOL = "samsung_p31" as const;

/** Тариф операции патча: `free` — плоский образ/отчёт, `paid` — раздел eMMC. */
export type LicenseMode = "free" | "paid";

/** Результат патча Samsung + тариф дампа (для UI и логов). */
export interface GeoPatchResult extends SamsungPatchResult {
  /**
   * Тариф ДАМПА, а не факт списания: `paid` — в дампе есть журнальный массив
   * раздела eMMC (живая копия, патч платный), `free` — только плоский образ.
   * В режиме `checkOnly` тариф тоже показывается, хотя отчёт ничего не стоит.
   */
  license: LicenseMode;
  /**
   * `true` — в дампе не было НИ ОДНОЙ записи журнала: поправлены только плоские
   * копии eeprom. Значит живая копия не тронута, и на работающем ТВ регион НЕ
   * изменится (драйвер `tztv-eeprom` читает регион из журнала NVRAM-пула раздела
   * eMMC). Рендерер показывает по этому флагу честное предупреждение — сам он
   * состав копий не считает (main — единственный источник вердикта).
   *
   * Флаг не зависит от тарифа: платный дамп БЕЗ журнала (снята только область
   * плоских копий) тоже получает `true` — раньше такой случай молчал и
   * рапортовал зелёный успех.
   */
  flatOnly: boolean;
}

/**
 * Нужен ли grant: платна ТОЛЬКО правка журнального массива раздела eMMC.
 *
 * Дискриминатор — содержимое дампа: `record` — записи журнала в NVRAM-пуле
 * (единственная живая копия, её читает драйвер `tztv-eeprom`), `image` — плоский
 * образ NVM-микросхемы. Функция экспортируется, чтобы рендерер спрашивал grant
 * ДО патча — по тому же признаку, что и сервис.
 */
export function needsGrantForSamsung(copies: CopyInfo[]): boolean {
  return copies.some(copy => copy.kind === "record");
}

/** Что за дамп перед нами — от этого зависит тариф. */
export type SamsungDumpKind =
  /** Дамп раздела eMMC (журнальный массив в NVRAM-пуле, p31) — платно. */
  | "emmc-journal"
  /** Дамп микросхемы NVM 24C512: ровно 64 КиБ, образ с начала файла, бесплатно. */
  | "nvm24c512";

/**
 * Классификация дампа Samsung по найденным копиям и размеру файла.
 *
 * Правила (следствие решений владельца D-148/D-150):
 *   1. ровно один плоский образ С НАЧАЛА файла и файл ровно 64 КиБ — дамп
 *      микросхемы NVM 24C512, БЕСПЛАТНО;
 *   2. всё остальное — дамп раздела eMMC (журнальный массив p31, образы по
 *      смещениям, несколько копий, пустой список), ПЛАТНО.
 *
 * Микросхема 24C512 — это ровно 64 КиБ, поэтому «ровно 64 КиБ + образ с нуля» и
 * есть её дамп. Функция — ЕДИНСТВЕННЫЙ источник вердикта: и тариф, и решение
 * «спрашивать ли grant» идут отсюда, рендерер правил не повторяет.
 */
export function classifySamsungDump(copies: CopyInfo[], fileSize: number): SamsungDumpKind {
  const only = copies.length === 1 ? copies[0] : null;
  const isNvmChip =
    only !== null &&
    only.kind === "image" &&
    (only.imageBase ?? -1) === 0 &&
    fileSize === IMG_SIZE;
  return isNvmChip ? "nvm24c512" : "emmc-journal";
}

/**
 * Результат скана + готовый вердикт по тарифу.
 *
 * Рендерер не пересчитывает правила: `needsGrant` уже посчитан здесь, поэтому
 * UI и main не могут разойтись в решении «платно / бесплатно».
 */
export interface GeoSamsungScanResult extends SamsungScanResult {
  /** Что за дамп — см. {@link classifySamsungDump}. */
  dumpKind: SamsungDumpKind;
  /** Нужен ли grant для ПАТЧА (сам скан и `checkOnly` всегда бесплатны). */
  needsGrant: boolean;
}

/** Право на одну операцию патча, выданное сервером. */
export interface GeoGrant {
  /** Идентификатор выдачи на сервере (идемпотентность триала/пакета). */
  id: string;
  /**
   * `owner` — владелец (OWNER_ID): сервер не списывает ничего;
   * `package` — у мастера действующий пакет: цена операции и есть срок пакета
   *             (D-151), баллы не списываются и пробные попытки не тратятся;
   * `trial` — бесплатная попытка;
   * `paid` — зарезервировано на случай отдельной цены в баллах (сейчас не выдаётся).
   */
  kind: "owner" | "package" | "trial" | "paid";
}

/**
 * Проверка grant'а.
 *
 * Пустой/некорректный grant — `LicenseRequired`: UI обязан сначала сходить на
 * сервер (`POST /desktop/tools/geo-unlock/grant`), получить `{id, kind}` и
 * передать его сюда. Никаких «по умолчанию разрешено» нет.
 */
export function requireGrant(raw: unknown): GeoGrant {
  if (raw === null || raw === undefined || typeof raw !== "object") throw new LicenseRequired();
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const kind = obj.kind;
  if (!id) throw new LicenseRequired();
  if (kind !== "trial" && kind !== "paid" && kind !== "owner" && kind !== "package") {
    throw new LicenseRequired();
  }
  return { id, kind };
}

/** Обязательный абсолютный путь к существующему файлу. */
function requireFile(raw: unknown, field: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new BadInput(`${field}: шлях обов'язковий`);
  if (!path.isAbsolute(value)) throw new BadInput(`${field}: потрібен абсолютний шлях`);
  let st: fs.Stats;
  try {
    st = fs.statSync(value);
  } catch {
    throw new BadInput(`${field}: файл не знайдено`);
  }
  if (!st.isFile()) throw new BadInput(`${field}: це не файл`);
  return value;
}

/** Целое число в диапазоне (для region / Area Option). */
function requireInt(raw: unknown, field: string, max: number): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new BadInput(`${field}: очікується ціле 0..${max}`);
  }
  return value;
}

/**
 * Выходной путь: обязателен и НЕ должен совпадать с входом.
 *
 * UI никогда не патчит «на месте»: исходный дамп — это откат мастера, и ядро
 * апстрима тоже всегда пишет новый файл (два правила из FAQ утилиты).
 */
function requireOutput(raw: unknown, inputPath: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new BadInput("out: шлях обов'язковий");
  if (!path.isAbsolute(value)) throw new BadInput("out: потрібен абсолютний шлях");
  if (path.resolve(value) === path.resolve(inputPath)) {
    throw new BadInput("out: запис у вихідний файл заборонено (потрібен новий файл)");
  }
  return value;
}

/**
 * Скан дампа Samsung (бесплатный: только отчёт, ничего не пишется).
 *
 * Скан бесплатен всегда. Кроме отчёта по копиям возвращается готовый вердикт
 * тарифа (`dumpKind` / `needsGrant`), чтобы UI не пересчитывал правила сам.
 */
export function geoScanSamsung(args: Record<string, unknown>): GeoSamsungScanResult {
  const inputPath = requireFile(args.path, "path");
  const scan = scanSamsung(inputPath, args.verbose === true);
  const dumpKind = classifySamsungDump(scan.copies, fs.statSync(inputPath).size);
  return { ...scan, dumpKind, needsGrant: dumpKind === "emmc-journal" };
}

/**
 * Патч дампа Samsung. ПЛАТЕН только для журнального массива раздела eMMC.
 *
 * Гейт срабатывает по СОДЕРЖИМОМУ: ядро сначала находит копии и отдаёт их через
 * `onCopies` (до проверки `checkOnly` и до любой записи). Дальше:
 *   * `emmc-journal` — дамп раздела eMMC: нужен `grant` (владельцу сервер
 *     выдаёт `kind: "owner"`, списания нет);
 *   * `nvm24c512` — дамп микросхемы, бесплатно, grant не нужен.
 *
 * `checkOnly` разрешён без выходного пути: это отчёт по копиям, он бесплатен.
 */
export function geoPatchSamsung(args: Record<string, unknown>): GeoPatchResult {
  const inputPath = requireFile(args.path, "path");
  const region = requireInt(args.region, "region", 0xff);
  const crc = args.imageCrc;
  if (crc !== undefined && crc !== "auto" && crc !== "always" && crc !== "never") {
    throw new BadInput("imageCrc: auto | always | never");
  }
  const checkOnly = args.checkOnly === true;
  const outputPath = checkOnly ? undefined : requireOutput(args.out, inputPath);

  // Тариф по умолчанию «бесплатный»: если копий не найдётся вообще, операция
  // упадёт доменным rc=2 и ничего не спишет.
  let license: LicenseMode = "free";
  // «Нет рабочей копии»: в дампе РАЗДЕЛА eMMC не нашлось ни одной записи с регионом,
  // то есть патч плоских копий на работающем ТВ ничего не изменит. У дампа микросхемы
  // 24C512 флаг всегда false — там чип сам является носителем региона (D-154).
  let flatOnly = false;
  const inputSize = fs.statSync(inputPath).size;
  const result = patchSamsung({
    inputPath,
    outputPath,
    region,
    imageCrc: (crc as ImageCrcMode | undefined) ?? "auto",
    checkOnly,
    verbose: args.verbose === true,
    // Единственная точка и тарифа, и решения «спрашивать ли grant»: ядро уже
    // нашло копии, но ещё ничего не писало. Бросок отсюда гарантирует, что при
    // отсутствии grant'а не появится даже выходной файл.
    onCopies: copies => {
      const kind = classifySamsungDump(copies, inputSize);
      license = kind === "emmc-journal" ? "paid" : "free";
      // «Нет рабочей копии» — это про дамп РАЗДЕЛА eMMC (платный) без записей: там
      // править нечего, и на работающем ТВ ничего не изменится. У дампа микросхемы
      // 24C512 записей нет по природе — чип и есть носитель региона на старых
      // моделях, поэтому предупреждение там только отговаривало бы от метода
      // (D-154). Признак считается ДО записи файла, по тем же копиям, что и тариф.
      flatOnly = kind === "emmc-journal" && copies.length > 0 && !needsGrantForSamsung(copies);
      if (license === "paid" && !checkOnly) requireGrant(args.grant);
    },
  });

  const log = [...result.log];
  if (result.ok && !checkOnly && flatOnly) {
    // Честно и без внутренних имён: в дампе нет рабочей копии региона, значит на
    // работающем ТВ патч ничего не изменит. Мастеру нужен другой дамп — 2 МиБ из
    // eMMC (Tizen-10 / 2026+). Лог всегда английский (конвенция репозитория).
    log.push(
      "NOTE: no working region copy in this dump - the patch changes nothing on a running set. " +
        "Dump 2 MiB from eMMC (Tizen-10 / 2026+ sets) and patch that dump instead.",
    );
  }
  return { ...result, log, license, flatOnly };
}

/** Скан дампа LG (бесплатный: только отчёт). */
export function geoScanLg(args: Record<string, unknown>): LgScanResult {
  const inputPath = requireFile(args.path, "path");
  return scanLg(inputPath);
}

/**
 * Патч Area Option LG — БЕСПЛАТНО для всех (grant НЕ требуется).
 *
 * Разблокировка старых моделей правкой NVM не тарифицируется: мастеру не нужен
 * ни баланс, ни сеть. `grant` во входе просто игнорируется — если UI его
 * случайно передаст, операция всё равно пройдёт.
 */
export function geoPatchLg(args: Record<string, unknown>): LgPatchResult {
  const inputPath = requireFile(args.path, "path");
  const newValue = requireInt(args.newValue, "newValue", 0xffff);
  const oldValue =
    args.oldValue === undefined || args.oldValue === null
      ? undefined
      : requireInt(args.oldValue, "oldValue", 0xffff);
  const offset =
    args.offset === undefined || args.offset === null
      ? undefined
      : requireInt(args.offset, "offset", fs.statSync(inputPath).size);
  const dryRun = args.dryRun === true;
  const outputPath = dryRun ? undefined : requireOutput(args.out, inputPath);
  try {
    return patchLg({ inputPath, outputPath, newValue, oldValue, offset, dryRun });
  } catch (err) {
    if (err instanceof NotLgNvm || err instanceof AreaNotFound) {
      // доменные отказы ядра — обычный отказ операции, а не «падение main»
      throw new BadInput(err.message);
    }
    throw err;
  }
}
