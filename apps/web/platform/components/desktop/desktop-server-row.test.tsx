import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The server row runs in every installed shell: 0.1.0 and 0.2.0 have no
// `openServerSettings`, so they show the server without the button.
let desktopApi: Record<string, unknown> | null = null;

vi.mock('@/lib/desktop', () => ({
  getDesktop: () => desktopApi,
  isDesktop: () => desktopApi !== null,
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      common: {
        desktop: {
          settings: {
            server: {
              label: 'Server',
              description: 'The app opens WeldSuite from {host}.',
              change: 'Change server…',
            },
          },
        },
      },
    },
    format: (template: string, values: Record<string, string>) =>
      template.replace(/{(\w+)}/g, (match, key: string) => values[key] ?? match),
  }),
}));

import { DesktopServerRow } from './desktop-settings';

const shell = (appUrl: string, extra: Record<string, unknown> = {}) => ({
  isDesktop: true,
  platform: 'win32',
  getAppInfo: vi.fn(async () => ({ platform: 'win32', version: '0.3.0', appUrl, deepLinkScheme: 'weldsuite' })),
  ...extra,
});

describe('DesktopServerRow', () => {
  beforeEach(() => {
    desktopApi = null;
  });

  it('renders nothing outside the desktop app', () => {
    const { container } = render(<DesktopServerRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the server and opens the shell’s window on a 0.3.0 shell', async () => {
    const openServerSettings = vi.fn(async () => true);
    desktopApi = shell('https://app.weldsuite.eu', { openServerSettings });

    render(<DesktopServerRow />);
    expect(await screen.findByText('The app opens WeldSuite from app.weldsuite.eu.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change server…' }));
    expect(openServerSettings).toHaveBeenCalledOnce();
  });

  it('shows the server without the button on an older shell', async () => {
    desktopApi = shell('https://app.weldsuite.org');

    render(<DesktopServerRow />);
    expect(await screen.findByText('The app opens WeldSuite from app.weldsuite.org.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
