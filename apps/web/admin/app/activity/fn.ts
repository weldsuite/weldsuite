import { createServerFn } from '@tanstack/react-start';
import { loadActivityPage } from './data';

/** The activity log's data, on the server. */
export const getActivityPage = createServerFn({ method: 'GET' })
  .handler(() => loadActivityPage());
