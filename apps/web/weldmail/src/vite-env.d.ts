/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_PERSONAL_API_URL?: string;
  /** Realtime worker WebSocket endpoint, including the `/ws/personal` path. */
  readonly VITE_REALTIME_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
