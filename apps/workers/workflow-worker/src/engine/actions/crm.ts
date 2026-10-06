/**
 * CRM record actions: create_contact, update_contact, create_lead,
 * create_deal, move_deal_stage, log_activity.
 *
 * Like create_customer, these never write the CRM tables directly: they call
 * connect-api's internal workflow-action routes (over the `CONNECT_INTERNAL`
 * entrypoint), which check the workflow owner's permissions, go through the
 * relevant CRM service and publish the entity event. The run's chain depth
 * goes along so the event can't retrigger workflows forever.
 */

import type { ActionHandler } from '../types';
import { NonRetryableStepError } from '../errors';
import { EMAIL_ADDRESS, optionalText, postInternalApi, workflowActor } from './helpers';

/** Wire contract with connect-api's create-contact / update-contact routes. */
export interface ContactActionResponse {
  success: boolean;
  /** false when an existing contact with the same email was reused. */
  created?: boolean;
  contact: { id: string; displayName: string | null; email: string | null };
}

/** A comma-separated list (or an array) as trimmed, non-empty strings. */
function textList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
  const list = items.map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** The contact fields a step may set; empty inputs are left out (never cleared). */
function contactFields(inputs: Record<string, unknown>) {
  const email = optionalText(inputs.email);
  if (email && !EMAIL_ADDRESS.test(email)) {
    throw new NonRetryableStepError(`Contact email "${email}" is not valid`);
  }
  return {
    firstName: optionalText(inputs.firstName),
    lastName: optionalText(inputs.lastName),
    email,
    phone: optionalText(inputs.phone),
    title: optionalText(inputs.title),
    companyId: optionalText(inputs.companyId),
    status: optionalText(inputs.status),
    notes: optionalText(inputs.notes),
    tags: textList(inputs.tags),
  };
}

function contactResult(result: ContactActionResponse) {
  return {
    contactId: result.contact.id,
    name: result.contact.displayName,
    email: result.contact.email,
    ...(result.created !== undefined ? { created: result.created } : {}),
  };
}

export const handleCreateContact: ActionHandler = async (inputs, ctx) => {
  const fields = contactFields(inputs);
  if (!fields.firstName && !fields.lastName && !fields.email) {
    throw new NonRetryableStepError('A contact needs a name or an email address');
  }
  const result = await postInternalApi<ContactActionResponse>(
    ctx.env,
    '/workflow-actions/create-contact',
    {
      ...workflowActor(ctx),
      // Default on: entity-event workflows often fire more than once for the
      // same person, and reusing the contact keeps them from creating duplicates.
      skipIfEmailExists: inputs.skipIfEmailExists !== false,
      contact: fields,
    },
    'Create contact',
    'CONNECT_INTERNAL',
  );
  return contactResult(result);
};

export const handleUpdateContact: ActionHandler = async (inputs, ctx) => {
  const contactId = optionalText(inputs.contactId);
  if (!contactId) throw new NonRetryableStepError('Choose the contact to update');
  const fields = contactFields(inputs);
  if (Object.values(fields).every((value) => value === undefined)) {
    throw new NonRetryableStepError('Fill in at least one field to update');
  }
  const result = await postInternalApi<ContactActionResponse>(
    ctx.env,
    '/workflow-actions/update-contact',
    { ...workflowActor(ctx), contactId, contact: fields },
    'Update contact',
    'CONNECT_INTERNAL',
  );
  return contactResult(result);
};

// ---------------------------------------------------------------------------
// create_lead
// ---------------------------------------------------------------------------

/** Wire contract with connect-api's create-lead route. */
export interface CreateLeadActionResponse {
  success: boolean;
  lead: { id: string; name: string | null; email: string };
}

export const handleCreateLead: ActionHandler = async (inputs, ctx) => {
  const email = optionalText(inputs.email);
  if (!email) throw new NonRetryableStepError('A lead needs an email address');
  if (!EMAIL_ADDRESS.test(email)) throw new NonRetryableStepError(`Lead email "${email}" is not valid`);
  const lead = {
    firstName: optionalText(inputs.firstName),
    lastName: optionalText(inputs.lastName),
    email,
    companyName: optionalText(inputs.companyName),
    title: optionalText(inputs.title),
    phone: optionalText(inputs.phone),
    mobile: optionalText(inputs.mobile),
    website: optionalText(inputs.website),
    source: optionalText(inputs.source),
    rating: optionalText(inputs.rating),
    notes: optionalText(inputs.notes),
  };
  const result = await postInternalApi<CreateLeadActionResponse>(
    ctx.env,
    '/workflow-actions/create-lead',
    { ...workflowActor(ctx), lead },
    'Create lead',
    'CONNECT_INTERNAL',
  );
  return { leadId: result.lead.id, name: result.lead.name, email: result.lead.email };
};

// ---------------------------------------------------------------------------
// create_deal
// ---------------------------------------------------------------------------

/** Wire contract with connect-api's create-deal route. */
export interface CreateDealActionResponse {
  success: boolean;
  deal: { id: string; name: string; stage: string; status: string };
}

export const handleCreateDeal: ActionHandler = async (inputs, ctx) => {
  const name = optionalText(inputs.name);
  if (!name) throw new NonRetryableStepError('A deal needs a name');
  const customerId = optionalText(inputs.customerId);
  if (!customerId) throw new NonRetryableStepError('Choose the company this deal belongs to');
  const deal = {
    name,
    customerId,
    description: optionalText(inputs.description),
    amount: inputs.amount !== undefined && inputs.amount !== '' ? inputs.amount : undefined,
    currency: optionalText(inputs.currency),
    pipeline: optionalText(inputs.pipeline),
    stageId: optionalText(inputs.stageId),
    closeDate: optionalText(inputs.closeDate),
  };
  const result = await postInternalApi<CreateDealActionResponse>(
    ctx.env,
    '/workflow-actions/create-deal',
    { ...workflowActor(ctx), deal },
    'Create deal',
    'CONNECT_INTERNAL',
  );
  return { dealId: result.deal.id, name: result.deal.name, stage: result.deal.stage, status: result.deal.status };
};

// ---------------------------------------------------------------------------
// move_deal_stage
// ---------------------------------------------------------------------------

/** Wire contract with connect-api's move-deal-stage route. */
export interface MoveDealStageActionResponse {
  success: boolean;
  deal: { id: string; stageId: string; status: string };
}

export const handleMoveDealStage: ActionHandler = async (inputs, ctx) => {
  const dealId = optionalText(inputs.dealId);
  if (!dealId) throw new NonRetryableStepError('Choose the deal to move');
  const stageId = optionalText(inputs.stageId);
  if (!stageId) throw new NonRetryableStepError('Choose the pipeline stage to move the deal to');
  const result = await postInternalApi<MoveDealStageActionResponse>(
    ctx.env,
    '/workflow-actions/move-deal-stage',
    { ...workflowActor(ctx), dealId, stageId },
    'Move deal stage',
    'CONNECT_INTERNAL',
  );
  return { dealId: result.deal.id, stageId: result.deal.stageId, status: result.deal.status };
};

// ---------------------------------------------------------------------------
// log_activity
// ---------------------------------------------------------------------------

/** Wire contract with connect-api's log-activity route. */
export interface LogActivityActionResponse {
  success: boolean;
  activity: { id: string; type: string; subject: string };
}

export const handleLogActivity: ActionHandler = async (inputs, ctx) => {
  const subject = optionalText(inputs.subject);
  if (!subject) throw new NonRetryableStepError('An activity needs a subject');
  const type = optionalText(inputs.type) ?? 'note';
  const activity = {
    type,
    subject,
    description: optionalText(inputs.description),
    dueDate: optionalText(inputs.dueDate),
    customerId: optionalText(inputs.customerId),
    contactId: optionalText(inputs.contactId),
    personId: optionalText(inputs.personId),
    opportunityId: optionalText(inputs.opportunityId),
  };
  const result = await postInternalApi<LogActivityActionResponse>(
    ctx.env,
    '/workflow-actions/log-activity',
    { ...workflowActor(ctx), activity },
    'Log activity',
    'CONNECT_INTERNAL',
  );
  return { activityId: result.activity.id, type: result.activity.type, subject: result.activity.subject };
};
