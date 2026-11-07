import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadShardPage } from './data';

/** The shard page's data, on the server; 404 when there is no such shard. */
export const getShardPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadShardPage(data);
    if (!page) throw notFound();
    return page;
  });
