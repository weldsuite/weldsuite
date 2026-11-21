/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The widget API: the helpdesk-widget-api worker's origin (Global, set on
   * Vercel), or a path on the widget's own origin (`/public/helpdesk-widget`
   * on Kubernetes, where the Rust server serves both, rust/Dockerfile).
   */
  readonly VITE_WIDGET_API_URL: string;
  /** `off` leaves Vercel Web Analytics out (any host but Vercel). */
  readonly VITE_VERCEL_ANALYTICS?: string;
  readonly VITE_API_WORKER_URL: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_DEBUG?: string;
  readonly VITE_DEFAULT_WIDGET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
