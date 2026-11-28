/**
 * Plan changes, as server functions. The bodies are in `./plans.server.ts`;
 * each export here keeps that function's signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { createPlan as createPlanOnServer, updatePlan as updatePlanOnServer } from './plans.server';

export type { PlanFormValues } from './plans.server';

type Server = typeof import('./plans.server');

const createPlanFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['createPlan']>) => args)
  .handler(({ data }) => createPlanOnServer(...data));
export const createPlan = (...args: Parameters<Server['createPlan']>) =>
  createPlanFn({ data: args });

const updatePlanFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['updatePlan']>) => args)
  .handler(({ data }) => updatePlanOnServer(...data));
export const updatePlan = (...args: Parameters<Server['updatePlan']>) =>
  updatePlanFn({ data: args });
