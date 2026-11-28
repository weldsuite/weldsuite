import { createServerFn } from '@tanstack/react-start';
import { loadStaffPage } from './data';

/** The staff list's data, on the server. */
export const getStaffPage = createServerFn({ method: 'GET' })
  .handler(() => loadStaffPage());
