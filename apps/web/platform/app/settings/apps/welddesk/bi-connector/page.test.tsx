/**
 * The BI connector page: the feed URL (default and configured) with its copy
 * button, every table with a description, the Power BI and Excel steps, the
 * refresh note and the way to the API keys page.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const state = vi.hoisted(() => ({
  env: undefined as string | undefined,
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/lib/runtime-config', () => ({ publicEnv: () => state.env }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { error: (message: string) => state.toastError(message) } }));

import DeskBiConnectorPage from './page';
import { BI_TABLES, feedUrl } from './bi-tables';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

let written: string[] = [];

beforeEach(() => {
  state.env = undefined;
  state.toastError = vi.fn();
  written = [];
  Object.assign(navigator, {
    clipboard: {
      writeText: (value: string) => {
        written.push(value);
        return Promise.resolve();
      },
    },
  });
});

afterEach(cleanup);

describe('feedUrl', () => {
  it('is the public API plus /v1/odata, from the runtime config when there is one', () => {
    expect(feedUrl()).toBe('https://api.weldsuite.org/v1/odata');
    state.env = 'https://api-test.weldsuite.org/';
    expect(feedUrl()).toBe('https://api-test.weldsuite.org/v1/odata');
  });

  // Only slashes at the very end of the address go, however many there are.
  it.each<[string, string]>([
    ['https://api.x.test', 'https://api.x.test/v1/odata'],
    ['https://api.x.test/', 'https://api.x.test/v1/odata'],
    ['https://api.x.test///', 'https://api.x.test/v1/odata'],
    ['https://api.x.test//base//', 'https://api.x.test//base/v1/odata'],
    ['https://api.x.test/base', 'https://api.x.test/base/v1/odata'],
    ['', '/v1/odata'],
    ['/', '/v1/odata'],
    ['////', '/v1/odata'],
    ['https://api.x.test/ ', 'https://api.x.test/ /v1/odata'],
    ['https://api.x.test/\n/', 'https://api.x.test/\n/v1/odata'],
    ['https://api.x.test/\n', 'https://api.x.test/\n/v1/odata'],
    ['https://api.x.test/é/', 'https://api.x.test/é/v1/odata'],
    [`https://api.x.test${'/'.repeat(5000)}`, 'https://api.x.test/v1/odata'],
    [`${'/'.repeat(5000)}x`, `${'/'.repeat(5000)}x/v1/odata`],
  ])('takes the trailing slashes off %j', (configured, expected) => {
    state.env = configured;
    expect(feedUrl()).toBe(expected);
  });
});

describe('DeskBiConnectorPage', () => {
  it('shows the feed URL and copies it', async () => {
    render(<DeskBiConnectorPage />);
    expect(screen.getByRole('textbox', { name: en.deskBi.feed.label }).textContent).toBe('https://api.weldsuite.org/v1/odata');
    fireEvent.click(screen.getByRole('button', { name: en.deskBi.feed.copy }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.deskBi.feed.copied })).toBeTruthy());
    expect(written).toEqual(['https://api.weldsuite.org/v1/odata']);
  });

  it('says so when the copy fails', async () => {
    Object.assign(navigator, { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    render(<DeskBiConnectorPage />);
    fireEvent.click(screen.getByRole('button', { name: en.deskBi.feed.copy }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith(en.deskBi.feed.copyFailed));
  });

  it('lists every table with its description', () => {
    render(<DeskBiConnectorPage />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(BI_TABLES.length);
    for (const name of BI_TABLES) {
      const row = screen.getByText(name).closest('tr')!;
      expect(within(row).getByText(en.deskBi.tables.items[name])).toBeTruthy();
    }
  });

  it('gives the Power BI and Excel steps and the refresh note', () => {
    render(<DeskBiConnectorPage />);
    expect(screen.getByText(en.deskBi.powerBi.title)).toBeTruthy();
    expect(screen.getByText(en.deskBi.excel.title)).toBeTruthy();
    expect(screen.getByText(en.deskBi.powerBi.steps[0]!)).toBeTruthy();
    expect(screen.getAllByText(en.deskBi.powerBi.steps[2]!).length).toBeGreaterThan(0);
    expect(screen.getByText(en.deskBi.excel.steps[0]!)).toBeTruthy();
    expect(screen.getByText(en.deskBi.refresh.title)).toBeTruthy();
    expect(screen.getByText(en.deskBi.refresh.body)).toBeTruthy();
  });

  it('leads to the API keys page', () => {
    render(<DeskBiConnectorPage />);
    const link = screen.getByRole('link', { name: en.deskBi.key.action });
    expect(link.getAttribute('href')).toBe('/settings/api-keys');
  });
});

describe('translations', () => {
  it('has Dutch for every English string, with the same tables and steps', () => {
    expect(Object.keys(nl.deskBi.tables.items)).toEqual(Object.keys(en.deskBi.tables.items));
    expect(Object.keys(en.deskBi.tables.items)).toEqual([...BI_TABLES]);
    expect(nl.deskBi.powerBi.steps).toHaveLength(en.deskBi.powerBi.steps.length);
    expect(nl.deskBi.excel.steps).toHaveLength(en.deskBi.excel.steps.length);
    const keys = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(nl.deskBi)).toEqual(keys(en.deskBi));
  });
});
