/**
 * What a service needs to act in one workspace: the tenant DB, the master DB
 * and the two identifiers. Built from a Hono context for member routes, and
 * from a registry hit for public ones, so the services themselves never touch
 * the request.
 */

import type { Context } from 'hono';
import { getMasterDb, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

export interface WorkspaceCtx {
  env: Env;
  db: Database;
  master: MasterDatabase;
  /** `workspaces.id`. */
  workspaceId: string;
  /** Clerk org id: R2 prefixes, entity events and workflow params still use it. */
  clerkOrgId: string;
}

/** The master DB is opened on first use: most member routes only touch the tenant. */
export function workspaceCtx(c: Context<{ Bindings: Env; Variables: Variables }>): WorkspaceCtx {
  let master: MasterDatabase | undefined;
  return {
    env: c.env,
    db: c.get('tenantDb'),
    get master() {
      master ??= getMasterDb(c.env);
      return master;
    },
    workspaceId: c.get('workspaceId'),
    clerkOrgId: c.get('clerkOrgId'),
  };
}

/** `https://forms.weldsuite.org/f/<publicId>` on this deployment. */
export function publicFormUrl(env: Pick<Env, 'FORMS_PORTAL_URL'>, publicId: string | null): string | null {
  if (!publicId) return null;
  return `${(env.FORMS_PORTAL_URL || 'https://forms.weldsuite.org').replace(/\/$/, '')}/f/${publicId}`;
}
