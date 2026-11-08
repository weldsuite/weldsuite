import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadEditAppPage } from './data';

/** The app edit page's data, on the server; 404 when there is no such app. */
export const getEditAppPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadEditAppPage(data);
    if (!page) throw notFound();
    return page;
  });
