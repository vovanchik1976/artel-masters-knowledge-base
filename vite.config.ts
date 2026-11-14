import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Конфиг renderer'а для Electron-версии (Win7/8 порт).
// Не трогаем mainline desktop/vite.config.ts.
//
// В dev: Vite-сервер (HMR) на http://127.0.0.1:5197 (Electron main грузит этот URL).
// Релизные .exe собираются позже (CI) — тогда будет file:// + собранные ассеты.
//
// UI-код скопирован 1:1 из desktop/src (vanilla TS) и импортирует
// @tauri-apps/api/* — ремапим эти модули на локальные полифиллы (tauri-polyfill/),
// чтобы НЕ править скопированные исходники UI.
export default defineConfig(() => {
  const port = Number(process.env.VITE_DEV_SERVER_PORT ?? 5197);

  // Zero Secrets in Binary (решение владельца 2026-09-22): в бандл НЕ попадает
  // ни api_id, ни api_hash. Креды Telegram клиент получает только с сервера —
  // POST /desktop/auth/credentials (pair-код удалён) либо GET /api/client-config
  // (Bearer, повторные запуски). Поэтому никаких define/предупреждений про
  // VITE_TELEGRAM_API_* здесь нет: dev-стенды (e2e-prod.sh / e2e-prod32.sh) и
  // релиз идут ОДНИМ путём, и «в dev работает, в релизе нет» невозможно.
  return {
    clearScreen: false,
    root: ".",
    base: "./",
    resolve: {
      alias: {
        "@tauri-apps/api/core": fileURLToPath(new URL("./tauri-polyfill/core.ts", import.meta.url)),
        "@tauri-apps/api/event": fileURLToPath(new URL("./tauri-polyfill/event.ts", import.meta.url)),
        "@tauri-apps/plugin-dialog": fileURLToPath(new URL("./tauri-polyfill/dialog.ts", import.meta.url)),
        "@tauri-apps/plugin-updater": fileURLToPath(new URL("./tauri-polyfill/updater.ts", import.meta.url)),
      },
    },
    server: {
      port,
      strictPort: true,
      host: "127.0.0.1",
    },
    build: {
      outDir: "dist-renderer",
      emptyOutDir: true,
    },
  };
});
