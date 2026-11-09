import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadPlanDetailPage } from './data';

/**
 * The plan page's data, on the server; 404 when there is no such plan. The
 * plan's `features` is a JSON column typed `Record<string, unknown>`, which
 * serializes fine but which Start's type check can't prove, so the output
 * check is off.
 */
export const getPlanDetailPage = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(z.object({ id: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadPlanDetailPage(data);
    if (!page) throw notFound();
    return page;
  });
