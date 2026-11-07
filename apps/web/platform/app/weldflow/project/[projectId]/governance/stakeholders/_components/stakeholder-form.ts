/**
 * The add and edit form of a stakeholder: its schema, the starting values, and
 * the request bodies built from a filled form. The limits are the API's
 * (`@weldsuite/app-api-client/schemas/project-reporting`); the form holds what
 * inputs hold (a `YYYY-MM-DD` date, scores as the text of a select), and the
 * builders turn that into the numbers and ISO timestamps the API takes.
 */

import { z } from 'zod';
import {
  STAKEHOLDER_ATTITUDES,
  STAKEHOLDER_ENGAGEMENT,
  type CreateStakeholderInput,
  type Stakeholder,
  type UpdateStakeholderInput,
} from '@weldsuite/app-api-client/schemas/project-reporting';
import { fromDateInput, toDateInput } from '../../_lib/use-governance';

export const SCORES = [1, 2, 3, 4, 5] as const;

const MAX_ORGANISATION = 255;
const MAX_ROLE = 100;
const MAX_NOTES = 10_000;

export interface StakeholderFormMessages {
  required: string;
  tooLong: (max: number) => string;
}

/**
 * The schema of the form; `required` and `tooLong` are the user's language.
 * Adding picks a person (a team member, or the id of a CRM contact); editing
 * keeps the one the stakeholder has, so only `create` asks for one.
 */
export function stakeholderFormSchema(messages: StakeholderFormMessages, mode: 'create' | 'edit') {
  const text = (max: number) => z.string().max(max, messages.tooLong(max));
  return z
    .object({
      kind: z.enum(['member', 'contact']),
      memberId: z.string(),
      contactId: z.string(),
      organisation: text(MAX_ORGANISATION),
      role: text(MAX_ROLE),
      influence: z.enum(['1', '2', '3', '4', '5']),
      interest: z.enum(['1', '2', '3', '4', '5']),
      attitude: z.enum(STAKEHOLDER_ATTITUDES),
      engagement: z.enum(STAKEHOLDER_ENGAGEMENT),
      lastContact: z.string(),
      notes: text(MAX_NOTES),
    })
    .superRefine((values, ctx) => {
      if (mode === 'edit') return;
      if (values.kind === 'member' && !values.memberId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memberId'], message: messages.required });
      if (values.kind === 'contact' && !values.contactId.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contactId'], message: messages.required });
    });
}

export type StakeholderFormValues = z.infer<ReturnType<typeof stakeholderFormSchema>>;

/** A new stakeholder starts in the middle of the grid, as the API does. */
export function defaultStakeholderValues(): StakeholderFormValues {
  return {
    kind: 'member',
    memberId: '',
    contactId: '',
    organisation: '',
    role: '',
    influence: '3',
    interest: '3',
    attitude: 'neutral',
    engagement: 'neutral',
    lastContact: '',
    notes: '',
  };
}

/** The form of an existing stakeholder; the person is not editable, so the form holds no id. */
export function valuesFromStakeholder(row: Stakeholder): StakeholderFormValues {
  return {
    kind: row.kind,
    memberId: '',
    contactId: '',
    organisation: row.organisation ?? '',
    role: row.role ?? '',
    influence: String(row.influence) as StakeholderFormValues['influence'],
    interest: String(row.interest) as StakeholderFormValues['interest'],
    attitude: row.attitude,
    engagement: row.engagement,
    lastContact: toDateInput(row.lastContactAt),
    notes: row.notes ?? '',
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The body that adds the person the form names, with the scores it was filled with. */
export function buildCreateInput(projectId: string, values: StakeholderFormValues): CreateStakeholderInput {
  return {
    projectId,
    ...(values.kind === 'member' ? { memberId: values.memberId } : { crmContactId: values.contactId.trim() }),
    organisation: blankToNull(values.organisation),
    role: blankToNull(values.role),
    influence: Number(values.influence),
    interest: Number(values.interest),
    attitude: values.attitude,
    engagement: values.engagement,
    notes: blankToNull(values.notes),
    lastContactAt: fromDateInput(values.lastContact),
  };
}

/**
 * The body that saves the edit. The last contact is sent only when the date was
 * changed: the row holds a timestamp, the input only its day, and saving
 * something else must not move the time of day.
 */
export function buildUpdateInput(row: Stakeholder, values: StakeholderFormValues): UpdateStakeholderInput {
  const input: UpdateStakeholderInput = {
    organisation: blankToNull(values.organisation),
    role: blankToNull(values.role),
    influence: Number(values.influence),
    interest: Number(values.interest),
    attitude: values.attitude,
    engagement: values.engagement,
    notes: blankToNull(values.notes),
  };
  if (values.lastContact !== toDateInput(row.lastContactAt)) input.lastContactAt = fromDateInput(values.lastContact);
  return input;
}
