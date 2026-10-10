import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const post = vi.fn();
// A stable getClient, like the real hook's useCallback.
const client = { post };
const getClient = async () => client;

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient }),
}));

import {
  companyLogoDomain,
  getCachedCompanyLogo,
  logoDomainForCompany,
  logoDomainForLead,
  requestCompanyLogos,
  resetCompanyLogoStore,
  useCompanyLogo,
  useCompanyLogos,
  useRowsWithCompanyLogos,
} from './company-logo';

/** The API answers a URL for the domains in `known`, null for the rest. */
function answerWith(known: Record<string, string>) {
  post.mockImplementation(async (_path: string, body: { domains: string[] }) => ({
    data: { logos: Object.fromEntries(body.domains.map((d) => [d, known[d] ?? null])) },
  }));
}

beforeEach(() => {
  post.mockReset();
  resetCompanyLogoStore();
});

describe('companyLogoDomain', () => {
  it('uses the website, then an explicit domain, then the email domain', () => {
    expect(companyLogoDomain({ website: 'https://www.acme.com/about', email: 'info@other.com' })).toBe('acme.com');
    expect(companyLogoDomain({ website: '', domain: 'beta.io', email: 'info@other.com' })).toBe('beta.io');
    expect(companyLogoDomain({ email: 'info@other.com' })).toBe('other.com');
  });

  it('never turns a mailbox provider, an IP or a local host into a logo domain', () => {
    expect(companyLogoDomain({ email: 'jane@gmail.com' })).toBeUndefined();
    expect(companyLogoDomain({ website: 'http://192.168.1.5', email: 'x@yahoo.com' })).toBeUndefined();
    expect(companyLogoDomain({ website: 'localhost:3000' })).toBeUndefined();
    expect(companyLogoDomain({})).toBeUndefined();
  });

  it('skips records that already have an image of their own', () => {
    expect(logoDomainForCompany({ avatarUrl: 'https://cdn/x.png', website: 'acme.com' })).toBeUndefined();
    expect(logoDomainForCompany({ logoUrl: 'https://cdn/x.png', website: 'acme.com' })).toBeUndefined();
    expect(logoDomainForCompany({ website: 'acme.com' })).toBe('acme.com');
    expect(logoDomainForLead({ avatarUrl: 'https://cdn/p.jpg', domain: 'acme.com' })).toBeUndefined();
    expect(logoDomainForLead({ domain: 'https://www.acme.com/' })).toBe('acme.com');
  });
});

describe('useCompanyLogos', () => {
  it('resolves several domains in one POST to our own API and returns the ones with a logo', async () => {
    answerWith({ 'acme.com': 'https://storage/acme.com' });
    const { result } = renderHook(() => useCompanyLogos(['acme.com', 'https://www.beta.io/', 'acme.com']));

    await waitFor(() => expect(result.current.get('acme.com')).toBe('https://storage/acme.com'));
    expect(result.current.has('beta.io')).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/company-logos/resolve', { domains: ['acme.com', 'beta.io'] });
  });

  it('batches in chunks of 25', async () => {
    answerWith({});
    const domains = Array.from({ length: 60 }, (_, i) => `company${i}.com`);
    renderHook(() => useCompanyLogos(domains));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    const sizes = post.mock.calls.map(([, body]) => (body as { domains: string[] }).domains.length).sort((a, b) => a - b);
    expect(sizes).toEqual([10, 25, 25]);
  });

  it('asks only once per domain, across components and remounts', async () => {
    answerWith({ 'acme.com': 'https://storage/acme.com' });
    const first = renderHook(() => useCompanyLogos(['acme.com']));
    await waitFor(() => expect(first.result.current.size).toBe(1));
    first.unmount();

    const second = renderHook(() => useCompanyLogos(['acme.com']));
    expect(second.result.current.get('acme.com')).toBe('https://storage/acme.com');
    // A domain that has no logo is remembered too.
    answerWith({});
    const third = renderHook(() => useCompanyLogos(['nologo.io']));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    third.unmount();
    renderHook(() => useCompanyLogos(['nologo.io']));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for domains that are not public company domains', async () => {
    answerWith({});
    renderHook(() => useCompanyLogos(['gmail.com', 'localhost', '10.0.0.1', '', null, undefined, 'intranet']));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(post).not.toHaveBeenCalled();
  });

  it('shows no logos, and does not throw, when the API fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    post.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useCompanyLogos(['acme.com']));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.current.size).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('keeps a logo it already has when a later refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      answerWith({ 'acme.com': 'https://storage/acme.com' });
      const { result } = renderHook(() => useCompanyLogos(['acme.com']));
      await waitFor(() => expect(result.current.size).toBe(1));

      // Past the session TTL the domain is asked again; the API is down this time.
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      post.mockRejectedValue(new Error('offline'));
      requestCompanyLogos(['acme.com'], getClient as unknown as Parameters<typeof requestCompanyLogos>[1]);
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(getCachedCompanyLogo('acme.com')).toBe('https://storage/acme.com');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useCompanyLogo', () => {
  it('returns the logo for one website, undefined until known', async () => {
    answerWith({ 'acme.com': 'https://storage/acme.com' });
    const { result } = renderHook(() => useCompanyLogo('https://www.acme.com/contact'));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe('https://storage/acme.com'));
  });

  it('does nothing without a domain', async () => {
    renderHook(() => useCompanyLogo(undefined));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(post).not.toHaveBeenCalled();
  });
});

describe('useRowsWithCompanyLogos', () => {
  interface Row {
    id: string;
    website?: string;
    avatarUrl?: string;
  }
  const getDomain = (row: Row) => logoDomainForCompany(row);

  it('adds logoUrl to the rows whose domain has a logo and leaves the others alone', async () => {
    answerWith({ 'acme.com': 'https://storage/acme.com' });
    const rows: Row[] = [
      { id: '1', website: 'acme.com' },
      { id: '2', website: 'nologo.io' },
      { id: '3' },
      { id: '4', website: 'acme.com', avatarUrl: 'https://cdn/own.png' },
    ];
    const { result } = renderHook(() => useRowsWithCompanyLogos(rows, getDomain));

    // Until a logo arrives the very same array comes back.
    expect(result.current).toBe(rows);

    await waitFor(() => expect(result.current).not.toBe(rows));
    expect(result.current[0]).toEqual({ id: '1', website: 'acme.com', logoUrl: 'https://storage/acme.com' });
    expect(result.current[1]).toBe(rows[1]);
    expect(result.current[2]).toBe(rows[2]);
    // A row with its own image is not looked up and not decorated.
    expect(result.current[3]).toBe(rows[3]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/company-logos/resolve', { domains: ['acme.com', 'nologo.io'] });
  });
});
