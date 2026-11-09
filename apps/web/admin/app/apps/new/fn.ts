import { createServerFn } from '@tanstack/react-start';
import { loadNewAppPage } from './data';

/** The new app page's data, on the server. */
export const getNewAppPage = createServerFn({ method: 'GET' })
  .handler(() => loadNewAppPage());
