import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const env = vi.hoisted(() => ({
  params: { id: 'ent_1', templateId: 'itpl_1' },
  template: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown, refetch: vi.fn() },
}));

vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return {
    Link: RouteLink,
    Navigate: ({ to, params }: { to: string; params: Record<string, string> }) => (
      <div data-testid="navigate">
        {Object.entries(params).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}
      </div>
    ),
  };
});
vi.mock('@/lib/router', () => ({ useParams: () => env.params }));
vi.mock('../../entity-scope', () => ({
  WeldbooksEntityScope: ({ entityId, children }: { entityId: string; children: React.ReactNode }) => (
    <div data-testid="scope" data-entity={entityId}>
      {children}
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-invoice-template-queries', () => ({ useInvoiceTemplate: () => env.template }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: (id: string | undefined) => ({ data: id ? { id, name: 'Weld BV' } : undefined, isLoading: false }),
}));
vi.mock('../designer/designer', () => ({
  InvoiceTemplateDesigner: ({ template }: { template: { id: string } }) => <div data-testid="designer">{template.id}</div>,
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import InvoiceTemplateDesignerPage from './page';

describe('InvoiceTemplateDesignerPage', () => {
  beforeEach(() => {
    env.params = { id: 'ent_1', templateId: 'itpl_1' };
    env.template = { data: { id: 'itpl_1', entityId: 'ent_1' }, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  });

  it('designs the template under the entity of the URL', () => {
    render(<InvoiceTemplateDesignerPage />);

    expect(screen.getByTestId('scope')).toHaveAttribute('data-entity', 'ent_1');
    expect(screen.getByTestId('designer')).toHaveTextContent('itpl_1');
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it("moves on to the template's own entity when the URL names another one", () => {
    env.params = { id: 'ent_other', templateId: 'itpl_1' };
    render(<InvoiceTemplateDesignerPage />);

    expect(screen.getByTestId('navigate')).toHaveTextContent('/settings/entities/ent_1/invoice-templates/itpl_1');
    expect(screen.queryByTestId('designer')).not.toBeInTheDocument();
  });

  it("links back to the entity's templates when the template is gone", () => {
    env.template = { data: undefined, isLoading: false, isError: true, error: { status: 404 }, refetch: vi.fn() };
    render(<InvoiceTemplateDesignerPage />);

    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', '/settings/entities/ent_1/invoice-templates');
  });
});
