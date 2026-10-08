import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('../use-variable-workflows', () => ({ useVariableWorkflows: () => ({ data: { data: [] } }) }));
vi.mock('@/hooks/queries/use-automation-queries', () => ({
  useDeleteVariable: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateVariable: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateVariable: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { VariablesClient } = await import('./variables-client');
const { VariableDialog } = await import('./variable-dialog');
type Variable = import('./variables-client').Variable;

const baseUrl: Variable = {
  id: 'var_1',
  name: 'e2e_base_url',
  value: 'https://e2e-test.invalid',
  type: 'string',
  scope: 'global',
  isSecret: false,
  createdAt: '2026-01-02T10:00:00.000Z',
};

const token: Variable = { ...baseUrl, id: 'var_2', name: 'api_token', value: '********', isSecret: true };

describe('VariablesClient', () => {
  it('shows a loading state, not the empty state, while the variables load', () => {
    render(<VariablesClient initialVariables={[]} isLoading />);
    expect(screen.queryByText(en.weldconnect.variablesClient.emptyTitle)).toBeNull();
  });

  it('shows the empty state once loaded with nothing', () => {
    render(<VariablesClient initialVariables={[]} isLoading={false} />);
    expect(screen.getByText(en.weldconnect.variablesClient.emptyTitle)).toBeTruthy();
  });

  it('renders the rows on the same render the data arrives (no empty flash)', () => {
    const { rerender } = render(<VariablesClient initialVariables={[]} isLoading />);
    rerender(<VariablesClient initialVariables={[baseUrl]} isLoading={false} />);
    expect(screen.queryByText(en.weldconnect.variablesClient.emptyTitle)).toBeNull();
    expect(screen.getByText('e2e_base_url')).toBeTruthy();
  });

  it('gives a plain value its full text as a tooltip, and never a secret', () => {
    render(<VariablesClient initialVariables={[baseUrl, token]} isLoading={false} />);
    const value = screen.getByText('https://e2e-test.invalid');
    expect(value.getAttribute('title')).toBe('https://e2e-test.invalid');
    const masked = screen.getByText('••••••••');
    expect(masked.getAttribute('title')).toBeNull();
  });
});

describe('VariableDialog (edit)', () => {
  it('pre-fills the name and a plain value', () => {
    render(<VariableDialog open onOpenChange={() => {}} mode="edit" variable={baseUrl} />);
    expect((screen.getByLabelText(/Variable Name/) as HTMLInputElement).value).toBe('e2e_base_url');
    expect((screen.getByLabelText(/^Value/) as HTMLInputElement).value).toBe('https://e2e-test.invalid');
    expect((screen.getByLabelText(/Variable Name/) as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps a secret write-only: its value is not pre-filled', () => {
    render(<VariableDialog open onOpenChange={() => {}} mode="edit" variable={token} />);
    expect((screen.getByLabelText(/New Value/) as HTMLInputElement).value).toBe('');
  });
});
