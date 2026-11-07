import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadOutboundMailPage } from './data';

/**
 * The outbound mail page for the filters in the search params, on the server.
 * An event's `details` is a JSON column typed `Record<string, unknown>`, which
 * serializes fine but which Start's type check can't prove, so the output
 * check is off.
 */
export const getOutboundMailPage = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(
    z
      .object({ state: z.string(), status: z.string(), trigger: z.string(), severity: z.string(), case: z.string() })
      .partial(),
  )
  .handler(({ data }) => loadOutboundMailPage(data));
