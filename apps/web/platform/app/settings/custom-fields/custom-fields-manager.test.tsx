import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

const deleteField = vi.fn();

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/entity-list', () => ({ FilterPills: () => null }));
vi.mock('@/components/settings/expanding-search-input', () => ({ ExpandingSearchInput: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const field = {
  id: 'cf_1',
  entityType: 'company',
  name: 'E2E Field',
  slug: 'e2e_field',
  fieldType: 'text',
  required: false,
} as unknown as CustomFieldDefinition;

vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useCustomFields: () => ({ data: [field], isLoading: false }),
  useCreateCustomField: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateCustomField: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteCustomField: () => ({ mutateAsync: deleteField, isPending: false }),
}));

import { CustomFieldsManager } from './custom-fields-manager';

const ts = en.settings.customFields;

describe('CustomFieldsManager (TASK-1426)', () => {
  beforeEach(() => deleteField.mockReset().mockResolvedValue(undefined));

  it('names the object of each field when all objects are shown', () => {
    render(<CustomFieldsManager />);
    expect(screen.getByRole('combobox', { name: ts.objectFilterLabel })).toHaveTextContent(ts.allObjects);
    expect(screen.getByText(ts.object)).toBeInTheDocument();
    expect(screen.getByText('Companies')).toBeInTheDocument();
  });

  it('asks before deleting a field, naming it and its object', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsManager />);
    await user.click(screen.getByRole('button', { name: en.common.actions.openMenu }));
    await user.click(await screen.findByRole('menuitem', { name: en.common.actions.delete }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('"E2E Field"');
    expect(dialog).toHaveTextContent('Companies');
    expect(deleteField).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: en.common.actions.delete }));
    await waitFor(() => expect(deleteField).toHaveBeenCalledWith('cf_1'));
  });
});
