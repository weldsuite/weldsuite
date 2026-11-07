/**
 * The staff list's writes, as server functions (the Kubernetes editions only).
 * The bodies are in `./staff.server.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { kubernetesOnly } from '@/lib/edition';
import { addStaff as addStaffOnServer, removeStaff as removeStaffOnServer } from './staff.server';

const text = z.string().max(2000);

const addStaffFn = createServerFn({ method: 'POST' })
  .middleware([kubernetesOnly])
  .validator(z.object({ email: text, role: text, name: text.nullable().optional(), reason: text }))
  .handler(({ data }) => addStaffOnServer(data));
export const addStaff = (input: Parameters<typeof addStaffOnServer>[0]) => addStaffFn({ data: input });

const removeStaffFn = createServerFn({ method: 'POST' })
  .middleware([kubernetesOnly])
  .validator(z.object({ email: text, reason: text }))
  .handler(({ data }) => removeStaffOnServer(data));
export const removeStaff = (input: Parameters<typeof removeStaffOnServer>[0]) => removeStaffFn({ data: input });
