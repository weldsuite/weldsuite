import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadAccessRequestPage } from './data';

/** The access request page's data, on the server; 404 when there is no such request. */
export const getAccessRequestPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadAccessRequestPage(data);
    if (!page) throw notFound();
    return page;
  });
