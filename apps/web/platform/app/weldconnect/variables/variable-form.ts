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

export function getVariableFormError(
  mode: 'create' | 'edit',
  form: VariableFormFields,
  messages: VariableFormMessages,
): string | null {
  if (mode === 'create') {
    const name = form.name.trim();
    if (!name) return messages.nameRequired;
    // Read in a step as {{variables.<name>}}: anything else never resolves.
    if (!VARIABLE_NAME_PATTERN.test(name)) return messages.nameInvalid;
    if (form.scope === 'workflow' && !form.workflowId) return messages.workflowRequired;
    if (!form.value.trim()) return messages.valueRequired;
    if (form.isSecret && form.value !== form.confirmValue) return messages.valuesMismatch;
    return null;
  }
  if (!form.value.trim() && !form.description.trim()) return messages.updateRequiresChange;
  return null;
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

export function buildVariableUpdateBody(value: string, description: string): { value?: string; description?: string } {
  const body: { value?: string; description?: string } = {};
  if (value.trim()) body.value = value;
  if (description.trim()) body.description = description;
  return body;
}
