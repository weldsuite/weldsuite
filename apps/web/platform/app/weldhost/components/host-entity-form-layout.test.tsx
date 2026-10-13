import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { HostEntityFormLayout } from './host-entity-form-layout';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ back: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function renderLayout(overrides?: { hideMobileSummary?: boolean }) {
  return render(
    <HostEntityFormLayout
      title="Register a New Domain"
      subtitle="Search and add domains"
      sections={[
        {
          title: '',
          icon: Globe,
          content: <div>search-results</div>,
        },
      ]}
      summaryTitle="Purchase Summary"
      summaryIcon={Globe}
      summaryFields={[]}
      summaryBottomFields={[{ label: 'Total', value: '$0.00' }]}
      summaryContent={<div>cart-items</div>}
      onSubmit={(event) => event.preventDefault()}
      submitText="Proceed to Payment"
      hideMobileSummary={overrides?.hideMobileSummary ?? true}
    />,
  );
}

describe('HostEntityFormLayout', () => {
  it('keeps the purchase summary inside the content layout instead of covering the viewport', () => {
    renderLayout();

    const layout = screen.getByTestId('host-entity-form-layout');
    const summary = screen.getByTestId('host-purchase-summary');

    expect(layout).toContainElement(summary);
    expect(layout).toHaveClass('h-full', 'flex-1', 'flex', 'overflow-hidden');
    expect(layout).not.toHaveClass('fixed');

    // Previously this panel was `fixed top-0 right-0 h-screen`, which
    // painted over the module header and sidebars.
    expect(summary.tagName).toBe('ASIDE');
    expect(summary.className).not.toMatch(/\bfixed\b/);
    expect(summary.className).not.toMatch(/\bh-screen\b/);
    expect(summary.className).not.toMatch(/\btop-0\b/);
    expect(summary.className).not.toMatch(/\bz-40\b/);
    expect(summary).toHaveClass('h-full', 'shrink-0');

    expect(summary.parentElement).toBe(layout);
    expect(screen.getByRole('heading', { name: 'Purchase Summary' })).toBeInTheDocument();
    expect(screen.getByText('Proceed to Payment')).toBeInTheDocument();
  });

  it('does not reserve overlay margin on the form now that the summary is in-flow', () => {
    const { container } = renderLayout();
    const form = container.querySelector('form');

    expect(form).not.toBeNull();
    expect(form!.className).not.toMatch(/md:mr-\[420px\]/);
  });

  it('docks the summary beside the form only when the layout itself is wide enough', () => {
    // Container queries, not viewport ones: at a ~960px viewport the module
    // sidebar leaves too little room for a 400px side panel next to the form.
    renderLayout({ hideMobileSummary: false });
    const layout = screen.getByTestId('host-entity-form-layout');
    const summary = screen.getByTestId('host-purchase-summary');

    expect(layout).toHaveClass('@container');
    expect(summary).toHaveClass('hidden', '@4xl:flex');
    expect(summary.className).not.toMatch(/(^|\s)md:flex/);
    expect(screen.getAllByRole('heading', { name: 'Purchase Summary' })[0]!.closest('div.\\@4xl\\:hidden')).not.toBeNull();
  });

  it('associates both submit buttons with the form via its unique id', () => {
    const { container } = renderLayout({ hideMobileSummary: false });
    const form = container.querySelector('form');

    expect(form).not.toBeNull();
    expect(form).toHaveAttribute('id');
    const formId = form!.id;
    expect(formId).toBeTruthy();

    const submitButtons = screen.getAllByRole('button', { name: 'Proceed to Payment' });
    expect(submitButtons).toHaveLength(2);
    for (const button of submitButtons) {
      expect(button).toHaveAttribute('type', 'submit');
      expect(button).toHaveAttribute('form', formId);
    }
  });
});
