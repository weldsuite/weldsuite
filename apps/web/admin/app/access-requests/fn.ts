import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadAccessRequestsPage } from './data';

/** The access requests for the status tab and search, on the server. */
export const getAccessRequestsPage = createServerFn({ method: 'GET' })
  .validator(z.object({ status: z.string(), q: z.string() }).partial())
  .handler(({ data }) => loadAccessRequestsPage(data));
