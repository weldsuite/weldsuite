import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadAppsPage } from './data';

/** The App Catalog for the search and category, on the server. */
export const getAppsPage = createServerFn({ method: 'GET' })
  .validator(z.object({ search: z.string(), category: z.string() }).partial())
  .handler(({ data }) => loadAppsPage(data));
