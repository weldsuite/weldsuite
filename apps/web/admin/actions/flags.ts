/**
 * Feature flag writes, as server functions.
 * The bodies are in `./flags.server.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { clearFlag as clearFlagOnServer, setFlag as setFlagOnServer } from './flags.server';

const text = z.string().max(4000);

const setFlagFn = createServerFn({ method: 'POST' })
  .validator(z.object({ flag: text, workspace: text.nullable(), value: text, reason: text }))
  .handler(({ data }) => setFlagOnServer(data));
export const setFlag = (input: Parameters<typeof setFlagOnServer>[0]) => setFlagFn({ data: input });

const clearFlagFn = createServerFn({ method: 'POST' })
  .validator(z.object({ flag: text, workspace: text.nullable(), reason: text }))
  .handler(({ data }) => clearFlagOnServer(data));
export const clearFlag = (input: Parameters<typeof clearFlagOnServer>[0]) => clearFlagFn({ data: input });
