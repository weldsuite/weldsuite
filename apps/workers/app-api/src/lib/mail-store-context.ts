/**
 * Thin per-worker wrapper around the shared `getWorkspaceMail` glue
 * (`@weldsuite/mail-domain/store/hono`), typed against app-api's own
 * `Env`/`Variables`. The dashboard sidebar badge (`routes/dashboard/
 * index.ts`) and drive aggregation (`services/drive-aggregation.ts`, via
 * `routes/drive/index.ts`) import `workspaceMailFromContext` from here, so
 * both keep reading through the store/access abstraction in every mode
 * (design task D6) without their imports changing. The two adapters over
 * the factory's `GetWorkspaceMailOptions` (the optional-vs-required
 * `MAIL_STORAGE`-style bindings cast, and the `executionCtx.waitUntil`
 * no-op outside a real Workers runtime) live in the shared helper now — see
 * its doc comment — not duplicated here.
 *
 * A route with no permission gate of its own (the dashboard's sidebar
 * badge) simply gets `role: null` from the shared helper's default, which
 * falls back to a live permissions lookup only in object/object-only mode.
 */

import type { Context } from 'hono';
import type { WorkspaceMail } from '@weldsuite/mail-domain/store';
import { workspaceMailFromContext as workspaceMailFromContextShared } from '@weldsuite/mail-domain/store/hono';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function workspaceMailFromContext(c: AppContext): Promise<WorkspaceMail> {
  return workspaceMailFromContextShared(c);
}
