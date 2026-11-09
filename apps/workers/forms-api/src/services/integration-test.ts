/**
 * "Test" on an integration: a dry run against the latest completed response
 * that writes nothing and records nothing. It reads the response the way the
 * step would, checks what the integration's creator may do, and says what the
 * step would do (the ticket's subject, the task's title, whether the person
 * exists). The answer is always 200 `{ ok, message }`; `ok: false` carries why not.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import {
  crmIntegrationConfigSchema,
  deskIntegrationConfigSchema,
  flowIntegrationConfigSchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { resolveProjectAccess } from '@weldsuite/flow-domain/project-access';
import { findPersonByEmail } from '../workflows/steps/crm';
import { CreatorForbiddenError, loadCreatorAccess, type CreatorAccess } from './creator-access';
import type { WorkspaceCtx } from './context';
import { answerText, emailAnswer, renderTemplate, type TemplateContext } from './integration-support';
import type { IntegrationRow } from './integrations';

const { formResponses, formVersions, forms } = schema;

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
}

export async function testIntegration(ctx: WorkspaceCtx, row: IntegrationRow): Promise<IntegrationTestResult> {
  const [response] = await ctx.db
    .select()
    .from(formResponses)
    .where(and(eq(formResponses.formId, row.formId), eq(formResponses.status, 'completed')))
    .orderBy(desc(formResponses.submittedAt))
    .limit(1);
  if (!response) return { ok: false, message: 'There is no completed response to test with yet.' };
  const [[form], [version]] = await Promise.all([
    ctx.db.select().from(forms).where(eq(forms.id, row.formId)).limit(1),
    ctx.db.select().from(formVersions).where(eq(formVersions.id, response.versionId)).limit(1),
  ]);
  const definition = version ? formDefinitionSchema.safeParse(version.definition) : null;
  if (!form || !definition?.success) return { ok: false, message: 'The form of the latest response could not be read.' };

  const template = { env: ctx.env, form, response, definition: definition.data };
  const prefix = `Response #${response.number ?? '?'}:`;
  try {
    const access = await loadCreatorAccess(ctx.db, ctx.env, row.createdByUserId);
    const test: DryRun = { ctx, row, access, template, prefix };
    if (row.kind === 'crm') return await testCrm(test);
    if (row.kind === 'desk') return testDesk(test);
    return await testFlow(test);
  } catch (err) {
    if (err instanceof CreatorForbiddenError) return { ok: false, message: err.message };
    throw err;
  }
}

/** What each kind's dry run reads: the latest completed response as a recall template, and what its creator may do. */
interface DryRun {
  ctx: WorkspaceCtx;
  row: IntegrationRow;
  access: CreatorAccess;
  template: TemplateContext;
  /** `Response #<n>:`, the start of every answer about the response. */
  prefix: string;
}

async function testCrm({ ctx, row, access, template, prefix }: DryRun): Promise<IntegrationTestResult> {
  const parsed = crmIntegrationConfigSchema.safeParse(row.config);
  if (!parsed.success) return { ok: false, message: 'The CRM integration is not set up correctly.' };
  const config = parsed.data;
  const { definition, response } = template;
  const email = emailAnswer(definition, response, config.emailFieldId);
  if (!email) return { ok: false, message: `${prefix} no email address in the chosen question.` };
  if (config.target === 'lead') {
    access.require('leads:create', 'weldcrm', 'create leads');
    return { ok: true, message: `${prefix} would create a lead for ${email}.` };
  }
  const existing = await findPersonByEmail(ctx.db, email);
  if (existing) access.require('people:update', 'weldcrm', 'update people');
  else access.require('people:create', 'weldcrm', 'create people');
  if (config.createCompany) access.require('companies:create', 'weldcrm', 'create companies');
  if (config.listId) access.require('companies:update', 'weldcrm', 'add people to lists');
  if (config.logActivity) access.require('activities:create', 'weldcrm', 'log activities');
  const filled = config.mappings.filter((m) => answerText(definition, response, m.blockId, m.part)).length;
  const verb = existing ? 'update' : 'create';
  return { ok: true, message: `${prefix} would ${verb} the person ${email} (${filled} mapped fields).` };
}

function testDesk({ row, access, template, prefix }: DryRun): IntegrationTestResult {
  const parsed = deskIntegrationConfigSchema.safeParse(row.config);
  if (!parsed.success) return { ok: false, message: 'The Desk integration is not set up correctly.' };
  access.require('tickets:create', 'welddesk', 'open tickets');
  return { ok: true, message: `${prefix} would open the ticket "${renderTemplate(parsed.data.subject, template).trim()}".` };
}

async function testFlow({ ctx, row, access, template, prefix }: DryRun): Promise<IntegrationTestResult> {
  const parsed = flowIntegrationConfigSchema.safeParse(row.config);
  if (!parsed.success) return { ok: false, message: 'The Flow integration is not set up correctly.' };
  access.require('tasks:create', 'weldflow', 'create tasks');
  if (parsed.data.projectId) {
    const project = await resolveProjectAccess(ctx.db, row.createdByUserId, { scopeAll: access.can('projects:scope:all', 'weldflow') }, parsed.data.projectId);
    if (!project.canWrite) throw new CreatorForbiddenError('The member who set up this integration does not have write access to the project');
  }
  return { ok: true, message: `${prefix} would create the task "${renderTemplate(parsed.data.title, template).trim()}".` };
}
