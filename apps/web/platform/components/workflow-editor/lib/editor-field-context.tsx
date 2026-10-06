import { createContext, useContext } from 'react';
import type { VariableItem } from '@weldsuite/ui/components/workflow-canvas/parts/variable-picker';

/**
 * Editor-wide context for the step config forms. The forms render some thirty
 * `VariableInput`s; these values reach every one of them through the localized
 * wrapper instead of being threaded through each form's props.
 */

/** Fields of the record the workflow's entity-event trigger fires for. */
const TriggerRecordFieldsContext = createContext<VariableItem[] | undefined>(undefined);
export const TriggerRecordFieldsProvider = TriggerRecordFieldsContext.Provider;
export function useTriggerRecordFields(): VariableItem[] | undefined {
  return useContext(TriggerRecordFieldsContext);
}

/** `id` of the control a `FormField` labels, so its `<label htmlFor>` resolves. */
const FormFieldIdContext = createContext<string | undefined>(undefined);
export const FormFieldIdProvider = FormFieldIdContext.Provider;
export function useFormFieldId(): string | undefined {
  return useContext(FormFieldIdContext);
}
