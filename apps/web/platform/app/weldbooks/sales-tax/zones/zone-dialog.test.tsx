import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ZoneDialog } from './zone-dialog';
import { installPointerPolyfills, makeAgency, makeJurisdiction, makeRate, renderWithProviders } from '../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const tz = setup.zones.dialog;

const texas = makeJurisdiction({ id: 'stj_1', level: 'state', name: 'Texas', currentRate: 6.25 });
const travis = makeJurisdiction({ id: 'stj_2', level: 'county', name: 'Travis County', currentRate: 1, rates: [makeRate({ rate: '1.0000' })] });
const austin = makeJurisdiction({ id: 'stj_3', level: 'city', name: 'Austin', currentRate: 1, rates: [makeRate({ rate: '1.0000' })] });
const jurisdictions = [texas, travis, austin];

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.post.mockReset();
  api.patch.mockReset();
  toast.success.mockReset();
  api.post.mockResolvedValue({ data: { id: 'stz_new' } });
  api.patch.mockResolvedValue({ data: { id: 'stz_1' } });
});

function renderDialog(props: Partial<React.ComponentProps<typeof ZoneDialog>> = {}) {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <ZoneDialog agency={makeAgency()} jurisdictions={jurisdictions} open onOpenChange={onOpenChange} {...props} />,
  );
  return { onOpenChange };
}

async function pick(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await user.click(screen.getByRole('combobox', { name: tz.jurisdictions }));
  for (const name of names) await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
  await user.keyboard('{Escape}');
}

describe('ZoneDialog', () => {
  it('adds up the combined rate of the chosen jurisdictions as they are picked', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByTestId('zone-combined-rate')).toHaveTextContent('0%');

    await pick(user, 'Texas', 'Travis County', 'Austin');

    expect(screen.getByTestId('zone-combined-rate')).toHaveTextContent('8.25%');
  });

  it('shows how many entries it understood and how many ZIP codes they cover', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(tz.zips), '78701, 78702, 78710-78799');

    expect(screen.getByTestId('zip-summary')).toHaveTextContent('3 entries understood · 92 ZIP codes');
  });

  it('saves the zone with its ZIP list parsed into the API shape', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(tz.name), 'Austin');
    await pick(user, 'Texas', 'Austin');
    await user.type(screen.getByLabelText(tz.zips), '78701, 78702, 78710 - 78799');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax-zones', {
      agencyId: 'sta_1',
      name: 'Austin',
      jurisdictionIds: ['stj_1', 'stj_3'],
      postalCodes: ['78701', '78702', { from: '78710', to: '78799' }],
      isOrigin: false,
      priority: 100,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith(setup.zones.created);
  });

  it('names the ZIP codes it cannot read and does not save', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(tz.name), 'Austin');
    await pick(user, 'Texas');
    await user.type(screen.getByLabelText(tz.zips), '78701, 7870, 78799-78710');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const message = await screen.findByText(/Fix the ZIP codes/);
    expect(message).toHaveTextContent('"7870" is not a ZIP code or range');
    expect(message).toHaveTextContent('"78799-78710" runs backwards');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('needs ZIP codes, unless the zone is marked as the own location', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(tz.name), 'Head office');
    await pick(user, 'Texas');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(setup.validation.zoneZips)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('switch', { name: new RegExp(tz.origin) }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ name: 'Head office', isOrigin: true, postalCodes: [] });
  });

  it('needs a jurisdiction and a name', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(setup.validation.required)).toBeInTheDocument();
    expect(screen.getByText(setup.validation.zoneJurisdictions)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('edits a zone: starts from what is saved and patches it', async () => {
    const user = userEvent.setup();
    renderDialog({
      zone: {
        id: 'stz_1',
        agencyId: 'sta_1',
        stateCode: 'TX',
        name: 'Austin',
        jurisdictionIds: ['stj_1', 'stj_3'],
        postalCodes: ['78701', { from: '78710', to: '78799' }],
        isOrigin: false,
        priority: 50,
        jurisdictions: [],
        combinedRate: 7.25,
      },
    });

    expect(screen.getByLabelText(tz.name)).toHaveValue('Austin');
    expect(screen.getByLabelText(tz.zips)).toHaveValue('78701, 78710-78799');
    expect(screen.getByLabelText(tz.priority)).toHaveValue(50);
    expect(screen.getByTestId('zone-combined-rate')).toHaveTextContent('7.25%');

    fireEvent.change(screen.getByLabelText(tz.zips), { target: { value: '78701' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/sales-tax-zones/stz_1', {
      name: 'Austin',
      jurisdictionIds: ['stj_1', 'stj_3'],
      postalCodes: ['78701'],
      isOrigin: false,
      priority: 50,
    });
  });

  it('shows the server sentence when a zone is refused', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('A zone can only combine jurisdictions of its own agency (state).'));
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(tz.name), 'Austin');
    await pick(user, 'Texas');
    await user.type(screen.getByLabelText(tz.zips), '78701');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/only combine jurisdictions of its own agency/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
