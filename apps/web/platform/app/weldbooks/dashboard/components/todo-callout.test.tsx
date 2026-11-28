import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { nl } from '@weldsuite/i18n/locales/nl';

const env = vi.hoisted(() => ({
  available: true,
  summary: undefined as { total: number } | undefined,
  locale: 'en' as 'en' | 'nl',
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: env.locale === 'nl' ? dutch : english, language: env.locale }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({
  isTodoAvailable: () => env.available,
  useTodoSummary: () => ({ data: env.summary }),
}));

import { TodoCallout, TO_PROCESS_HREF } from './todo-callout';

beforeEach(() => {
  env.available = true;
  env.summary = { total: 19 };
  env.locale = 'en';
});

describe('TodoCallout', () => {
  it('says how many things are waiting and links to To process', () => {
    render(<TodoCallout />);
    expect(screen.getByText('19 things to process')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to To process' })).toHaveAttribute('href', TO_PROCESS_HREF);
    expect(TO_PROCESS_HREF).toBe('/weldbooks/to-process');
  });

  it('says one thing in the singular', () => {
    env.summary = { total: 1 };
    render(<TodoCallout />);
    expect(screen.getByText('1 thing to process')).toBeInTheDocument();
  });

  it('is not shown when nothing is waiting, or before the counts have loaded', () => {
    env.summary = { total: 0 };
    const { container, rerender } = render(<TodoCallout />);
    expect(container).toBeEmptyDOMElement();
    env.summary = undefined;
    rerender(<TodoCallout />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is not shown on an edition without books-todo, such as Global, whatever the cache holds', () => {
    env.available = false;
    const { container } = render(<TodoCallout />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says it in Dutch', () => {
    env.locale = 'nl';
    render(<TodoCallout />);
    expect(screen.getByText('19 dingen om te verwerken')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: nl.weldbooksConnected.dashboard.calloutAction })).toBeInTheDocument();
  });
});
