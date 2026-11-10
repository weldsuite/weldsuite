/**
 * Cross-form routes — /api/forms/*
 *
 *   GET  /responses?personId=   → a CRM person's responses across the forms the member may read
 *   POST /erase                 → GDPR: delete every response (and its files) of one respondent email
 *
 * Both stop at the forms the member can see and has the right on (a restricted
 * form they are not on is not there for them), as every per-form route does.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { inArray } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { schema } from '@weldsuite/worker-kit/db';
import { cursorPagination, list, success } from '@weldsuite/worker-kit/response';
import { eraseRespondentSchema, listPersonResponsesQuerySchema, type PersonFormResponse } from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { answerableFormIds, resolveGrants } from '../../services/access';
import { workspaceCtx } from '../../services/context';
import { deleteResponses, listPersonResponses, responseIdsByEmail } from '../../services/responses';
import type { Env, Variables } from '../../types';
import { dropFiles, publishDeleted } from '../responses';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/responses', requirePermission('form_responses:read'), zValidator('query', listPersonResponsesQuerySchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const query = c.req.valid('query');
    const formIds = await answerableFormIds(ctx.db, c.get('userId'), await resolveGrants(c));
    const page = await listPersonResponses(ctx, query.personId, formIds, { cursor: query.cursor, limit: query.limit });
    const titles = new Map<string, string>();
    const used = [...new Set(page.rows.map((r) => r.formId))];
    if (used.length > 0) for (const f of await ctx.db.select({ id: schema.forms.id, title: schema.forms.title }).from(schema.forms).where(inArray(schema.forms.id, used))) titles.set(f.id, f.title);
    const rows: PersonFormResponse[] = page.rows.map((r) => ({ ...r, formTitle: titles.get(r.formId) ?? '' }));
    return list(c, rows, cursorPagination(page.total, page.next !== null, page.next));
  }),
);

app.post('/erase', requirePermission('form_responses:delete'), zValidator('json', eraseRespondentSchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    // Only forms the member may delete answers on; the rest stay.
    const formIds = await answerableFormIds(ctx.db, c.get('userId'), await resolveGrants(c), 'deleteResponses');
    const { deleted, keys } = await deleteResponses(ctx, await responseIdsByEmail(ctx, c.req.valid('json').email, formIds));
    dropFiles(c, keys);
    publishDeleted(c, deleted);
    return success(c, { responsesDeleted: deleted.length, formsAffected: new Set(deleted.map((r) => r.formId)).size });
  }),
);

export default app;
