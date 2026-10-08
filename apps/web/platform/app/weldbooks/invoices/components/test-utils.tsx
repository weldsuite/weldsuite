/**
 * Helpers for the document tax component tests: render under the real English
 * translations and a fresh query client, stand-ins for the router's links, and
 * Radix Select made usable in jsdom.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { TaxPreviewResult } from '@/lib/api/domains/weldbooks-sales-tax-preview';

export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">{ui}</I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

/** jsdom lacks the pointer-capture APIs Radix Select calls when it opens. */
export function polyfillRadixSelect() {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
}

/** Stand-in for the compat `Link` of `@/lib/router`. */
export function HrefLink({ href, children, ...rest }: Readonly<{ href: string; children?: ReactNode } & Record<string, unknown>>) {
  return (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  );
}

/** Stand-in for TanStack's typed `Link`: `to` with `$param` segments filled in from `params`. */
export function RouteLink({
  to,
  params,
  children,
  ...rest
}: Readonly<{ to: string; params?: Record<string, string>; children?: ReactNode } & Record<string, unknown>>) {
  const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
  return (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  );
}

/** A preview answer, with sensible defaults for the fields a test doesn't care about. */
export function previewResult(overrides: Partial<TaxPreviewResult> = {}): TaxPreviewResult {
  return {
    engine: 'manual',
    engineRef: null,
    calculatedAt: '2026-03-01T00:00:00.000Z',
    warnings: [],
    shipToState: 'TX',
    shipToPostalCode: '78701',
    addressIncomplete: false,
    subtotal: '100.00',
    discountTotal: '0.00',
    taxTotal: '8.25',
    total: '108.25',
    lines: [
      { index: 0, id: 'line_0', lineTotal: '100.00', taxAmount: '8.25', lineTotalWithTax: '108.25', taxRate: '8.25', taxRateId: null, taxCode: 'general' },
    ],
    jurisdictions: [],
    taxBreakdown: [],
    ...overrides,
  };
}
