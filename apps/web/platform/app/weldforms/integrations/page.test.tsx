import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FormDetail, FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import { en } from '@weldsuite/i18n/locales/en';
import IntegrationsTabPage from './page';

const ti = en.weldformsResults.integrations;

interface Query {
  isLoading: boolean;
  error: Error | null;
  data: FormIntegration[] | undefined;
  refetch: () => void;
}

let search: Record<string, unknown> = {};
let canEdit = true;
let query: Query;
const navigate = vi.fn();
const refetch = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ formId: 'frm_1' }),
  useSearch: () => search,
  useNavigate: () => navigate,
}));

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));

vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/lib/apps/app-registry', () => ({
  getAppLogo: (code: string) => (code === 'weldcrm' ? '/logos/crm.svg' : undefined),
  getAppLucideIcon: () => (props: { className?: string }) => <svg data-testid="fallback-icon" className={props.className} />,
}));

vi.mock('../results/form-gate', () => ({
  FormGate: ({ children }: { children: (form: FormDetail) => ReactNode }) =>
    children({ id: 'frm_1', permissions: { edit: canEdit } } as unknown as FormDetail),
  FormTabFrame: ({ children }: { children: ReactNode }) => <div data-testid="frame">{children}</div>,
}));

vi.mock('@/hooks/queries/use-weldforms-results-queries', () => ({
  useFormIntegrations: () => query,
}));

vi.mock('./crm-card', () => ({ CrmCard: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>crm card</button> }));
vi.mock('./desk-card', () => ({ DeskCard: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>desk card</button> }));
vi.mock('./flow-card', () => ({ FlowCard: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>flow card</button> }));

function integration(kind: string, extra: Partial<FormIntegration> = {}): FormIntegration {
  return { id: `int_${kind}`, kind, enabled: true, lastError: null, updatedAt: 't1', ...extra } as unknown as FormIntegration;
}

describe('Forms integrations tab', () => {
  beforeEach(() => {
    cleanup();
    search = {};
    canEdit = true;
    query = { isLoading: false, error: null, data: [], refetch };
    navigate.mockClear();
    refetch.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders the cards grouped by category', () => {
    render(<IntegrationsTabPage />);
    for (const title of [ti.crm.title, ti.desk.title, ti.flow.title, ti.connect.title, ti.webhooks.title]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getAllByText(en.navigation.appstore.categoryCustomers).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.navigation.appstore.categoryWork).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ti.categoryDevelopers).length).toBeGreaterThan(0);
    // CRM has a logo path, the others fall back to an icon.
    expect(document.querySelector('img[src="/logos/crm.svg"]')).toBeTruthy();
    expect(screen.getAllByTestId('fallback-icon').length).toBeGreaterThan(0);
  });

  it('shows a status badge for configured integrations only', () => {
    query.data = [integration('crm'), integration('desk', { enabled: false }), integration('flow', { lastError: 'boom' })];
    render(<IntegrationsTabPage />);
    expect(screen.getByText(ti.statusOn)).toBeTruthy();
    expect(screen.getByText(ti.statusOff)).toBeTruthy();
    expect(screen.getByText(ti.statusFailed)).toBeTruthy();
  });

  it('writes ?app= when a card is clicked, keeping other search params', () => {
    render(<IntegrationsTabPage />);
    fireEvent.click(screen.getByText(ti.desk.title));
    const arg = navigate.mock.calls[0][0] as { to: string; search: (prev: Record<string, unknown>) => Record<string, unknown> };
    expect(arg.to).toBe('.');
    expect(arg.search({ tab: 'x', app: 'old' })).toEqual({ tab: 'x', app: 'desk' });
  });

  it.each([
    ['crm', 'crm card'],
    ['desk', 'desk card'],
    ['flow', 'flow card'],
  ])('opens the %s detail view and Back clears app', (app, label) => {
    search = { app };
    render(<IntegrationsTabPage />);
    fireEvent.click(screen.getByText(label));
    const arg = navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> };
    expect(arg.search({ tab: 'x', app })).toEqual({ tab: 'x' });
  });

  it.each([
    ['connect', ti.connect, '/weldconnect'],
    ['webhooks', ti.webhooks, '/settings/webhooks'],
  ] as const)('opens the %s page with a link and Back', (app, copy, href) => {
    search = { app };
    render(<IntegrationsTabPage />);
    expect(screen.getByText(copy.description)).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.open }).getAttribute('href')).toBe(href);
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.back }));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown app value', () => {
    search = { app: 'nope' };
    render(<IntegrationsTabPage />);
    expect(screen.getByText(ti.crm.title)).toBeTruthy();
  });

  it('scrolls to a category from the categories column', () => {
    render(<IntegrationsTabPage />);
    const nav = screen.getByRole('navigation', { name: en.navigation.appstore.categories });
    const buttons = nav.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    for (const button of Array.from(buttons)) fireEvent.click(button);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(3);
  });

  it('shows the no-access state without edit permission', () => {
    canEdit = false;
    render(<IntegrationsTabPage />);
    expect(screen.getByText(ti.noAccessTitle)).toBeTruthy();
    expect(screen.queryByText(ti.crm.title)).toBeNull();
  });

  it('shows a loader while loading', () => {
    query = { ...query, isLoading: true, data: undefined };
    render(<IntegrationsTabPage />);
    expect(screen.queryByText(ti.crm.title)).toBeNull();
    expect(screen.queryByText(en.weldformsResults.common.loadFailed)).toBeNull();
  });

  it('shows an error with retry', () => {
    query = { ...query, error: new Error('x'), data: undefined };
    render(<IntegrationsTabPage />);
    expect(screen.getByText(en.weldformsResults.common.loadFailed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(refetch).toHaveBeenCalled();
  });
});
