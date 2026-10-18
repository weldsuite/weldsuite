import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import {
  hasUsableSelectOptions,
  slugifyCustomFieldName,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import { en } from '@weldsuite/i18n/locales/en';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

import { FieldDefinitionDialog, buildFieldSchema } from './field-definition-dialog';

const ts = en.settings.customFields;

describe('slugifyCustomFieldName (TASK-1003)', () => {
  it.each([
    ['Contract Größe & Type!', 'contract_grosse_type'],
    ['Café crème', 'cafe_creme'],
    ['Ærø Søndergård', 'aero_sondergard'],
    ['Œuvre  --  Łódź', 'oeuvre_lodz'],
    ['  __Leading and trailing__  ', 'leading_and_trailing'],
    ['Company Size', 'company_size'],
    ['VAT #2 (EU)', 'vat_2_eu'],
    ['名前', ''],
  ])('%s → %s', (name, slug) => {
    expect(slugifyCustomFieldName(name)).toBe(slug);
  });

  it('caps the length without leaving a trailing underscore', () => {
    expect(slugifyCustomFieldName('abc def', 4)).toBe('abc');
    expect(slugifyCustomFieldName('x'.repeat(150))).toHaveLength(100);
  });
});

describe('hasUsableSelectOptions (TASK-1049)', () => {
  it('requires a non-blank option for select types only', () => {
    expect(hasUsableSelectOptions('single_select', [])).toBe(false);
    expect(hasUsableSelectOptions('multi_select', undefined)).toBe(false);
    expect(hasUsableSelectOptions('single_select', [{ label: ' ', value: 'x' }])).toBe(false);
    expect(hasUsableSelectOptions('single_select', [{ label: 'Gold', value: 'gold' }])).toBe(true);
    expect(hasUsableSelectOptions('text', [])).toBe(true);
  });

  it('is enforced by the dialog schema with a translated message', () => {
    const schema = buildFieldSchema(ts.validation);
    const result = schema.safeParse({ name: 'Tier', slug: 'tier', fieldType: 'single_select', options: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ path: ['options'], message: ts.validation.optionsRequired });
    }
    expect(schema.safeParse({ name: 'Notes', slug: 'notes', fieldType: 'text', options: [] }).success).toBe(true);
  });
});

function draft(overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition {
  // An id of '' is the dialog's "create from a prefilled draft" mode (Duplicate).
  return {
    id: '',
    entityType: 'company',
    name: 'Tier',
    slug: 'tier',
    fieldType: 'text',
    options: [],
    required: false,
    ...overrides,
  } as CustomFieldDefinition;
}

describe('FieldDefinitionDialog', () => {
  it('disables Create for a single select without options', () => {
    render(
      <FieldDefinitionDialog
        open
        onOpenChange={vi.fn()}
        entityType="company"
        field={draft({ fieldType: 'single_select' })}
        onSubmit={vi.fn()}
        isPending={false}
      />,
    );
    expect(screen.getByText(ts.noOptions)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ts.createField })).toBeDisabled();
  });

  it('shows a taken slug on the Slug field instead of failing silently', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError("A custom field with slug 'tier' already exists for entity type 'company'", 409),
    );
    render(
      <FieldDefinitionDialog
        open
        onOpenChange={vi.fn()}
        entityType="company"
        field={draft({})}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: ts.createField }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(await screen.findByText(ts.validation.slugTaken)).toBeInTheDocument();
  });

  it('derives a transliterated slug from the name', async () => {
    render(
      <FieldDefinitionDialog
        open
        onOpenChange={vi.fn()}
        entityType="company"
        field={null}
        onSubmit={vi.fn()}
        isPending={false}
      />,
    );
    await userEvent.type(screen.getByLabelText(ts.fieldName), 'Contract Größe & Type!');
    expect(screen.getByLabelText(ts.fieldSlug)).toHaveValue('contract_grosse_type');
  });
});
