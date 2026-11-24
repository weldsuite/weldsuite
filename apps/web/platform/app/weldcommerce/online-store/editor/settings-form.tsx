/**
 * A settings form generated from `SettingDefinition`s (React Hook Form with
 * the Zod schema of `../lib/settings-schema`). It edits live: each change
 * that passes its setting's own check goes to `onChange` straight away (the
 * editor saves the draft a moment later); a value that does not pass stays in
 * the field with its message, which shows once the field is left
 * (`mode: 'onTouched'`) and clears as soon as the value is fixed.
 *
 * Undo and redo change `values` from outside; the form follows them. Field
 * errors from the last refused save (`serverErrors`) show on their fields.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { SettingDefinition, SettingValue, SettingValues } from '@weldsuite/storefront-theme/catalog';
import { Form } from '@weldsuite/ui/components/form';
import { formValues, settingSchema, settingsSchema } from '../lib/settings-schema';
import { SettingField } from './setting-field';

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

export interface SettingsFormProps {
  definitions: readonly SettingDefinition[];
  values: SettingValues;
  /** A valid change: the setting's id and its new value. */
  onChange: (id: string, value: SettingValue) => void;
  serverErrors?: Record<string, string>;
  readOnly?: boolean;
  siteId: string;
  /** The form's accessible name. */
  label: string;
}

export function SettingsForm({ definitions, values, onChange, serverErrors, readOnly = false, siteId, label }: Readonly<SettingsFormProps>) {
  const schema = useMemo(() => settingsSchema(definitions), [definitions]);
  const fieldSchemas = useMemo(() => new Map(definitions.map((definition) => [definition.id, settingSchema(definition)])), [definitions]);
  const current = useMemo(() => formValues(definitions, values), [definitions, values]);
  const form = useForm<SettingValues>({ resolver: zodResolver(schema), defaultValues: current, mode: 'onTouched' });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const subscription = form.watch((all, { name }) => {
      if (!name) return;
      const id = name.split('.')[0]!;
      const result = fieldSchemas.get(id)?.safeParse((all as SettingValues)[id]);
      if (result?.success) onChangeRef.current(id, result.data as SettingValue);
    });
    return () => subscription.unsubscribe();
  }, [form, fieldSchemas]);

  // Undo, redo, a preset or a reload changed values from outside: show those (a field still being fixed keeps its text otherwise).
  const previous = useRef(current);
  useEffect(() => {
    const before = previous.current;
    previous.current = current;
    const shown = form.getValues();
    const changed = definitions.filter(
      (definition) => !sameValue(before[definition.id], current[definition.id]) && !sameValue(shown[definition.id], current[definition.id]),
    );
    if (changed.length === 0) return;
    const next = { ...shown };
    for (const definition of changed) next[definition.id] = current[definition.id] ?? null;
    form.reset(next, { keepErrors: true, keepTouched: true });
  }, [current, definitions, form]);

  useEffect(() => {
    for (const [id, message] of Object.entries(serverErrors ?? {})) {
      if (definitions.some((definition) => definition.id === id)) form.setError(id, { type: 'server', message });
    }
  }, [serverErrors, definitions, form]);

  return (
    <Form {...form}>
      <form aria-label={label} noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset disabled={readOnly} className="grid gap-5">
          {definitions.map((definition) => (
            <SettingField key={definition.id} definition={definition} siteId={siteId} />
          ))}
        </fieldset>
      </form>
    </Form>
  );
}
