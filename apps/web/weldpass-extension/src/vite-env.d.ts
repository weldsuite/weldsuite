/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Another default server than https://app.weldsuite.eu (development builds). */
  readonly VITE_DEFAULT_SERVER?: string;
  /** That server's sign-in server, for its host permission. */
  readonly VITE_DEFAULT_ISSUER?: string;
  /** A public key that pins the extension id instead of the development key. */
  readonly VITE_EXTENSION_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
