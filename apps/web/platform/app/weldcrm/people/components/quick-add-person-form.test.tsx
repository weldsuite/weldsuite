import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mutateAsync = vi.fn();
const openPanel = vi.fn();

vi.mock('@/components/object-panel/use-object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/hooks/queries/use-people-queries', () => ({
  useCreatePerson: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/app/settings/object-templates/use-template-picker', () => ({
  useTemplatePicker: () => ({
    templates: [],
    templateId: '',
    setTemplateId: vi.fn(),
    visibleSlugs: ['firstName', 'lastName', 'email', 'directPhone', 'mobilePhone', 'title', 'department'],
    requiredSlugs: [],
    customFieldBySlug: {},
    buildPayload: (values: Record<string, unknown>) => {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== '') payload[key] = value;
      }
      return payload;
    },
    reset: vi.fn(),
  }),
}));

import { ApiError } from '@weldsuite/api-client';
import { QuickAddPersonForm } from './quick-add-person-form';

describe('QuickAddPersonForm', () => {
  it('prefills a typed email and keeps the rest of the details editable', async () => {
    mutateAsync.mockResolvedValue({ data: { id: 'per_1', displayName: 'Jane Doe', email: 'jane.doe@acme.com' } });
    const onCreated = vi.fn();

    render(
      <QuickAddPersonForm initialName="jane.doe@acme.com" onCreated={onCreated} onCancel={vi.fn()} />,
    );

    expect(screen.getByLabelText('First Name')).toHaveValue('Jane');
    expect(screen.getByLabelText('Last Name')).toHaveValue('Doe');
    expect(screen.getByLabelText('Email')).toHaveValue('jane.doe@acme.com');

    fireEvent.change(screen.getByLabelText('Direct Phone'), { target: { value: '+31 6 12345678' } });
    fireEvent.change(screen.getByLabelText('Job Title'), { target: { value: 'Founder' } });
    fireEvent.click(screen.getByRole('button', { name: 'crm.quickAddPerson.saveButton' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane.doe@acme.com',
        directPhone: '+31 6 12345678',
        title: 'Founder',
      }),
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it('prefills a typed name and leaves email empty', () => {
    render(<QuickAddPersonForm initialName="Ada Lovelace" onCreated={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('First Name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Last Name')).toHaveValue('Lovelace');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Mobile Phone')).toBeInTheDocument();
    expect(screen.getByLabelText('Department')).toBeInTheDocument();
  });

  it('offers "Open existing person" when the email already belongs to a CRM person (409)', async () => {
    mutateAsync.mockRejectedValueOnce(
      new ApiError('A person with this email already exists.', 409, {
        error: { code: 'CONFLICT', details: { existingPersonId: 'per_existing' } },
      }),
    );
    const onCancel = vi.fn();
    render(<QuickAddPersonForm initialName="jane.doe@acme.com" onCreated={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'crm.quickAddPerson.saveButton' }));

    const open = await screen.findByRole('button', { name: 'crm.quickAddPerson.openExistingPerson' });
    expect(screen.getByText('crm.quickAddPerson.duplicateEmail')).toBeInTheDocument();

    fireEvent.click(open);
    expect(openPanel).toHaveBeenCalledWith({ type: 'person', id: 'per_existing' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('does not show the duplicate action for other failures', async () => {
    mutateAsync.mockRejectedValueOnce(new ApiError('boom', 500, { error: { message: 'boom' } }));
    render(<QuickAddPersonForm initialName="jane.doe@acme.com" onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'crm.quickAddPerson.saveButton' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(screen.queryByText('crm.quickAddPerson.duplicateEmail')).not.toBeInTheDocument();
  });
});
