import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadWorkspaceDetailPage } from './data';

/** The workspace page's data, on the server; 404 when there is no such workspace. */
export const getWorkspaceDetailPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadWorkspaceDetailPage(data);
    if (!page) throw notFound();
    return page;
  });
