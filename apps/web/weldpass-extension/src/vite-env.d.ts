/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_SYNC_HOST?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_EXTENSION_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
