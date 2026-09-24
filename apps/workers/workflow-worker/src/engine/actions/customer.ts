/**
 * CRM actions: create_customer.
 *
 * A "customer" is a CRM company with status `customer`. Creation is delegated
 * to app-api (POST /api/internal/workflow-actions/create-customer) rather than
 * inserted here: the companies service there stamps `displayName` and the
 * other required columns, and app-api publishes the `company:created` entity
 * event — which this worker can't do on its own (it has no ENTITY_EVENTS
 * producer). The run's chain depth travels along so the event it causes can't
 * retrigger workflows indefinitely.
 */

import type { ActionHandler } from '../types';
import { postInternalApi } from './helpers';

/** Wire contract with app-api's internal create-customer route. */
export interface CreateCustomerResponse {
  success: boolean;
  /** false when an existing company with the same email was reused. */
  created: boolean;
  customer: { id: string; name: string; email: string | null; status: string | null };
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

export const handleCreateCustomer: ActionHandler = async (inputs, ctx) => {
  const name = optionalString(inputs.name);
  if (!name) throw new Error('Customer name is required');

  const result = await postInternalApi<CreateCustomerResponse>(
    ctx.env,
    '/workflow-actions/create-customer',
    {
      workspaceId: ctx.tenant.workspaceId,
      userId: ctx.tenant.userId,
      chainDepth: ctx.chainDepth ?? 0,
      // Defaults to true: entity-event workflows commonly fire more than once
      // for the same person (retries, repeated updates), so reusing a company
      // with the same email keeps them from creating duplicates.
      skipIfEmailExists: inputs.skipIfEmailExists !== false,
      customer: {
        name,
        email: optionalString(inputs.email),
        phone: optionalString(inputs.phone),
        website: optionalString(inputs.website),
        notes: optionalString(inputs.notes),
      },
    },
    'Create customer',
  );

  return {
    created: result.created,
    customerId: result.customer.id,
    name: result.customer.name,
    email: result.customer.email,
  };
};
