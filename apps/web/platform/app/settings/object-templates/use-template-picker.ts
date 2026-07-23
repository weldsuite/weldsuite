import { useCallback, useMemo, useState } from 'react';
import { useObjectTemplates } from '@/hooks/queries/use-object-templates-queries';
import { useCustomFields, type CustomFieldDefinition } from '@/hooks/queries/use-settings-queries';
import type { ObjectTemplateEntityType } from '@weldsuite/app-api-client/schemas/object-templates';
import { getDefaultSlugs, getRequiredBuiltinSlugs } from './registry';

export interface TemplatePickerTemplate {
  id: string;
  name: string;
  fields: string[];
}

export interface UseTemplatePickerResult {
  /** Templates available for the entity, lightweight projection. */
  templates: TemplatePickerTemplate[];
  /** Currently-selected template id; empty string = no template. */
  templateId: string;
  setTemplateId: (id: string) => void;
  /** Slugs to render in the quick-add dialog (required ∪ active). */
  visibleSlugs: string[];
  /** Slugs that always render and that templates cannot opt out of. */
  requiredSlugs: string[];
  /** Custom-field definitions keyed by raw slug (no `cf:` prefix). */
  customFieldBySlug: Record<string, CustomFieldDefinition>;
  /**
   * Walk visibleSlugs and assemble a create payload from RHF values.
   * Built-in slugs land on the root object; `cf:<slug>` collect under
   * `customFields`. Empty/undefined values are stripped.
   */
  buildPayload: (values: Record<string, unknown>) => Record<string, unknown>;
  /** Clear the selected template (call when the dialog closes). */
  reset: () => void;
}

/**
 * One hook to drive any quick-add dialog that supports object templates.
 *
 * Hides the (templates list × custom fields × required slugs) bookkeeping
 * so module dialogs only need to wire the form + renderer.
 */
export function useTemplatePicker(entityType: string): UseTemplatePickerResult {
  // Cast: the API expects an enum subset but at the front-end we accept any
  // registered string. Today the enum lists 'company' | 'person'; tomorrow
  // it's a free-form string (see backend Zod relax).
  const { data: templates } = useObjectTemplates(entityType as ObjectTemplateEntityType);
  const { data: customFields } = useCustomFields(entityType);
  const [templateId, setTemplateId] = useState<string>('');

  const projected = useMemo<TemplatePickerTemplate[]>(
    () => (templates ?? []).map((t) => ({ id: t.id, name: t.name, fields: t.fields })),
    [templates],
  );

  const customFieldBySlug = useMemo(
    () => Object.fromEntries((customFields ?? []).map((cf) => [cf.slug, cf])),
    [customFields],
  );

  const activeSlugs = useMemo(() => {
    const fallback = getDefaultSlugs(entityType);
    if (!templateId) return fallback;
    return projected.find((t) => t.id === templateId)?.fields ?? fallback;
  }, [entityType, templateId, projected]);

  const requiredSlugs = useMemo(() => {
    const builtin = getRequiredBuiltinSlugs(entityType);
    const cf = (customFields ?? []).filter((c) => c.required).map((c) => `cf:${c.slug}`);
    return [...builtin, ...cf];
  }, [entityType, customFields]);

  const visibleSlugs = useMemo(() => {
    const merged: string[] = [];
    for (const s of [...requiredSlugs, ...activeSlugs]) {
      if (!merged.includes(s)) merged.push(s);
    }
    return merged;
  }, [requiredSlugs, activeSlugs]);

  const buildPayload = useCallback(
    (values: Record<string, unknown>): Record<string, unknown> => {
      const payload: Record<string, unknown> = {};
      const cf: Record<string, unknown> = {};
      const customValues = (values.customFields ?? {}) as Record<string, unknown>;
      for (const slug of visibleSlugs) {
        if (slug.startsWith('cf:')) {
          const key = slug.slice(3);
          const v = customValues[key];
          if (v !== undefined && v !== '') cf[key] = v;
        } else {
          const v = values[slug];
          if (v !== undefined && v !== '') payload[slug] = v;
        }
      }
      if (Object.keys(cf).length) payload.customFields = cf;
      return payload;
    },
    [visibleSlugs],
  );

  const reset = useCallback(() => setTemplateId(''), []);

  return {
    templates: projected,
    templateId,
    setTemplateId,
    visibleSlugs,
    requiredSlugs,
    customFieldBySlug,
    buildPayload,
    reset,
  };
}
