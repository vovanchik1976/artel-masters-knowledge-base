/// <reference types="vite/client" />

/**
 * Zero Secrets in Binary (решение владельца 2026-09-22): Telegram-креды
 * (api_id/api_hash) в бандл НЕ запекаются и через `import.meta.env` не читаются —
 * их выдаёт сервер (`POST /desktop/auth/credentials`; pair-код удалён) либо
 * отдаёт `/api/client-config` по Bearer. Из публичных значений в сборке остаётся
 * только `VITE_SERVER_URL` (см. `src/api.ts`).
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
