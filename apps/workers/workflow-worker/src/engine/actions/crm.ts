/**
 * CRM record actions: create_contact, update_contact.
 *
 * Like create_customer, these never write the CRM tables directly: they call
 * connect-api's internal workflow-action routes (over the `CONNECT_INTERNAL`
 * entrypoint), which check the workflow owner's permissions, go through the
 * CRM people service and publish the entity event. The run's chain depth goes
 * along so the event can't retrigger workflows forever.
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
