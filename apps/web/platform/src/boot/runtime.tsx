/**
 * Kubernetes boot (`VITE_RUNTIME_CONFIG=on`, see `./mode.ts`): `/config.json`
 * first, then the app. The app reads API origins and keys at module load, so
 * `../app` is imported only once the runtime config has settled. When the
 * document is missing or invalid, the build-time `VITE_*` values apply
 * (`lib/runtime-config.ts`).
 */
import { getLocale } from '@weldsuite/i18n';
import { loadLocale } from '@weldsuite/i18n/locales';
import { setAuthImplementation } from '@/lib/auth';
import { log } from '@/lib/logger';
import { loadRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config';

/**
 * Pick the identity provider from the runtime config's `auth` block
 * (SEC-012). Clerk is the default; the OIDC client is a separate chunk.
 */
export async function selectIdentityProvider(config: RuntimeConfig | null): Promise<void> {
  const auth = config?.auth;
  if (auth?.provider !== 'oidc') return;
  const { clientId } = auth;
  if (!clientId) {
    log.error('/config.json names an OIDC provider without a clientId (OIDC_WEB_CLIENT_ID); nobody can sign in');
    return;
  }
  const { createOidcAuth } = await import('@/lib/auth/oidc');
  setAuthImplementation(createOidcAuth({ ...auth, clientId }));
}

/** Runtime config and the locale's bundle (see `./global.tsx`), then the app. */
export async function startApp(): Promise<void> {
  await Promise.all([
    loadRuntimeConfig().then(selectIdentityProvider),
    loadLocale(getLocale()).catch(() => undefined),
  ]);
  const { renderApp } = await import('../app');
  renderApp();
}
