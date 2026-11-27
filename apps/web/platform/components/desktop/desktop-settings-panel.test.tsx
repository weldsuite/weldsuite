import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// A Microsoft Store install can't launch at login (Windows keeps an MSIX
// package's login item in its manifest), so the card leaves that switch out
// there; a downloaded install keeps it.
let desktopApi: Record<string, unknown> | null = null;

vi.mock('@/lib/desktop', () => ({
  getDesktop: () => desktopApi,
  isDesktop: () => desktopApi !== null,
}));

vi.mock('@/hooks/use-desktop-settings', () => ({
  useDesktopSettings: () => ({
    settings: {
      autoLaunch: false,
      startMinimized: false,
      closeToTray: true,
      notificationsEnabled: true,
      hardwareAcceleration: true,
    },
    loading: false,
    restartRequired: [],
    update: vi.fn(),
    relaunch: vi.fn(),
  }),
}));

const row = (label: string) => ({ label, description: `${label}.` });

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      common: {
        desktop: {
          settings: {
            title: 'Desktop app',
            description: 'How the desktop app behaves.',
            restartBanner: 'Restart to apply.',
            restartNow: 'Restart now',
            restartRequired: 'restart required',
            loading: 'Loading…',
            server: {
              label: 'Server',
              description: 'The app opens WeldSuite from {host}.',
              change: 'Change server…',
            },
            rows: {
              autoLaunch: row('Launch at system startup'),
              startMinimized: row('Start minimized to tray'),
              closeToTray: row('Close to tray'),
              notificationsEnabled: row('Notifications'),
              hardwareAcceleration: row('Hardware acceleration'),
            },
          },
        },
      },
    },
    format: (template: string, values: Record<string, string>) =>
      template.replace(/{(\w+)}/g, (match, key: string) => values[key] ?? match),
  }),
}));

import { DesktopSettingsPanel } from './desktop-settings';

const shell = (info: Record<string, unknown>) => ({
  isDesktop: true,
  platform: 'win32',
  getAppInfo: vi.fn(async () => ({
    platform: 'win32',
    version: '0.4.0',
    appUrl: 'https://app.weldsuite.eu',
    deepLinkScheme: 'weldsuite',
    ...info,
  })),
});

describe('DesktopSettingsPanel', () => {
  beforeEach(() => {
    desktopApi = null;
  });

  it('offers launch at login in a downloaded install', async () => {
    desktopApi = shell({ windowsStore: false });

    render(<DesktopSettingsPanel />);
    expect(await screen.findByText('The app opens WeldSuite from app.weldsuite.eu.')).toBeInTheDocument();
    expect(screen.getByText('Launch at system startup')).toBeInTheDocument();
    expect(screen.getByText('Start minimized to tray')).toBeInTheDocument();
  });

  it('leaves launch at login out of a Microsoft Store install', async () => {
    desktopApi = shell({ windowsStore: true });

    render(<DesktopSettingsPanel />);
    expect(await screen.findByText('The app opens WeldSuite from app.weldsuite.eu.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Launch at system startup')).not.toBeInTheDocument());
    expect(screen.getByText('Start minimized to tray')).toBeInTheDocument();
  });

  it('keeps every setting on a shell that predates the Store flag', async () => {
    desktopApi = shell({});

    render(<DesktopSettingsPanel />);
    expect(await screen.findByText('The app opens WeldSuite from app.weldsuite.eu.')).toBeInTheDocument();
    expect(screen.getByText('Launch at system startup')).toBeInTheDocument();
  });
});
