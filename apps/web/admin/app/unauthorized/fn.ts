import { createServerFn } from '@tanstack/react-start';
import { loadUnauthorizedPage } from './data';

/** Whether the visitor is an admin at all, on the server. */
export const getUnauthorizedPage = createServerFn({ method: 'GET' })
  .handler(() => loadUnauthorizedPage());
