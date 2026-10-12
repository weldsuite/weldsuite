/** Shared setup for the engage component tests: providers, Radix stubs and API fixtures. */

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type {
  ReachCampaignDetail,
  ReachMessage,
  ReachThread,
} from '@weldsuite/app-api-client/schemas/reach';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';

/** Renders `ui` with the query client, English translations and breadcrumbs the pages expect. */
export function renderWithApp(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLanguage="en">
          <BreadcrumbProvider>{ui}</BreadcrumbProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

/** jsdom lacks the pointer APIs Radix selects and menus call. */
export function stubRadixBrowserApis() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
}

export function page<T>(data: T[]) {
  return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } };
}

export function campaignFixture(overrides: Partial<ReachCampaignDetail> = {}): ReachCampaignDetail {
  return {
    id: 'cmp_1',
    name: 'Q4 outreach',
    status: 'draft',
    timezone: 'Europe/Amsterdam',
    sendDays: [1, 2, 3, 4, 5],
    windowStart: '09:00',
    windowEnd: '17:00',
    dailyLimit: 100,
    minGapMinutes: 8,
    stopOnAutoReply: true,
    stats: { prospects: 12, sent: 40, replied: 4, interested: 2, bounced: 1, unsubscribed: 0 },
    pausedReason: null,
    launchedAt: null,
    completedAt: null,
    ownerId: null,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z',
    steps: [
      {
        id: 'stp_1',
        order: 0,
        delayDays: 0,
        delayHours: 0,
        subject: 'Quick question',
        body: 'Hi {{firstName|there}}',
        replyInThread: false,
      },
    ],
    mailboxIds: ['mbx_1'],
    ...overrides,
  };
}

export function messageFixture(id: string, overrides: Partial<ReachMessage> = {}): ReachMessage {
  return {
    id,
    direction: 'in',
    campaignId: 'cmp_1',
    stepId: null,
    mailboxId: 'mbx_1',
    prospectId: 'prs_1',
    threadKey: 'thr_1',
    fromEmail: 'ana@acme.com',
    toEmail: 'sam@outreach.example',
    subject: 'Re: Quick question',
    snippet: null,
    bodyText: 'Sounds interesting, tell me more.',
    status: null,
    kind: 'reply',
    label: 'interested',
    labelSource: 'ai',
    readAt: null,
    handledAt: null,
    sentAt: null,
    receivedAt: '2026-10-12T10:00:00Z',
    ...overrides,
  };
}

export function threadFixture(messages: ReachMessage[], overrides: Partial<ReachThread['summary']> = {}): ReachThread {
  const lastInbound = [...messages].reverse().find((message) => message.direction === 'in') ?? messages[0];
  return {
    threadKey: 'thr_1',
    summary: {
      threadKey: 'thr_1',
      prospect: {
        id: 'prs_1',
        email: 'ana@acme.com',
        firstName: 'Ana',
        lastName: 'Jansen',
        companyName: 'Acme',
        personId: null,
      },
      campaign: { id: 'cmp_1', name: 'Q4 outreach' },
      mailbox: { id: 'mbx_1', email: 'sam@outreach.example' },
      lastInbound: {
        id: lastInbound?.id ?? 'msg_in',
        subject: lastInbound?.subject ?? null,
        snippet: lastInbound?.snippet ?? null,
        kind: lastInbound?.kind ?? 'reply',
        label: lastInbound?.label ?? null,
        labelSource: lastInbound?.labelSource ?? null,
        receivedAt: lastInbound?.receivedAt ?? null,
        readAt: lastInbound?.readAt ?? null,
        handledAt: lastInbound?.handledAt ?? null,
      },
      messageCount: messages.length,
      ...overrides,
    },
    messages,
  };
}
