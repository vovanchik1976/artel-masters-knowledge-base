/**
 * Локальная генерация QR-кода для входа в Telegram (Electron Win7/8 порт).
 *
 * Зачем это здесь, а не как в mainline:
 * Скопированный 1:1 UI (`ui/TdlibAuthPage.ts`) рисовал QR через data-URI
 * стороннего HTTP-сервиса:
 *   `https://api.qrserver.com/v1/create-qr-code/?...data=<link>`
 * где `<link>` — это `tg://login?token=...`, то есть **login-токен** аккаунта
 * Telegram. Передача его третьей стороне — утечка секрета, а сама зависимость
 * от внешней сети ломает вход по QR в оффлайне / за корпоративным фильтром
 * (симптом: «QR не генерируется»).
 *
 * Здесь QR строится локально (библиотека `qrcode-generator`, MIT, без сети) и
 * отдаётся как `data:` URL — токен не покидает машину.
 *
 * Отклонение от mainline зафиксировано в [`PORT_DIVERGENCES.md`](../PORT_DIVERGENCES.md).
 */

import qrcode from "qrcode-generator";

/**
 * Построить QR-код как data URL (`data:image/gif;base64,...`).
 *
 * @param text     Содержимое (напр. `tg://login?token=...`).
 * @param cellSize Размер одного модуля в пикселях.
 * @param margin   Поле в модулях вокруг кода (важно для распознавания сканером).
 */
export function qrDataUrl(text: string, cellSize = 4, margin = 8): string {
  if (!text) throw new Error("qrDataUrl: пустой текст");
  // typeNumber 0 — авто-подбор версии по объёму данных; 'M' — средний уровень
  // коррекции ошибок (достаточно для экрана, как у прежнего внешнего сервиса).
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, margin);
}
