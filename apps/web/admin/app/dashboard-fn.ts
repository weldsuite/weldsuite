import { createServerFn } from '@tanstack/react-start';
import { loadDashboardPage } from './dashboard-data';

/** The dashboard's data, on the server. */
export const getDashboardPage = createServerFn({ method: 'GET' })
  .handler(() => loadDashboardPage());
