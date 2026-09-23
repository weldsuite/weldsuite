'use client';

import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate } from '@/lib/date';
import type { ClientRequestTicket } from '@/lib/types';
import { Button, Card, Input, Label, PageHeader, Textarea } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

export default function ClientRequestsPage() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<ClientRequestTicket[]>(slug, '/client/requests');

  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ClientRequestTicket | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const ticket = await portalPost<ClientRequestTicket>(slug, '/client/requests', { subject, message });
      setConfirmed(ticket);
      setSubject('');
      setMessage('');
      setShowForm(false);
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : dict.errors.generic);
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return (
      <div className="space-y-6">
        <PageHeader title={dict.client.requests.title} />
        <Card className="text-center py-10 space-y-3">
          <h2 className="text-lg font-semibold text-gray-900">{dict.client.requests.confirmationTitle}</h2>
          <p className="text-sm text-gray-600">{format(dict.client.requests.confirmationBody, { ticketNumber: confirmed.ticketNumber })}</p>
          <Button type="button" variant="secondary" onClick={() => setConfirmed(null)}>
            {dict.client.requests.backToRequests}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.client.requests.title}
        action={
          !showForm && (
            <Button type="button" onClick={() => setShowForm(true)}>
              {dict.client.requests.newRequest}
            </Button>
          )
        }
      />

      {showForm && (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="subject">{dict.client.requests.subject}</Label>
              <Input id="subject" required value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="message">{dict.client.requests.message}</Label>
              <Textarea id="message" rows={5} required value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={submitting || !subject || !message}>
                {dict.client.requests.submit}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                {dict.common.cancel}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.client.requests.history}</h2>
        {loading ? (
          <LoadingState />
        ) : error || !data ? (
          <ErrorState onRetry={refetch} />
        ) : data.length === 0 ? (
          <EmptyState message={dict.client.requests.empty} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.map((ticket) => (
              <li key={ticket.id} className="py-3 flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{ticket.subject}</p>
                  <p className="text-xs text-gray-500">
                    {ticket.ticketNumber} · {formatDate(ticket.createdAt, locale)}
                  </p>
                </div>
                <Badge tone="neutral">{ticket.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
