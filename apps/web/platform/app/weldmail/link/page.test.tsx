import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { en } from '@weldsuite/i18n/locales/en';
import { buildInterstitialUrl } from '../lib/link-protection';
import LinkInterstitialPage from './page';

const mocks = vi.hoisted(() => ({
  linkCheck: vi.fn(),
  featureAvailable: true,
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ mailMessages: { linkCheck: mocks.linkCheck } }),
}));

vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: () => mocks.featureAvailable,
}));

vi.mock('@/components/edition-unavailable-page', () => ({
  EditionUnavailablePage: () => <p>not on this edition</p>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english }) };
});

const copy = en.mail.linkProtection;
const TARGET = 'https://shop.example.test/deal?id=7';
const originalLocation = window.location;
let replace: ReturnType<typeof vi.fn>;

function openWith(hash: string) {
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, hash, replace, assign: vi.fn() },
  });
}

function fragmentFor(url: string): string {
  return new URL(buildInterstitialUrl('http://localhost', { messageId: 'msg_1', url, text: 'Deal' })).hash;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinkInterstitialPage />
    </QueryClientProvider>,
  );
}

function verdict(value: 'safe' | 'suspicious' | 'malicious', reasons: Array<Record<string, string>> = []) {
  return { data: { url: TARGET, verdict: value, reasons } };
}

beforeEach(() => {
  mocks.linkCheck.mockReset();
  mocks.featureAvailable = true;
  openWith(fragmentFor(TARGET));
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  document.head.querySelectorAll('meta[name="referrer"]').forEach((meta) => meta.remove());
});

describe('LinkInterstitialPage', () => {
  it('checks the link and goes straight on when it is safe, without a referrer', async () => {
    mocks.linkCheck.mockResolvedValue(verdict('safe'));
    renderPage();
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    await waitFor(() => expect(replace).toHaveBeenCalledWith(TARGET));
    expect(mocks.linkCheck).toHaveBeenCalledWith('msg_1', { url: TARGET, text: 'Deal' });
    expect(document.title).toBe(copy.pageTitle);
  });

  it('warns about a suspicious link with its reasons and lets the reader go on', async () => {
    mocks.linkCheck.mockResolvedValue(verdict('suspicious', [{ code: 'ip_host' }, { code: 'homograph' }]));
    renderPage();
    expect(await screen.findByRole('heading', { name: copy.suspiciousTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.suspiciousDescription)).toBeInTheDocument();
    expect(screen.getByText(copy.reasonIpHost)).toBeInTheDocument();
    expect(screen.getByText(copy.reasonHomograph)).toBeInTheDocument();
    expect(screen.getByText('shop.example.test')).toBeInTheDocument();
    expect(screen.getByText(TARGET)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: copy.openAnyway }));
    expect(replace).toHaveBeenCalledWith(TARGET);
  });

  it('blocks a dangerous link, with only a small way through', async () => {
    mocks.linkCheck.mockResolvedValue(verdict('malicious', [{ code: 'threat_feed', threat: 'phishing' }]));
    renderPage();
    expect(await screen.findByRole('heading', { name: copy.maliciousTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.reasonThreatFeedPhishing)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.openAnyway })).toBeNull();
    expect(screen.getByRole('button', { name: copy.goBack })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: copy.openAtOwnRisk }));
    expect(replace).toHaveBeenCalledWith(TARGET);
  });

  it('fails open, visibly, when the check itself fails', async () => {
    mocks.linkCheck.mockRejectedValue(new Error('offline'));
    renderPage();
    expect(await screen.findByRole('heading', { name: copy.unverifiedTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.unverifiedDescription)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: copy.openLink }));
    expect(replace).toHaveBeenCalledWith(TARGET);
  });

  it('goes back instead of opening anything', async () => {
    mocks.linkCheck.mockResolvedValue(verdict('suspicious', [{ code: 'userinfo' }]));
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const length = vi.spyOn(window.history, 'length', 'get').mockReturnValue(2);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: copy.goBack }));
    expect(back).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    back.mockRestore();
    length.mockRestore();
  });

  it('refuses a fragment that is not an http(s) link, and never navigates', async () => {
    openWith('#m=msg_1&u=javascript%3Aalert(1)');
    renderPage();
    expect(screen.getByText(copy.invalidTitle)).toBeInTheDocument();
    expect(mocks.linkCheck).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('is not offered where the edition lacks the feature', () => {
    mocks.featureAvailable = false;
    renderPage();
    expect(screen.getByText('not on this edition')).toBeInTheDocument();
    expect(mocks.linkCheck).not.toHaveBeenCalled();
  });
});
