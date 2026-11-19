/**
 * WeldPanel sample data for local design work.
 *
 * With `VITE_WELDPANEL_SAMPLE_DATA=true` in `apps/web/platform/.env.local`
 * and a dev build (`pnpm dev`), every WeldPanel request (`/panel/*`) is
 * answered in the browser from a made-up but consistent data set, so every
 * WeldPanel screen is full without a backend. A path that has no sample
 * answer goes to the real API as usual, with a console warning naming it.
 *
 * Production builds never turn this on: `import.meta.env.DEV` is false there
 * and the sample modules are only loaded through a dynamic import.
 */

import type { ClientApi } from '@weldsuite/api-client/types';

// Never under Vitest: it reads .env.local too, and tests mock the API themselves.
// MODE is Vite's build mode, not a deployment variable, so it needn't be in turbo.json.
// eslint-disable-next-line turbo/no-undeclared-env-vars
const UNDER_TEST = import.meta.env.MODE === 'test';

export const WELDPANEL_SAMPLE_DATA = import.meta.env.DEV && !UNDER_TEST && import.meta.env.VITE_WELDPANEL_SAMPLE_DATA === 'true';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function isPanelPath(path: string): boolean {
  return path === '/panel' || path.startsWith('/panel/') || path.startsWith('/panel?');
}

/** `api` with WeldPanel's paths answered from sample data when the flag is on; `api` itself otherwise. */
export function withWeldPanelSampleData(api: ClientApi): ClientApi {
  if (!WELDPANEL_SAMPLE_DATA) return api;

  async function answer<T>(method: Method, path: string, body: unknown, fallback: () => Promise<T>, raw = false): Promise<T> {
    if (!isPanelPath(path)) return fallback();
    const { handleSampleRequest, UNHANDLED } = await import('./router');
    const result = await handleSampleRequest({ method, path, body, raw });
    if (result === UNHANDLED) {
      console.warn(`[weldpanel sample data] no sample answer for ${method} ${path}; asking the API`);
      return fallback();
    }
    return result as T;
  }

  return {
    get: <T>(path: string) => answer<T>('GET', path, undefined, () => api.get<T>(path)),
    getRaw: (path: string) => answer<Response>('GET', path, undefined, () => api.getRaw(path), true),
    post: <T>(path: string, data?: unknown) => answer<T>('POST', path, data, () => api.post<T>(path, data)),
    put: <T>(path: string, data?: unknown) => answer<T>('PUT', path, data, () => api.put<T>(path, data)),
    patch: <T>(path: string, data?: unknown) => answer<T>('PATCH', path, data, () => api.patch<T>(path, data)),
    delete: <T>(path: string) => answer<T>('DELETE', path, undefined, () => api.delete<T>(path)),
    postForm: <T>(path: string, form: FormData) => api.postForm<T>(path, form),
  };
}
