/**
 * The support inbox's message loader, as a server function. The body is in
 * `./support-messages.server.ts`; the export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { fetchSupportMessages as fetchSupportMessagesOnServer } from './support-messages.server';

type Server = typeof import('./support-messages.server');

const fetchSupportMessagesFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['fetchSupportMessages']>) => args)
  .handler(({ data }) => fetchSupportMessagesOnServer(...data));
export const fetchSupportMessages = (...args: Parameters<Server['fetchSupportMessages']>) =>
  fetchSupportMessagesFn({ data: args });
