/**
 * Staff pause and resume of a mailbox's warmup in the WeldReach network, as
 * server functions. The bodies are in `./warmup-network.server.ts`; each export
 * here keeps that function's signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  pauseWarmupMailbox as pauseWarmupMailboxOnServer,
  resumeWarmupMailbox as resumeWarmupMailboxOnServer,
} from './warmup-network.server';

type Server = typeof import('./warmup-network.server');

const pauseWarmupMailboxFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['pauseWarmupMailbox']>) => args)
  .handler(({ data }) => pauseWarmupMailboxOnServer(...data));
export const pauseWarmupMailbox = (...args: Parameters<Server['pauseWarmupMailbox']>) =>
  pauseWarmupMailboxFn({ data: args });

const resumeWarmupMailboxFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['resumeWarmupMailbox']>) => args)
  .handler(({ data }) => resumeWarmupMailboxOnServer(...data));
export const resumeWarmupMailbox = (...args: Parameters<Server['resumeWarmupMailbox']>) =>
  resumeWarmupMailboxFn({ data: args });
