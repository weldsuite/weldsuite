import { useCallback, useMemo } from 'react';
import { drawerFieldRegistry, type DrawerFieldDefinition } from '@/lib/drawer-field-registry';
import { useGridViewSettings, useUpdateGridView } from './queries/use-settings-queries';

export function useDrawerFieldVisibility(
  registryKey: string,
  extraFields: DrawerFieldDefinition[] = [],
) {
  const config = drawerFieldRegistry[registryKey];
  const panelName = config?.panelName ?? `panel:${registryKey}`;
  const baseFields = config?.fields ?? [];
  const fields = useMemo(
    () => [...baseFields, ...extraFields],
    // baseFields is stable (registry constant); diff extras by id+label
    // to avoid retriggering when the array reference changes but content is the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseFields, JSON.stringify(extraFields.map((f) => [f.id, f.label, f.defaultVisible, f.required]))],
  );

  const { data, isLoading } = useGridViewSettings(panelName, !!config);
  const updateMutation = useUpdateGridView();

  // Merge saved overrides with defaults
  const fieldVisibility = useMemo(() => {
    const saved = data?.columnVisibility;
    const result: Record<string, boolean> = {};
    for (const field of fields) {
      if (field.required) {
        result[field.id] = true;
      } else if (saved && field.id in saved) {
        result[field.id] = saved[field.id];
      } else {
        result[field.id] = field.defaultVisible;
      }
    }
    return result;
  }, [data, fields]);

  const isFieldVisible = useCallback(
    (fieldId: string) => {
      const field = fields.find((f) => f.id === fieldId);
      if (field?.required) return true;
      return fieldVisibility[fieldId] ?? false;
    },
    [fieldVisibility, fields],
  );

  const toggleField = useCallback(
    (fieldId: string) => {
      const field = fields.find((f) => f.id === fieldId);
      if (field?.required) return;
      const next = { ...fieldVisibility, [fieldId]: !fieldVisibility[fieldId] };
      updateMutation.mutate({
        gridName: panelName,
        data: { columnVisibility: next, columnWidths: data?.columnWidths ?? {} },
      });
    },
    [fieldVisibility, fields, panelName, data, updateMutation],
  );

  const resetToDefaults = useCallback(() => {
    const defaults: Record<string, boolean> = {};
    for (const field of fields) {
      defaults[field.id] = field.required || field.defaultVisible;
    }
    updateMutation.mutate({
      gridName: panelName,
      data: { columnVisibility: defaults, columnWidths: data?.columnWidths ?? {} },
    });
  }, [fields, panelName, data, updateMutation]);

  return {
    fields,
    fieldVisibility,
    isFieldVisible,
    toggleField,
    resetToDefaults,
    isLoading,
  };
}
