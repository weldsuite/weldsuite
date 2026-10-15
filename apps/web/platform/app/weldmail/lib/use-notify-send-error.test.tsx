import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { useNotifySendError, WELDREACH_ACCESS_PATH } from './use-notify-send-error';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  canManage: true as boolean | undefined,
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useCanManageApps: () => ({ data: mocks.canManage }),
}));

const FALLBACK = 'Failed to send email';

function notify() {
  return renderHook(() => useNotifySendError()).result.current;
}

type ToastOptions = {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
};

function lastToast(): { title: string; options: ToastOptions } {
  const [title, options] = mocks.toastError.mock.calls.at(-1) as [string, ToastOptions];
  return { title, options };
}

beforeEach(() => {
  mocks.toastError.mockClear();
  mocks.canManage = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNotifySendError', () => {
  it('shows the limit and the reset time for a volume limit, without the WeldReach notice', () => {
    notify()(
      {
        errorCode: 'SENDING_LIMITED',
        errorDetails: { window: 'day', limit: 150, retryAfter: new Date(Date.now() + 5 * 3_600_000).toISOString() },
      },
      FALLBACK,
    );

    const { title, options } = lastToast();
    expect(title).toBe(en.mail.sending.errors.sendingLimited.day);
    expect(options.description).toContain('Limit: 150 recipients per day.');
    expect(options.description).toContain('You can send again in 5 hours.');
    expect(options.description).not.toContain(en.mail.sending.weldreach.notice);
    expect(options.action).toBeUndefined();
  });

  it('explains WeldMail is for one-to-one mail and offers the WeldReach request page', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    notify()({ errorCode: 'FIRST_CONTACT_LIMITED', errorDetails: { window: 'day', limit: 50 } }, FALLBACK);

    const { title, options } = lastToast();
    expect(title).toBe(en.mail.sending.errors.firstContactLimited.default);
    expect(options.description).toContain(en.mail.sending.weldreach.notice);
    expect(options.action?.label).toBe(en.mail.sending.weldreach.action);

    options.action?.onClick();
    expect(open).toHaveBeenCalledWith(WELDREACH_ACCESS_PATH, '_blank', 'noopener');
    expect(WELDREACH_ACCESS_PATH).toBe('/appstore/weldreach');
  });

  it('shows the notice for any limit the guard flags, not only first contact', () => {
    notify()({ errorCode: 'SENDING_LIMITED', errorDetails: { window: 'day', limit: 10, suggestWeldReach: true } }, FALLBACK);
    expect(lastToast().options.description).toContain(en.mail.sending.weldreach.notice);
    expect(lastToast().options.action).toBeDefined();
  });

  it('tells people who cannot open the app store to ask an admin, and offers no link', () => {
    mocks.canManage = false;
    notify()({ errorCode: 'FIRST_CONTACT_LIMITED' }, FALLBACK);

    const { options } = lastToast();
    expect(options.description).toContain(en.mail.sending.weldreach.askAdmin);
    expect(options.action).toBeUndefined();
  });

  it('keeps showing the link while the permission is still loading', () => {
    mocks.canManage = undefined;
    notify()({ errorCode: 'FIRST_CONTACT_LIMITED' }, FALLBACK);
    expect(lastToast().options.action).toBeDefined();
  });

  it('says who got a partially sent message and who did not', () => {
    notify()({ errorCode: 'PARTIALLY_SENT', errorDetails: { sent: ['a@x.com'], failed: ['b@x.com'] } }, FALLBACK);

    const { title, options } = lastToast();
    expect(title).toBe('The message reached a@x.com but not b@x.com.');
    expect(options.description).toBe(en.mail.sending.errors.partiallySentHelp);
  });

  it('falls back to the backend message, then to the call site text', () => {
    notify()({ error: 'Something specific broke' }, FALLBACK);
    expect(lastToast().title).toBe('Something specific broke');

    notify()({}, FALLBACK);
    expect(lastToast().title).toBe(FALLBACK);
    expect(lastToast().options.description).toBeUndefined();
  });
});
