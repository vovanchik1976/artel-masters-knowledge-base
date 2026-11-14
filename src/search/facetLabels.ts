/**
 * Человекочитаемые подписи значений фасетов (SP-31 follow-up, D-165, 2026-11-04).
 *
 * Владелец: в панели фасетов не должны светиться сырые значения индекса
 * («firmware», «tv») — показываем канонические подписи («Firmware», «TV»):
 *   КЛАСС:      firmware→Firmware, documentation→Documentation, software→Software
 *   УСТРОЙСТВО: tv→TV, stb→STB, android_tv→Android TV, …
 *   ТИП ЖЕЛЕЗА: original→Original, china_clone→China-clone
 *
 * Свободные текстовые фасеты (brand/model/chassis/chipset/panel_model) остаются
 * как есть — их значение и есть подпись. Клик-хендлер читает raw `data-value`,
 * подпись — только отображение (SearchPage._renderFacets).
 */

const KIND_LABELS: Record<string, string> = {
  firmware: "Firmware",
  documentation: "Documentation",
  software: "Software",
  // SP-35 (D-185): даташит — отдельный класс; any_file — личное хранилище.
  datasheet: "Datasheet",
  any_file: "Any file",
  // SP-36 (D-188): ISP-подключение eMMC и фото ремонта.
  isp_emmc: "ISP eMMC",
  repair_pictures: "Repair pictures",
};

const DEVICE_LABELS: Record<string, string> = {
  tv: "TV",
  monitor: "Monitor",
  stb: "STB",
  android_tv: "Android TV",
  media_server: "Media Server",
  audio: "Audio",
  dvd_bluray: "DVD/Blu-ray",
  radio: "Radio",
  console: "Console",
  power_station: "Power Station",
  appliance: "Appliance",
  other: "Other",
};

const HARDWARE_TYPE_LABELS: Record<string, string> = {
  original: "Original",
  china_clone: "China-clone",
};

const BY_FIELD: Record<string, Record<string, string>> = {
  kind: KIND_LABELS,
  device_category: DEVICE_LABELS,
  hardware_type: HARDWARE_TYPE_LABELS,
};

export function facetOptionLabel(field: string, value: string): string {
  const map = BY_FIELD[field];
  if (!map) return value;
  return map[value] ?? value;
}
