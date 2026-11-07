import { createServerFn } from '@tanstack/react-start';
import { loadPartnersPage } from './data';

/**
 * The partner list's data, on the server. A worker error's `details` is parsed
 * JSON typed `unknown`, which serializes fine but which Start's type check
 * can't prove, so the output check is off.
 */
export const getPartnersPage = createServerFn({ method: 'GET', strict: { output: false } })
  .handler(() => loadPartnersPage());
