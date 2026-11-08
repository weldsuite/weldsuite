import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadPartnerDetailPage } from './data';
import { globalOnly } from '@/lib/edition';

/**
 * The partner page's data for the tab, on the server; 404 when there is no
 * such partner. A worker error's `details` is parsed JSON typed `unknown`,
 * which serializes fine but which Start's type check can't prove, so the
 * output check is off.
 */
export const getPartnerDetailPage = createServerFn({ method: 'GET', strict: { output: false } }).middleware([globalOnly])
  .validator(z.object({ id: z.string().min(1).max(255), tab: z.string().optional() }))
  .handler(async ({ data }) => {
    const page = await loadPartnerDetailPage(data);
    if (!page) throw notFound();
    return page;
  });
