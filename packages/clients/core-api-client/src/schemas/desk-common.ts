import { z } from 'zod';

/** `{ id }`: what the desk routes answer a create or an update with. */
export const deskIdRefSchema = z.object({ id: z.string() });
