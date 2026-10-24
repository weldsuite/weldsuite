/**
 * Who fills each role when a template is used: the form's starting values, and
 * the request the server gets. Kept apart from the dialog so both are easy to
 * check on their own.
 */

import type { SignEnvelopeDetail, SignRecipientDto, UseSignTemplateInput } from '@weldsuite/app-api-client/schemas/weldsign';

/** A signing role that needs an access code from whoever uses the template; a copy role opens by link alone. */
export function needsAccessCode(role: Pick<SignRecipientDto, 'role' | 'authMode'>): boolean {
  return role.role !== 'cc' && role.authMode === 'access_code';
}

/** The form's row for one role: its usual person, and an empty code box where one is needed. */
export function recipientDefaults(role: SignRecipientDto) {
  return {
    roleId: role.id,
    name: role.name ?? '',
    email: role.email ?? '',
    accessCode: needsAccessCode(role) ? '' : undefined,
  };
}

interface UseTemplateFormValues {
  title?: string;
  message?: string | null;
  recipients: { roleId: string; name: string; email: string; accessCode?: string | null }[];
}

/**
 * The request for `POST /sign/templates/:id/use`. A title or message left as
 * the template has it is not sent (the server fills it in); a message that was
 * cleared is sent as `null`. A code is only sent for a role that needs one.
 */
export function buildUseTemplateInput(
  values: UseTemplateFormValues,
  template: Pick<SignEnvelopeDetail, 'title' | 'message' | 'recipientList'>,
): UseSignTemplateInput {
  const codeRoles = new Set(template.recipientList.filter(needsAccessCode).map((role) => role.id));
  const title = values.title?.trim();
  const message = values.message?.trim() ?? '';
  return {
    title: title && title !== template.title ? title : undefined,
    message: message === (template.message ?? '') ? undefined : message || null,
    recipients: values.recipients.map((person) => ({
      roleId: person.roleId,
      name: person.name,
      email: person.email,
      accessCode: codeRoles.has(person.roleId) ? person.accessCode : undefined,
    })),
  };
}

/** Whether a template can be used at all: the server refuses one without documents or without roles. */
export function canUseTemplate(template: { documentCount: number; roles: unknown[] }): boolean {
  return template.documentCount > 0 && template.roles.length > 0;
}
