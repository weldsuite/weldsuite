import { createServerFn } from '@tanstack/react-start';
import { loadSupportPage } from './data';

/**
 * The support inbox's data, on the server. A channel's `metadata` is a JSON
 * column typed `Record<string, unknown>`, which serializes fine but which
 * Start's type check can't prove, so the output check is off.
 */
export const getSupportPage = createServerFn({ method: 'GET', strict: { output: false } })
  .handler(() => loadSupportPage());
