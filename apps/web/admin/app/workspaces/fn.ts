import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadWorkspacesPage } from './data';

/** The workspace list for the search, on the server. */
export const getWorkspacesPage = createServerFn({ method: 'GET' })
  .validator(z.object({ search: z.string() }).partial())
  .handler(({ data }) => loadWorkspacesPage(data));
