/**
 * "Send for signature" in the header menu of the CRM company, person and
 * opportunity panels. The flow itself (the draft, the permission and the
 * installed-app checks) is covered in `app/weldsign/start`; here the menus
 * only have to offer it for their own record, where it is available.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';

const flow = vi.hoisted(() => ({ available: true, start: vi.fn() }));
vi.mock('@/app/weldsign/start/use-start-sign-request', () => ({
  useStartSignRequest: () => ({ available: flow.available, starting: false, start: flow.start }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (path: string) => path }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({}),
  useAppApiClient: () => ({ getClient: async () => ({}) }),
}));

import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import { CompanyActions } from './company/company-panel';
import { OpportunityActions } from './opportunity/opportunity-panel';
import type { Opportunity } from './opportunity/use-opportunity-data';
import { PersonActions } from './person/person-panel';
import type { Person } from './person/use-person-data';

const action = en.weldsign.start.action;

const company = { id: 'cus_1', displayName: 'Acme BV', email: null, phone: null, archivedAt: null } as unknown as Company;
const person = { id: 'per_1', displayName: 'Ann Lee', email: null, directPhone: null, mobilePhone: null, inCrm: true, archivedAt: null } as unknown as Person;
const opportunity = { id: 'opp_1', name: 'Website rebuild', status: 'open' } as unknown as Opportunity;

const noop = () => undefined;
const tabs = { tabFields: [], isTabVisible: () => true, onToggleTab: noop, onResetTabs: noop };

const panels: { label: string; source: { entityType: string; id: string; name: string }; render: () => ReactNode }[] = [
  {
    label: 'company',
    source: { entityType: 'company', id: 'cus_1', name: 'Acme BV' },
    render: () => <CompanyActions company={company} onArchiveToggle={noop} onDelete={noop} {...tabs} />,
  },
  {
    label: 'person',
    source: { entityType: 'person', id: 'per_1', name: 'Ann Lee' },
    render: () => <PersonActions person={person} onArchiveToggle={noop} onDelete={noop} {...tabs} />,
  },
  {
    label: 'opportunity',
    source: { entityType: 'opportunity', id: 'opp_1', name: 'Website rebuild' },
    render: () => <OpportunityActions opportunity={opportunity} onMarkWon={noop} onMarkLost={noop} onDelete={noop} />,
  },
];

async function openMenu(content: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{content}</I18nProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'sweep.entities.moreActions' }));
  return user;
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  flow.available = true;
  flow.start.mockReset();
});

afterEach(() => cleanup());

describe.each(panels)('$label panel menu', ({ source, render: content }) => {
  it('offers Send for signature, for its own record', async () => {
    const user = await openMenu(content());

    await user.click(await screen.findByRole('menuitem', { name: action }));

    expect(flow.start).toHaveBeenCalledTimes(1);
    expect(flow.start).toHaveBeenCalledWith(source);
  });

  it('leaves it out where WeldSign is not available, and keeps the other actions', async () => {
    flow.available = false;
    await openMenu(content());

    expect(screen.queryByRole('menuitem', { name: action })).toBeNull();
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });
});
