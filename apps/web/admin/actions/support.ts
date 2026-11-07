/**
 * Staff replies to support conversations, as a server function. The body is in
 * `./support.server.ts`; the export here keeps that function's signature and
 * runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { replyToSupport as replyToSupportOnServer } from './support.server';

type Server = typeof import('./support.server');

const replyToSupportFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['replyToSupport']>) => args)
  .handler(({ data }) => replyToSupportOnServer(...data));
export const replyToSupport = (...args: Parameters<Server['replyToSupport']>) =>
  replyToSupportFn({ data: args });
