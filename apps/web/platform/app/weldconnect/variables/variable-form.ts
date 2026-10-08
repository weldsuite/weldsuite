/**
 * Pure helpers behind the Create / Edit Variable dialog: client-side
 * validation (mirroring the API's rules) and the request bodies it sends.
 */

import { VARIABLE_NAME_PATTERN } from '@weldsuite/app-api-client/schemas/weldconnect';

export interface VariableFormFields {
  name: string;
  value: string;
  confirmValue: string;
  description: string;
  isSecret: boolean;
  scope: string;
  workflowId: string;
}

export interface VariableFormMessages {
  nameRequired: string;
  nameInvalid: string;
  valueRequired: string;
  valuesMismatch: string;
  workflowRequired: string;
  updateRequiresChange: string;
}

/**
 * What the edit dialog opened with. Edit sends only what changed, and a
 * secret's value is never part of it (the API masks it), so `value` is ''
 * for secrets.
 */
export interface VariableFormInitial {
  name: string;
  value: string;
  description: string;
  isSecret: boolean;
}

/** Error text per form field; `form` is for problems that belong to no single field. */
export interface VariableFormErrors {
  name?: string;
  value?: string;
  confirmValue?: string;
  workflowId?: string;
  form?: string;
}

/**
 * The text an edit dialog pre-fills for a stored value. Secrets are
 * write-only, so they are never pre-filled.
 */
export function variableValueToFormText(value: unknown, isSecret: boolean): string {
  if (isSecret || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function validateName(name: string, messages: VariableFormMessages): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return messages.nameRequired;
  // Read in a step as {{variables.<name>}}: anything else never resolves.
  if (!VARIABLE_NAME_PATTERN.test(trimmed)) return messages.nameInvalid;
  return undefined;
}

function hasEditChanges(form: VariableFormFields, initial: VariableFormInitial): boolean {
  if (form.name.trim() !== initial.name) return true;
  if (form.description.trim() !== initial.description.trim()) return true;
  // A secret has no value to compare with: any new value is a change.
  if (initial.isSecret) return form.value.trim() !== '';
  return form.value.trim() !== initial.value.trim();
}

export function getVariableFormErrors(
  mode: 'create' | 'edit',
  form: VariableFormFields,
  messages: VariableFormMessages,
  initial?: VariableFormInitial,
): VariableFormErrors {
  const errors: VariableFormErrors = {};
  const nameError = validateName(form.name, messages);
  if (nameError) errors.name = nameError;

  if (mode === 'create') {
    if (form.scope === 'workflow' && !form.workflowId) errors.workflowId = messages.workflowRequired;
    if (!form.value.trim()) errors.value = messages.valueRequired;
    if (form.isSecret && form.value !== form.confirmValue) errors.confirmValue = messages.valuesMismatch;
    return errors;
  }

  // Edit: a secret's blank value keeps the stored one; a plain value is
  // pre-filled and may not be emptied.
  if (!form.isSecret && !form.value.trim()) errors.value = messages.valueRequired;
  if (Object.keys(errors).length === 0 && initial && !hasEditChanges(form, initial)) {
    errors.form = messages.updateRequiresChange;
  }
  return errors;
}

export function buildVariableCreateBody(form: VariableFormFields) {
  const scope: 'global' | 'workflow' = form.scope === 'workflow' ? 'workflow' : 'global';
  return {
    name: form.name.trim(),
    value: form.value.trim(),
    description: form.description.trim() || undefined,
    isSecret: form.isSecret,
    scope,
    workflowId: scope === 'workflow' ? form.workflowId : undefined,
  };
}

/** Only the fields that changed, so an untouched value (or a secret) is left alone. */
export function buildVariableUpdateBody(
  form: Pick<VariableFormFields, 'name' | 'value' | 'description'>,
  initial: VariableFormInitial,
): { name?: string; value?: string; description?: string } {
  const body: { name?: string; value?: string; description?: string } = {};
  const name = form.name.trim();
  if (name !== initial.name) body.name = name;
  const value = form.value.trim();
  if (initial.isSecret ? value !== '' : value !== initial.value.trim()) body.value = value;
  const description = form.description.trim();
  if (description !== initial.description.trim()) body.description = description;
  return body;
}
