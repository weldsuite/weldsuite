import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsEntityTypeSummary } from '@/lib/weldbooks/us-entity';

const mocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  navigate: vi.fn(),
  setEntityId: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canCreate: true,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => mocks.canCreate }));
vi.mock('@/hooks/use-current-accounting-entity', () => ({
  useCurrentAccountingEntity: () => ({ entityId: null, setEntityId: mocks.setEntityId }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateAccountingEntity: () => ({ mutateAsync: mocks.createEntity, isPending: false }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { revealEntitySsn: vi.fn() } }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { UsEntityCreateForm } from './us-entity-create-form';

const entityTypes: UsEntityTypeSummary[] = [
  {
    type: 'single_member_llc',
    label: 'LLC with one member',
    description: '',
    minOwners: 1,
    defaultClassification: 'disregarded',
    classifications: [
      { value: 'disregarded', form: 'sch_c', formLabel: 'Schedule C (Form 1040)' },
      { value: 's_corp', form: 'f1120s', formLabel: 'Form 1120-S' },
      { value: 'c_corp', form: 'f1120', formLabel: 'Form 1120' },
    ],
  },
];

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

function renderForm() {
  return render(<UsEntityCreateForm jurisdictionPicker={<div data-testid="picker">United States (US)</div>} entityTypes={entityTypes} />);
}

describe('UsEntityCreateForm', () => {
  beforeEach(() => {
    mocks.createEntity.mockReset();
    mocks.navigate.mockReset();
    mocks.setEntityId.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.canCreate = true;
    mocks.createEntity.mockResolvedValue({ data: { id: 'ent_new' } });
  });

  it('asks for a name and an entity type before it creates anything', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Create entity' }));

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Choose an entity type')).toBeInTheDocument();
    expect(mocks.createEntity).not.toHaveBeenCalled();
  });

  it('rejects an EIN with an unassigned prefix', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Display name *'), 'Acme');
    await user.type(screen.getByRole('textbox', { name: 'EIN' }), '07-1234567');
    await user.click(screen.getByRole('button', { name: 'Create entity' }));

    expect(await screen.findByText('The first two digits are not a prefix the IRS assigns')).toBeInTheDocument();
    expect(mocks.createEntity).not.toHaveBeenCalled();
  });

  // Fills a long form through user events; give it room when the suite runs in parallel.
  it('creates a US entity with its legal form, classification, EIN and accounting setup', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Display name *'), 'Acme');
    await user.type(screen.getByLabelText('Legal Name'), 'Acme LLC');
    await user.click(screen.getByRole('combobox', { name: 'Entity type' }));
    await user.click(await screen.findByRole('option', { name: 'LLC with one member' }));
    await user.click(screen.getByRole('combobox', { name: 'Tax classification' }));
    await user.click(await screen.findByRole('option', { name: 'S corporation — Form 1120-S' }));
    await user.type(screen.getByRole('textbox', { name: 'EIN' }), '123456789');
    await user.type(screen.getByLabelText('Doing business as (DBA)'), 'Acme Co');
    await user.click(screen.getByRole('combobox', { name: 'Accounting method' }));
    await user.click(await screen.findByRole('option', { name: 'Cash' }));

    await user.click(screen.getByRole('button', { name: 'Create entity' }));

    await waitFor(() => expect(mocks.createEntity).toHaveBeenCalledTimes(1));
    const payload = mocks.createEntity.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Acme',
      legalName: 'Acme LLC',
      jurisdictionCode: 'US',
      baseCurrency: 'USD',
      entityType: 'single_member_llc',
      taxClassification: 's_corp',
      dba: 'Acme Co',
      accountingMethod: 'cash',
      fiscalYearStart: 1,
      taxIdentifiers: { einOrSsn: '12-3456789' },
      address: { country: 'US' },
      isDefault: false,
      seedDefaults: true,
    });
    // No SSN was typed, and the automatic time zone is left for the server to pick from the state.
    expect(payload).not.toHaveProperty('ssn');
    expect(payload).not.toHaveProperty('timezone');
    expect(payload).not.toHaveProperty('fiscalYearConfig');
    expect(mocks.setEntityId).toHaveBeenCalledWith('ent_new');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldbooks/entities' });
  });

  it('sends a 52–53-week fiscal year as a config with the month it starts in', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Display name *'), 'Acme');
    await user.click(screen.getByRole('combobox', { name: 'Entity type' }));
    await user.click(await screen.findByRole('option', { name: 'LLC with one member' }));
    await user.click(screen.getByRole('combobox', { name: 'Fiscal year' }));
    await user.click(await screen.findByRole('option', { name: '52–53 weeks' }));

    await user.click(screen.getByRole('button', { name: 'Create entity' }));

    await waitFor(() => expect(mocks.createEntity).toHaveBeenCalledTimes(1));
    expect(mocks.createEntity.mock.calls[0][0]).toMatchObject({
      fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 12, weekday: 0, rule: 'last' },
      fiscalYearStart: 1,
    });
  });

  it('shows the server error and stays on the page when the entity can not be created', async () => {
    const user = userEvent.setup();
    mocks.createEntity.mockRejectedValue(new Error('An SSN can only be stored on a US entity'));
    renderForm();
    await user.type(screen.getByLabelText('Display name *'), 'Acme');
    await user.click(screen.getByRole('combobox', { name: 'Entity type' }));
    await user.click(await screen.findByRole('option', { name: 'LLC with one member' }));
    await user.click(screen.getByRole('button', { name: 'Create entity' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not create the entity', {
        description: 'An SSN can only be stored on a US entity',
      }),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps Create disabled without permission to create entities', () => {
    mocks.canCreate = false;
    renderForm();
    expect(screen.getByRole('button', { name: 'Create entity' })).toBeDisabled();
  });
});
