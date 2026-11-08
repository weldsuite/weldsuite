import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadOutboundWorkspacePage } from './data';

/**
 * A workspace's outbound mail page data, on the server; 404 when there is no
 * such workspace. An event's `details` is a JSON column typed
 * `Record<string, unknown>`, which serializes fine but which Start's type check
 * can't prove, so the output check is off.
 */
export const getOutboundWorkspacePage = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(z.object({ workspaceId: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const page = await loadOutboundWorkspacePage(data);
    if (!page) throw notFound();
    return page;
  });
