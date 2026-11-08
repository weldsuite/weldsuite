import { createServerFn } from '@tanstack/react-start';
import { loadPlansPage } from './data';

/**
 * The plan list's data, on the server. A plan's `features` is a JSON column
 * typed `Record<string, unknown>`, which serializes fine but which Start's
 * type check can't prove, so the output check is off.
 */
export const getPlansPage = createServerFn({ method: 'GET', strict: { output: false } })
  .handler(() => loadPlansPage());
