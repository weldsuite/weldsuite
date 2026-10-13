/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_APP_API_URL?: string;
  readonly VITE_PLATFORM_URL?: string;
  readonly VITE_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
