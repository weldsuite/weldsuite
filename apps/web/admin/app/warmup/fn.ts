import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadWarmupNetworkPage } from './data';

/** The warmup network page for the mailbox search, on the server. */
export const getWarmupNetworkPage = createServerFn({ method: 'GET' })
  .validator(z.object({ q: z.string() }).partial())
  .handler(({ data }) => loadWarmupNetworkPage(data));
