import { createServerFn } from '@tanstack/react-start';
import { loadFlagsPage } from './data';

/** The feature flags page's data, on the server. */
export const getFlagsPage = createServerFn({ method: 'GET' })
  .handler(() => loadFlagsPage());
