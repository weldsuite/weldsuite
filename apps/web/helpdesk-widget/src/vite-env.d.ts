/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WIDGET_API_URL: string;
  readonly VITE_API_WORKER_URL: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_DEBUG?: string;
  readonly VITE_DEFAULT_WIDGET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
